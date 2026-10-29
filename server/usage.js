// Usage tracking, limits, alerts and admin controls for Trikala. No npm dependencies.
//
// Every /api/generate call is tied to a person (their Firebase user, verified from the ID token the
// app sends) and a session (one browser tab). Gemini's own token counts are recorded per person, per
// session and per day, in Firestore when available and in memory otherwise.
//
// Limits (tokens per UTC day; set as env vars, or change live from the admin page):
//   DAILY_TOKEN_BUDGET   whole app            default 2,000,000
//   USER_DAILY_TOKENS    each signed-in user  default   150,000
//   GUEST_DAILY_TOKENS   requests with no verified user (scripts, broken sign-in)  default 40,000
// Alerts go to Telegram (TELEGRAM_BOT_TOKEN; the admin links their chat by sending /start <ADMIN_KEY>
// to the bot). Each alert has buttons to block that person or pause the whole app.
"use strict";
const crypto = require("crypto");

const env = process.env;
const num = (v, d) => (v !== undefined && v !== "" && isFinite(+v) ? +v : d);
const ADMIN_KEY = env.ADMIN_KEY || "";
const FB_PROJECT = env.FIREBASE_PROJECT_ID || "";
const TG_TOKEN = env.TELEGRAM_BOT_TOKEN || "";
const TG_SECRET = env.TELEGRAM_WEBHOOK_SECRET || (ADMIN_KEY ? crypto.createHash("sha256").update("tg:" + ADMIN_KEY).digest("hex").slice(0, 24) : "");
const SALT = env.USAGE_SALT || ADMIN_KEY || "trikala";
const TG_API = (env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
const PUBLIC_URL = (env.PUBLIC_URL || "").replace(/\/+$/, "");

const DEFAULT_LIMITS = {
  dailyTokens: num(env.DAILY_TOKEN_BUDGET, 2000000),
  userDailyTokens: num(env.USER_DAILY_TOKENS, 150000),
  guestDailyTokens: num(env.GUEST_DAILY_TOKENS, 40000),
  burstCalls: num(env.ALERT_BURST_CALLS, 25),          // calls by one person in 10 minutes that trigger an alert
  dailyBudgetUsd: num(env.DAILY_BUDGET_USD, 0),        // optional: also stop at this estimated spend (0 = off)
};

// Estimated prices in USD per million tokens [input, output]. Output includes thinking tokens.
// These are estimates for the dashboard only; your Google Cloud bill is the source of truth.
// Override with PRICES='{"gemini-3.8-flash":[0.3,2.5]}'.
let PRICES = { flash: [0.30, 2.50], "flash-lite": [0.10, 0.40], pro: [1.25, 10.0] };
try { if (env.PRICES) PRICES = Object.assign(PRICES, JSON.parse(env.PRICES)); } catch (e) {}
function priceFor(model) {
  if (PRICES[model]) return PRICES[model];
  if (/flash-lite/.test(model)) return PRICES["flash-lite"];
  if (/pro/.test(model)) return PRICES.pro;
  return PRICES.flash;
}
function costOf(model, tin, tout) { const [a, b] = priceFor(model); return (tin * a + tout * b) / 1e6; }

const today = () => new Date().toISOString().slice(0, 10);
const hash = s => crypto.createHash("sha256").update(SALT + "|" + s).digest("hex").slice(0, 12);

function device(ua) {
  ua = String(ua || "");
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : /curl|python|node|axios|Go-http|wget/i.test(ua) ? "Script" : "Other";
  const br = /CriOS|Chrome\//.test(ua) && !/Edg/.test(ua) ? "Chrome" : /Edg/.test(ua) ? "Edge" : /FxiOS|Firefox/.test(ua) ? "Firefox"
    : /Safari/.test(ua) ? "Safari" : /curl|python|node|axios|wget/i.test(ua) ? (ua.split("/")[0] || "script") : "";
  return br ? os + " · " + br : os;
}

/* ---------- Firebase ID tokens (RS256, Google's public certs) ---------- */
let certs = { at: 0, keys: {} };
const verified = new Map();   // token -> claims
async function googleCerts() {
  if (Date.now() - certs.at < 3600e3 && Object.keys(certs.keys).length) return certs.keys;
  const r = await fetch(env.FIREBASE_CERTS_URL || "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com");
  if (!r.ok) throw new Error("certs " + r.status);
  certs = { at: Date.now(), keys: await r.json() };
  return certs.keys;
}
const b64 = s => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
async function verifyIdToken(tok) {
  if (!tok || !FB_PROJECT || tok.length > 4096) return null;
  const hit = verified.get(tok);
  if (hit) return hit.exp * 1000 > Date.now() ? hit : (verified.delete(tok), null);
  const parts = tok.split(".");
  if (parts.length !== 3) return null;
  let head, claims;
  try { head = JSON.parse(b64(parts[0])); claims = JSON.parse(b64(parts[1])); } catch (e) { return null; }
  if (head.alg !== "RS256") return null;
  const keys = await googleCerts().catch(() => ({}));
  const cert = keys[head.kid];
  if (!cert) return null;
  const ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), cert, b64(parts[2]));
  const now = Date.now() / 1000;
  if (!ok || claims.aud !== FB_PROJECT || claims.iss !== "https://securetoken.google.com/" + FB_PROJECT
      || !(claims.exp > now) || !(claims.iat < now + 300) || !claims.sub) return null;
  if (verified.size > 5000) verified.clear();
  verified.set(tok, claims);
  return claims;
}

/* ---------- Firestore REST (service account) ---------- */
let tokenFn = null, projectFn = null, store = "memory";
const FS = () => `https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents`;
let PROJ = "";
function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
}
function fromFs(v) {
  if (!v) return null;
  if ("integerValue" in v) return +v.integerValue;
  if ("doubleValue" in v) return +v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFs);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)]));
  return null;
}
const docFields = d => (d && d.fields ? fromFs({ mapValue: { fields: d.fields } }) : null);
const fp = k => k.split(".").map(s => (/^[A-Za-z_][A-Za-z_0-9]*$/.test(s) ? s : "`" + s.replace(/`/g, "") + "`")).join(".");
async function fsCall(method, url, body) {
  const r = await fetch(url, { method, headers: { Authorization: "Bearer " + (await tokenFn()), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("firestore " + r.status + " " + t.slice(0, 200));
  return t ? JSON.parse(t) : {};
}
// One write: set plain fields, add to counters.
function write(docPath, set, inc, extraTransforms) {
  const name = `projects/${PROJ}/databases/(default)/documents/${docPath}`;
  const keys = Object.keys(set || {});
  const nested = {};
  for (const k of keys) { const segs = k.split("."); let o = nested; segs.slice(0, -1).forEach(s => (o = o[s] = o[s] || {})); o[segs[segs.length - 1]] = set[k]; }
  return {
    update: { name, fields: toFs(nested).mapValue.fields },
    updateMask: { fieldPaths: keys.map(fp) },
    updateTransforms: Object.entries(inc || {}).map(([k, n]) => ({ fieldPath: fp(k), increment: Number.isInteger(n) ? { integerValue: String(n) } : { doubleValue: n } }))
      .concat(extraTransforms || []),
  };
}
async function commit(writes) {
  if (store !== "firestore" || !writes.length) return;
  await fsCall("POST", FS() + ":commit", { writes });
}

/* ---------- state ---------- */
const mem = {
  controls: { paused: false, blockedUsers: [], blockedSessions: [], limits: { ...DEFAULT_LIMITS }, tgChat: env.TELEGRAM_CHAT_ID || "" },
  day: "", dayTotal: { tokens: 0, cost: 0, calls: 0 }, alertsSent: new Set(),
  users: new Map(),       // uid -> { label, kind, device, first, last, calls, tokensIn, tokensOut, cost, days: {d:{tokens,calls,cost}} }
  sessions: new Map(),    // sid -> { uid, device, first, last, calls, tokens, cost }
  burst: new Map(),       // uid -> [timestamps]
  days: new Map(),        // d -> { tokens, cost, calls, models: {} }
  alerts: [],             // recent alerts
};
let controlsAt = 0;

async function loadControls(force) {
  if (store !== "firestore" || (!force && Date.now() - controlsAt < 15000)) return mem.controls;
  controlsAt = Date.now();
  try {
    const d = docFields(await fsCall("GET", FS() + "/tk_admin/controls"));
    if (d) {
      mem.controls = Object.assign(mem.controls, d);
      mem.controls.limits = Object.assign({ ...DEFAULT_LIMITS }, d.limits || {});
      if (!mem.controls.tgChat && env.TELEGRAM_CHAT_ID) mem.controls.tgChat = env.TELEGRAM_CHAT_ID;
    }
  } catch (e) { console.error(JSON.stringify({ evt: "usage_controls_error", msg: String(e.message).slice(0, 200) })); }
  return mem.controls;
}
async function saveControls() {
  const c = mem.controls;
  await commit([write("tk_admin/controls", { paused: !!c.paused, blockedUsers: c.blockedUsers || [], blockedSessions: c.blockedSessions || [],
    limits: c.limits, tgChat: String(c.tgChat || ""), updated: new Date().toISOString() })]).catch(e => console.error("controls save", e.message));
}

async function rollDay() {
  const d = today();
  if (mem.day === d) return;
  mem.day = d; mem.dayTotal = { tokens: 0, cost: 0, calls: 0 }; mem.alertsSent = new Set();
  if (store === "firestore") {
    try {
      const doc = docFields(await fsCall("GET", FS() + "/tk_usage_days/" + d));
      if (doc) { mem.dayTotal = { tokens: doc.tokens || 0, cost: doc.cost || 0, calls: doc.calls || 0 }; (doc.alertsSent || []).forEach(a => mem.alertsSent.add(a)); }
    } catch (e) {}
  }
}

async function userToday(uid) {
  const d = today();
  let u = mem.users.get(uid);
  if (!u && store === "firestore") {
    try {
      const doc = docFields(await fsCall("GET", FS() + "/tk_usage_users/" + encodeURIComponent(uid)));
      if (doc) { u = { ...doc, days: { [d]: (doc.days || {})[d] || { tokens: 0, calls: 0, cost: 0 } } }; mem.users.set(uid, u); }
    } catch (e) {}
  }
  return (u && u.days && u.days[d]) || { tokens: 0, calls: 0, cost: 0 };
}

/* ---------- who is calling ---------- */
async function identify(req, ip) {
  const tok = String(req.headers["x-trikala-token"] || "");
  const sid = String(req.headers["x-trikala-session"] || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  const claims = await verifyIdToken(tok).catch(() => null);
  const dev = device(req.headers["user-agent"]);
  if (claims) {
    const email = claims.email || "";
    const anon = (claims.firebase && claims.firebase.sign_in_provider) === "anonymous";
    return { uid: claims.sub, kind: anon ? "guest" : "account", label: email || (anon ? "Anonymous " : "User ") + claims.sub.slice(0, 6), sid: sid || "u-" + claims.sub.slice(0, 10), device: dev, ip: hash(ip) };
  }
  // No verified user: group by network address (hashed, never stored raw).
  const h = hash(ip);
  return { uid: "unverified-" + h, kind: "unverified", label: "Unverified · " + h.slice(0, 6), sid: sid || "ip-" + h, device: dev, ip: h };
}

/* ---------- checks before a call ---------- */
async function check(who) {
  await rollDay();
  const c = await loadControls();
  const L = c.limits || DEFAULT_LIMITS;
  if (c.paused) return { code: "paused", status: 503, msg: "Trikala is paused for now. Try again later." };
  if ((c.blockedUsers || []).includes(who.uid)) return { code: "blocked", status: 403, msg: "This account can't use Trikala right now." };
  if ((c.blockedSessions || []).includes(who.sid)) return { code: "blocked", status: 403, msg: "This session was closed. Reload the page to start again." };
  if (L.dailyTokens && mem.dayTotal.tokens >= L.dailyTokens) return { code: "budget", status: 429, msg: "Trikala has reached today's limit. It resets at 5:30 AM IST." };
  if (L.dailyBudgetUsd && mem.dayTotal.cost >= L.dailyBudgetUsd) return { code: "budget", status: 429, msg: "Trikala has reached today's limit. It resets at 5:30 AM IST." };
  const mine = await userToday(who.uid);
  const cap = who.kind === "unverified" ? L.guestDailyTokens : L.userDailyTokens;
  if (cap && mine.tokens >= cap) return { code: "user_limit", status: 429, msg: "You've reached today's limit. It resets at 5:30 AM IST." };
  return null;
}

/* ---------- recording after a call ---------- */
async function record(who, out, tier, ms) {
  const u = out.usage || {};
  const tin = u.promptTokenCount || 0;
  const tout = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
  const tokens = u.totalTokenCount || tin + tout;
  const cost = costOf(out.model, tin, tout);
  const d = today(), now = new Date().toISOString();
  await rollDay();
  mem.dayTotal.tokens += tokens; mem.dayTotal.cost += cost; mem.dayTotal.calls++;
  const day = mem.days.get(d) || { tokens: 0, cost: 0, calls: 0, models: {} }; mem.days.set(d, day);
  day.tokens += tokens; day.cost += cost; day.calls++;
  const m = day.models[out.model] = day.models[out.model] || { tokens: 0, calls: 0, cost: 0 }; m.tokens += tokens; m.calls++; m.cost += cost;

  const user = mem.users.get(who.uid) || { uid: who.uid, label: who.label, kind: who.kind, first: now, calls: 0, tokensIn: 0, tokensOut: 0, cost: 0, days: {} };
  Object.assign(user, { label: who.label, kind: who.kind, device: who.device, last: now, lastSession: who.sid });
  user.calls++; user.tokensIn += tin; user.tokensOut += tout; user.cost += cost;
  const ud = user.days[d] = user.days[d] || { tokens: 0, calls: 0, cost: 0 }; ud.tokens += tokens; ud.calls++; ud.cost += cost;
  mem.users.set(who.uid, user);
  const s = mem.sessions.get(who.sid) || { sid: who.sid, uid: who.uid, label: who.label, device: who.device, first: now, calls: 0, tokens: 0, cost: 0 };
  Object.assign(s, { last: now, label: who.label }); s.calls++; s.tokens += tokens; s.cost += cost; mem.sessions.set(who.sid, s);
  if (mem.sessions.size > 3000) { const old = [...mem.sessions.keys()].slice(0, 1000); old.forEach(k => mem.sessions.delete(k)); }

  const mk = "models." + out.model.replace(/[^A-Za-z0-9_-]/g, "_");
  commit([
    write("tk_usage_days/" + d, { day: d, updated: now }, { tokens, calls: 1, cost, tokensIn: tin, tokensOut: tout, [mk + ".tokens"]: tokens, [mk + ".calls"]: 1, [mk + ".cost"]: cost }),
    write("tk_usage_users/" + encodeURIComponent(who.uid), { uid: who.uid, label: who.label, kind: who.kind, device: who.device, last: now, lastSession: who.sid, ip: who.ip },
      { calls: 1, tokensIn: tin, tokensOut: tout, cost, ["days." + d + ".tokens"]: tokens, ["days." + d + ".calls"]: 1, ["days." + d + ".cost"]: cost },
      [{ fieldPath: "firstMs", minimum: { integerValue: String(Date.now()) } }]),
    write("tk_usage_sessions/" + who.sid, { sid: who.sid, uid: who.uid, label: who.label, device: who.device, last: now, day: d },
      { calls: 1, tokens, cost }),
  ]).catch(e => console.error(JSON.stringify({ evt: "usage_write_error", msg: String(e.message).slice(0, 200) })));
  console.log(JSON.stringify({ evt: "usage", uid: who.uid, kind: who.kind, sid: who.sid, model: out.model, tier, tin, tout, cost: +cost.toFixed(6), ms }));

  // burst: many calls from one person in 10 minutes
  const b = (mem.burst.get(who.uid) || []).filter(t => Date.now() - t < 600e3); b.push(Date.now()); mem.burst.set(who.uid, b);
  await alerts(who, ud, b.length);
}

/* ---------- alerts ---------- */
async function alerts(who, ud, burstCount) {
  const L = mem.controls.limits || DEFAULT_LIMITS;
  const t = mem.dayTotal.tokens, pct = L.dailyTokens ? t / L.dailyTokens : 0;
  for (const level of [0.5, 0.8, 1]) {
    const key = "budget-" + level;
    if (pct >= level && !mem.alertsSent.has(key)) {
      await raise(key, `${level >= 1 ? "🛑" : "⚠️"} Trikala has used ${Math.round(pct * 100)}% of today's token budget`,
        `${fmt(t)} of ${fmt(L.dailyTokens)} tokens · about $${mem.dayTotal.cost.toFixed(2)} · ${mem.dayTotal.calls} AI calls today.` +
        (level >= 1 ? "\nNew AI requests are now refused until 5:30 AM IST." : ""), null);
    }
  }
  const cap = who.kind === "unverified" ? L.guestDailyTokens : L.userDailyTokens;
  if (cap && ud.tokens >= cap * 0.6 && !mem.alertsSent.has("user-" + who.uid)) {
    await raise("user-" + who.uid, "⚠️ One person is using a lot today",
      `${who.label} (${who.device}) has used ${fmt(ud.tokens)} tokens in ${ud.calls} calls today, ${Math.round(ud.tokens / cap * 100)}% of their daily limit.`, who);
  }
  if (L.burstCalls && burstCount >= L.burstCalls && !mem.alertsSent.has("burst-" + who.uid + "-" + Math.floor(Date.now() / 3600e3))) {
    await raise("burst-" + who.uid + "-" + Math.floor(Date.now() / 3600e3), "🚨 Unusual burst of requests",
      `${who.label} (${who.device}) made ${burstCount} AI calls in the last 10 minutes.`, who);
  }
}
const fmt = n => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n)));

async function raise(key, title, body, who) {
  mem.alertsSent.add(key);
  const a = { at: new Date().toISOString(), title, body, uid: who ? who.uid : "", sid: who ? who.sid : "" };
  mem.alerts.unshift(a); mem.alerts.length = Math.min(mem.alerts.length, 50);
  console.warn(JSON.stringify({ evt: "usage_alert", key, title, body }));
  commit([
    write("tk_usage_days/" + today(), {}, {}, [{ fieldPath: "alertsSent", appendMissingElements: { values: [{ stringValue: key }] } }]),
    write("tk_usage_alerts/" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex"), a, {}),
  ]).catch(() => {});
  await telegram(title + "\n" + body, who);
}

async function telegram(text, who, chat) {
  chat = chat || mem.controls.tgChat;
  if (!TG_TOKEN || !chat) return false;
  const kb = [];
  if (who) kb.push([{ text: "Block this person", callback_data: "block:" + who.uid.slice(0, 50) }, { text: "Close session", callback_data: "sess:" + who.sid.slice(0, 50) }]);
  kb.push([{ text: mem.controls.paused ? "Resume app" : "Pause whole app", callback_data: mem.controls.paused ? "resume" : "pause" }]);
  if (PUBLIC_URL) kb.push([{ text: "Open dashboard", url: PUBLIC_URL + "/admin" }]);
  try {
    const r = await fetch(`${TG_API}/bot${TG_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, reply_markup: { inline_keyboard: kb } }) });
    return r.ok;
  } catch (e) { console.error("telegram", e.message); return false; }
}

/* ---------- admin actions ---------- */
async function act(action, arg) {
  await loadControls(true);
  const c = mem.controls;
  const add = (k, v) => { c[k] = [...new Set([...(c[k] || []), v])].slice(-500); };
  const del = (k, v) => { c[k] = (c[k] || []).filter(x => x !== v); };
  if (action === "block" && arg) add("blockedUsers", arg);
  else if (action === "unblock" && arg) del("blockedUsers", arg);
  else if (action === "closeSession" && arg) add("blockedSessions", arg);
  else if (action === "reopenSession" && arg) del("blockedSessions", arg);
  else if (action === "pause") c.paused = true;
  else if (action === "resume") c.paused = false;
  else if (action === "limits" && arg && typeof arg === "object") {
    c.limits = Object.assign({ ...DEFAULT_LIMITS }, c.limits);
    for (const k of Object.keys(DEFAULT_LIMITS)) if (arg[k] !== undefined && isFinite(+arg[k]) && +arg[k] >= 0) c.limits[k] = +arg[k];
  } else return false;
  await saveControls();
  return true;
}

/* ---------- dashboard data ---------- */
async function summary() {
  await rollDay(); await loadControls(true);
  const d = today();
  let users = [...mem.users.values()], sessions = [...mem.sessions.values()], days = [], alertsList = mem.alerts;
  if (store === "firestore") {
    try {
      const list = async (col, order, n) => ((await fsCall("GET", `${FS()}/${col}?pageSize=${n}&orderBy=${encodeURIComponent(order)}`)) || {}).documents || [];
      users = (await list("tk_usage_users", "last desc", 300)).map(docFields);
      sessions = (await list("tk_usage_sessions", "last desc", 100)).map(docFields);
      alertsList = (await list("tk_usage_alerts", "at desc", 30)).map(docFields);
      const ids = [...Array(14)].map((_, i) => new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
      const got = await fsCall("POST", FS() + ":batchGet", { documents: ids.map(x => `projects/${PROJ}/databases/(default)/documents/tk_usage_days/${x}`) });
      days = (got || []).filter(g => g.found).map(g => docFields(g.found));
    } catch (e) { console.error("summary", e.message); }
  } else {
    days = [...mem.days.entries()].map(([day, v]) => ({ day, ...v }));
  }
  const now = Date.now();
  const c = mem.controls;
  return {
    today: d, store, telegram: { configured: !!TG_TOKEN, linked: !!c.tgChat },
    totals: mem.dayTotal, limits: c.limits, paused: !!c.paused,
    blockedUsers: c.blockedUsers || [], blockedSessions: c.blockedSessions || [],
    days: days.sort((a, b) => (a.day < b.day ? 1 : -1)),
    users: users.filter(Boolean).map(u => ({ uid: u.uid, label: u.label, kind: u.kind, device: u.device, first: u.firstMs ? new Date(u.firstMs).toISOString() : u.first, last: u.last, lastSession: u.lastSession,
      calls: u.calls || 0, tokens: (u.tokensIn || 0) + (u.tokensOut || 0), cost: u.cost || 0, today: (u.days || {})[d] || { tokens: 0, calls: 0, cost: 0 },
      blocked: (c.blockedUsers || []).includes(u.uid) })),
    sessions: sessions.filter(Boolean).filter(s => now - Date.parse(s.last) < 24 * 3600e3)
      .map(s => ({ ...s, active: now - Date.parse(s.last) < 15 * 60e3, closed: (c.blockedSessions || []).includes(s.sid) })),
    alerts: alertsList.filter(Boolean),
    prices: PRICES,
  };
}

/* ---------- Telegram webhook ---------- */
async function onTelegram(update) {
  const msg = update.message, cb = update.callback_query;
  if (msg && msg.text) {
    const chat = String(msg.chat.id);
    const [cmd, arg] = msg.text.trim().split(/\s+/);
    if (cmd === "/start") {
      if (ADMIN_KEY && arg === ADMIN_KEY) {
        await loadControls(true); mem.controls.tgChat = chat; await saveControls();
        await telegram("✅ Linked. You'll get Trikala usage alerts here, with buttons to block people or pause the app.\nSend /status any time.", null, chat);
      } else await telegram("To link alerts, send: /start YOUR_ADMIN_KEY", null, chat);
      return;
    }
    if (chat !== String(mem.controls.tgChat)) return;
    if (cmd === "/status") {
      await rollDay(); const L = mem.controls.limits;
      await telegram(`📊 Today: ${fmt(mem.dayTotal.tokens)} of ${fmt(L.dailyTokens)} tokens (${Math.round(mem.dayTotal.tokens / L.dailyTokens * 100)}%) · about $${mem.dayTotal.cost.toFixed(2)} · ${mem.dayTotal.calls} calls.\nApp is ${mem.controls.paused ? "PAUSED" : "running"}.`, null);
    } else if (cmd === "/pause") { await act("pause"); await telegram("⏸ Paused. New AI requests are refused.", null); }
    else if (cmd === "/resume") { await act("resume"); await telegram("▶️ Resumed.", null); }
    return;
  }
  if (cb && String(cb.message && cb.message.chat.id) === String(mem.controls.tgChat)) {
    const [what, arg] = String(cb.data || "").split(":");
    let reply = "";
    if (what === "block") { await act("block", arg); reply = "Blocked. Their next request will be refused."; }
    else if (what === "sess") { await act("closeSession", arg); reply = "Session closed."; }
    else if (what === "pause") { await act("pause"); reply = "Whole app paused."; }
    else if (what === "resume") { await act("resume"); reply = "App resumed."; }
    try {
      await fetch(`${TG_API}/bot${TG_TOKEN}/answerCallbackQuery`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: cb.id, text: reply }) });
      if (reply) await telegram("✔️ " + reply, null);
    } catch (e) {}
  }
}

function adminOk(req) {
  const k = String(req.headers["x-admin-key"] || "");
  return !!ADMIN_KEY && k.length === ADMIN_KEY.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY));
}

async function init(getToken, getProject) {
  tokenFn = getToken; projectFn = getProject;
  const want = env.USAGE_STORE || "firestore";
  if (want !== "firestore") return;
  try {
    PROJ = await projectFn();
    await tokenFn();
    if (!PROJ) throw new Error("no project");
    store = "firestore";
    await loadControls(true);
    await rollDay();
    console.log(JSON.stringify({ evt: "usage_store", store, project: PROJ }));
  } catch (e) {
    store = "memory";
    console.warn(JSON.stringify({ evt: "usage_store", store, why: String(e.message || e).slice(0, 120) }));
  }
}

module.exports = { init, identify, check, record, summary, act, onTelegram, adminOk, TG_SECRET, telegram, device, verifyIdToken, costOf };

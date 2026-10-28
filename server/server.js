// Trikala on Google Cloud — one Cloud Run service, no npm dependencies.
//   GET  /               the app (public/index.html with the Google runtime injected)
//   GET  /runtime.js     Gemini + Firebase Auth + Firestore runtime for the app
//   GET  /api/config     public Firebase web config
//   POST /api/generate   { prompt, tier } -> { text }   (Gemini, JSON mode)
//   GET  /healthz
//
// Gemini access, in order of preference:
//   GEMINI_API_KEY set  -> Gemini API (AI Studio key)
//   otherwise           -> Vertex AI with the Cloud Run service account (no key needed)
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = +process.env.PORT || 8080;
const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");

const MODELS = {
  default: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  quick: process.env.GEMINI_MODEL_QUICK || "gemini-3.5-flash-lite",
};
const FALLBACKS = {
  default: (process.env.GEMINI_FALLBACKS || "gemini-3.6-flash,gemini-2.5-flash,gemini-3.5-flash-lite").split(",").map(x => x.trim()).filter(Boolean),
  quick: (process.env.GEMINI_FALLBACKS_QUICK || "gemini-3.1-flash-lite,gemini-2.5-flash-lite").split(",").map(x => x.trim()).filter(Boolean),
};
const working = {};   // tier -> model that last succeeded, tried first
const API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
const VERTEX_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || "global";
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "";

const LIMIT_PER_IP = +process.env.RATE_LIMIT_PER_IP || 40;      // requests per window per IP
const LIMIT_WINDOW_MS = +process.env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000;
const DAILY_CAP = +process.env.DAILY_CAP || 3000;               // whole service, per UTC day
const MAX_PROMPT = 150000;                                      // characters

/* ---------- the page: inject the runtime and use neutral wording ---------- */
function buildIndex() {
  let html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const swaps = [
    ["Continue with my Claude account", "Save to my Trikala account"],
    ["Your claude.ai session expired. Sign in again, then try again.", "Your session expired. Reload the page, then try again."],
    ["Trikala needs permission to use Claude. Allow it when asked, then try again.", "Trikala couldn't reach Gemini. Reload the page, then try again."],
    ["Open the app from its own page, or wait a few seconds and try again.", "Wait a few seconds and try again."],
    ["Open the app from its own page and try again.", "Try again in a moment."],
    ["Open the app from its own page and I'll pull your signals together.", "Try again in a moment."],
    ["isn't connected in this view yet.", "isn't connected yet."],
    [" from this view", " right now"],
    [" in this view", " right now"],
    ["Claude", "Gemini"],
  ];
  for (const [a, b] of swaps) html = html.split(a).join(b);
  html = html.replace(/<head>/i, '<head>\n<script src="/runtime.js"></script>');
  return html;
}
let INDEX = buildIndex();
const INDEX_ETAG = '"' + crypto.createHash("sha1").update(INDEX).digest("hex").slice(0, 16) + '"';

/* ---------- small helpers ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webp": "image/webp" };
const SECURITY = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" };

function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({ "Content-Type": type || "application/json" }, SECURITY, extra || {}));
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > max) { reject({ status: 413 }); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function clientIp(req) {
  const f = req.headers["x-forwarded-for"];
  return (f ? String(f).split(",")[0] : req.socket.remoteAddress || "").trim();
}

/* ---------- rate limiting (per instance; keep max-instances low) ---------- */
const hits = new Map();
let day = "", dayCount = 0;
function allow(ip) {
  const now = Date.now(), today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; dayCount = 0; }
  if (dayCount >= DAILY_CAP) return "daily";
  const h = (hits.get(ip) || []).filter(t => now - t < LIMIT_WINDOW_MS);
  if (h.length >= LIMIT_PER_IP) { hits.set(ip, h); return "ip"; }
  h.push(now); hits.set(ip, h); dayCount++;
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > LIMIT_WINDOW_MS) hits.delete(k);
  return "";
}

/* ---------- Gemini ---------- */
let tokenCache = { token: "", exp: 0 };
async function vertexToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } });
  if (!r.ok) throw new Error("metadata token " + r.status);
  const j = await r.json();
  tokenCache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return tokenCache.token;
}
async function projectId() {
  if (PROJECT) return PROJECT;
  const r = await fetch("http://metadata.google.internal/computeMetadata/v1/project/project-id", { headers: { "Metadata-Flavor": "Google" } });
  return r.ok ? (await r.text()).trim() : "";
}

// Model choice adapts to what is actually fast on this project: a model that times out or answers
// slowly is benched for a while and the next one in the chain is used instead.
const PER_CALL_MS = { quick: +process.env.QUICK_TIMEOUT_MS || 9000, default: +process.env.DEFAULT_TIMEOUT_MS || 45000 };
const SLOW_MS = { quick: 6000, default: 30000 };
const benched = new Map();          // model -> until (ms)
const RECENT = [];
const CLIENT = [];                  // recent browser errors, for /api/health                  // last calls, for /api/health
function note(o) { RECENT.unshift(Object.assign({ at: new Date().toISOString().slice(11, 19) }, o)); RECENT.length = Math.min(RECENT.length, 30); }

async function gemini(prompt, tier, signal) {
  const now = Date.now();
  const all = [...new Set([working[tier], MODELS[tier] || MODELS.default, ...(FALLBACKS[tier] || [])].filter(Boolean))];
  const fresh = all.filter(m => !(benched.get(m) > now));
  const chain = fresh.length ? fresh : all;
  const started = Date.now();
  let last;
  for (const model of chain) {
    if (signal && signal.aborted) break;
    if (Date.now() - started > (tier === "quick" ? 10000 : 95000)) break;   // quick steps: one retry at most; others stay inside Cloud Run's timeout
    const t0 = Date.now();
    try {
      const out = await callModel(model, prompt, signal, Math.min(PER_CALL_MS[tier] || 45000, 110000 - (Date.now() - started)));
      const ms = Date.now() - t0;
      note({ tier, model, ms, in: prompt.length, out: out.text.length, finish: out.finish, ok: true });
      if (ms > (SLOW_MS[tier] || 30000)) { benched.set(model, Date.now() + 20 * 60000); if (working[tier] === model) delete working[tier]; }
      else working[tier] = model;
      return out;
    } catch (e) {
      last = e;
      note({ tier, model, ms: Date.now() - t0, in: prompt.length, ok: false, code: e.code, err: String(e.message || e).slice(0, 120) });
      if (e.code === "refused" || (signal && signal.aborted)) throw e;
      console.error(JSON.stringify({ evt: "model_fallback", model, code: e.code, msg: String(e.message || e).slice(0, 300) }));
      benched.set(model, Date.now() + (e.status === 504 ? 20 : 5) * 60000);
      if (working[tier] === model) delete working[tier];
    }
  }
  throw last || Object.assign(new Error("no model"), { code: "upstream_error", status: 502 });
}

async function callModel(model, prompt, outerSignal, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs || 75000);
  const onAbort = () => ac.abort();
  if (outerSignal) outerSignal.addEventListener("abort", onAbort);
  try { return await callModelOnce(model, prompt, ac.signal); }
  catch (e) { if (ac.signal.aborted && !(outerSignal && outerSignal.aborted)) { e = new Error("timeout " + model); e.code = "upstream_error"; e.status = 504; } throw e; }
  finally { clearTimeout(t); if (outerSignal) outerSignal.removeEventListener("abort", onAbort); }
}

// Thinking makes answers slower; Trikala's prompts are structured enough that low effort is fine.
const THINKING = process.env.GEMINI_THINKING || "low";      // gemini-3.x: minimal | low | medium | high | off
const noThinking = new Set();                               // models that rejected the setting
function thinkingFor(model) {
  if (THINKING === "off" || noThinking.has(model)) return null;
  if (/^gemini-3/.test(model)) return { thinkingLevel: THINKING };
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  return null;
}

async function callModelOnce(model, prompt, signal) {
  try { return await callModelRaw(model, prompt, signal, thinkingFor(model)); }
  catch (e) {
    if (e.status === 400 && thinkingFor(model) && /thinking/i.test(e.message)) {
      noThinking.add(model);
      return await callModelRaw(model, prompt, signal, null);
    }
    throw e;
  }
}

async function callModelRaw(model, prompt, signal, thinking) {
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: Object.assign({ responseMimeType: "application/json", temperature: 0.4, maxOutputTokens: +process.env.MAX_OUTPUT_TOKENS || 8192 },
      thinking ? { thinkingConfig: thinking } : {}),
  });
  let url, headers = { "Content-Type": "application/json" };
  if (API_KEY) {
    url = `${GEMINI_BASE}/models/${model}:generateContent`;
    headers["x-goog-api-key"] = API_KEY;
  } else {
    const p = await projectId();
    const host = VERTEX_LOCATION === "global" ? "aiplatform.googleapis.com" : `${VERTEX_LOCATION}-aiplatform.googleapis.com`;
    url = `https://${host}/v1/projects/${p}/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:generateContent`;
    headers.Authorization = "Bearer " + (await vertexToken());
  }
  const r = await fetch(url, { method: "POST", headers, body, signal });
  const raw = await r.text();
  let j = null; try { j = JSON.parse(raw); } catch (e) {}
  if (!r.ok) {
    const code = r.status === 429 ? "rate_limited" : "upstream_error";
    const e = new Error(`gemini ${r.status}: ${raw.slice(0, 300)}`); e.code = code; e.status = r.status === 429 ? 429 : r.status === 400 ? 400 : 502; throw e;
  }
  if (j && j.promptFeedback && j.promptFeedback.blockReason) { const e = new Error("blocked"); e.code = "refused"; e.status = 422; throw e; }
  const cand = j && j.candidates && j.candidates[0];
  const text = cand && cand.content && cand.content.parts ? cand.content.parts.map(p => p.text || "").join("") : "";
  if (!text) {
    const e = new Error("empty: " + (cand && cand.finishReason));
    e.code = cand && /SAFETY|PROHIBITED|BLOCK/.test(cand.finishReason || "") ? "refused" : "empty_completion"; e.status = 422; throw e;
  }
  return { text, model, finish: cand.finishReason || "" };
}

/* ---------- Firebase web config (public by design; access is enforced by Firestore rules) ---------- */
function firebaseConfig() {
  if (process.env.FIREBASE_CONFIG) { try { return JSON.parse(process.env.FIREBASE_CONFIG); } catch (e) {} }
  const c = { apiKey: process.env.FIREBASE_API_KEY, authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID, appId: process.env.FIREBASE_APP_ID };
  return c.apiKey ? c : null;
}

/* ---------- clean public address ----------
   The app is served at the Firebase Hosting address (e.g. trikala.web.app), which forwards to this service.
   Hosting cuts forwarded requests off at 60s, and a full assessment can take longer, so the page sends
   /api/generate straight to this service's own address (API_BASE) instead. CORS lets that page call it. */
const API_BASE = (process.env.PUBLIC_API_BASE || "").replace(/\/+$/, "");
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean));
function cors(req, res) {
  const o = req.headers.origin;
  if (o && ALLOWED_ORIGINS.has(o)) {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "3600");
    return true;
  }
  return false;
}

/* ---------- routes ---------- */
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (p.startsWith("/api/")) {
    const ok = cors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(ok ? 204 : 403); return res.end(); }
  }

  if (p === "/healthz" || p === "/api/health") return send(res, 200, { ok: true, models: MODELS, fallbacks: FALLBACKS, working, benched: Object.fromEntries([...benched].filter(([, u]) => u > Date.now()).map(([m, u]) => [m, Math.round((u - Date.now()) / 60000) + " min"])), recent: RECENT, client: CLIENT, gemini: API_KEY ? "api-key" : "vertex", firebase: !!firebaseConfig() });

  if (p === "/api/diag" && url.searchParams.get("sharpen")) {
    if (allow("diag:" + clientIp(req))) return send(res, 429, { code: "rate_limited" });
    const m = (INDEX.match(/function SHARPEN\(q\)\{return `([\s\S]*?)`\}/) || [])[1];
    if (!m) return send(res, 500, { code: "no_prompt" });
    const q = url.searchParams.get("sharpen").slice(0, 300);
    const prompt = m.replace("${new Date().toISOString().slice(0,10)}", new Date().toISOString().slice(0, 10)).replace("${q.slice(0,600)}", q);
    const t0 = Date.now();
    const job = gemini(prompt, "quick", null).then(o => ({ model: o.model, ms: Date.now() - t0, raw: o.text }));
    const r = await Promise.race([job, new Promise(ok => setTimeout(() => ok({ pending: true, note: "still running after 25s; see /api/health recent" }), 25000))]).catch(e => ({ ok: false, error: String(e.message || e).slice(0, 400) }));
    job.catch(() => {});
    try { return send(res, 200, r, null, { "Cache-Control": "no-store" }); }
    catch (e) { return send(res, 200, { ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 400) }); }
  }

  if (p === "/api/diag") {
    if (allow("diag:" + clientIp(req))) return send(res, 429, { code: "rate_limited" });
    const list = [...new Set([MODELS.default, ...FALLBACKS.default, MODELS.quick, ...FALLBACKS.quick])];
    const results = await Promise.all(list.map(async m => {
      const t0 = Date.now();
      const big = url.searchParams.get("full") ? 'You are a goal engine. Assess this goal and return JSON with keys goal, opportunity (low|moderate|high), factors (8 items: name, impact, control, note), actions (5 items), paths (3 items), roadmap (4 items). Goal: become a Product Director within 12 months, currently a lead product designer with 9 years experience in India.' : 'Return JSON {"ok":true}';
      try { const o = await callModel(m, big, null, 110000); return { model: m, ok: true, ms: Date.now() - t0, chars: o.text.length }; }
      catch (e) { return { model: m, ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 220) }; }
    }));
    return send(res, 200, { gemini: API_KEY ? "api-key" : "vertex", location: VERTEX_LOCATION, thinking: THINKING, noThinking: [...noThinking], working, results }, null, { "Cache-Control": "no-store" });
  }

  if (p === "/api/clientlog") {
    if (req.method !== "POST") return send(res, 405, { code: "method" });
    let b = ""; try { b = await readBody(req, 4096); } catch (e) {}
    let j = {}; try { j = JSON.parse(b); } catch (e) {}
    CLIENT.unshift({ at: new Date().toISOString().slice(11, 19), m: String(j.m || "").slice(0, 300), w: String(j.w || "").slice(0, 120), ua: String(j.ua || req.headers["user-agent"] || "").slice(0, 160) });
    CLIENT.length = Math.min(CLIENT.length, 30);
    console.error(JSON.stringify({ evt: "client_error", ...CLIENT[0] }));
    return send(res, 204, "");
  }

  if (p === "/api/config") return send(res, 200, { firebase: firebaseConfig(), models: MODELS, apiBase: API_BASE || null }, null, { "Cache-Control": "no-store" });

  if (p === "/api/generate") {
    if (req.method !== "POST") return send(res, 405, { code: "method" });
    const why = allow(clientIp(req));
    if (why) return send(res, 429, { code: "rate_limited", why });
    let input;
    try { input = JSON.parse(await readBody(req, 1024 * 1024)); } catch (e) { return send(res, e && e.status || 400, { code: "bad_request" }); }
    const prompt = input && typeof input.prompt === "string" ? input.prompt : "";
    if (!prompt.trim()) return send(res, 400, { code: "bad_request" });
    if (prompt.length > MAX_PROMPT) return send(res, 413, { code: "too_long" });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 110000);
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });
    const t0 = Date.now();
    try {
      const out = await gemini(prompt, input.tier === "quick" ? "quick" : "default", ac.signal);
      console.log(JSON.stringify({ evt: "generate", model: out.model, ms: Date.now() - t0, chars: out.text.length, finish: out.finish }));
      return send(res, 200, { text: out.text, model: out.model });
    } catch (e) {
      const code = ac.signal.aborted ? "upstream_error" : e.code || "upstream_error";
      console.error(JSON.stringify({ evt: "generate_error", code, ms: Date.now() - t0, msg: String(e.message || e).slice(0, 400) }));
      return send(res, e.status || 502, { code });
    } finally { clearTimeout(timer); }
  }

  if (p === "/" || p === "/index.html") {
    if (process.env.DEV_RELOAD) INDEX = buildIndex();
    if (req.headers["if-none-match"] === INDEX_ETAG && !process.env.DEV_RELOAD) { res.writeHead(304); return res.end(); }
    return send(res, 200, INDEX, TYPES[".html"], { "Cache-Control": "no-cache", ETag: INDEX_ETAG });
  }

  if (p === "/runtime.js") return sendFile(res, path.join(__dirname, "runtime.js"), "no-cache");

  // other static files under public/
  const file = path.normalize(path.join(PUBLIC, decodeURIComponent(p)));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { code: "forbidden" });
  return sendFile(res, file, "public, max-age=3600");
}

function sendFile(res, file, cache) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    send(res, 200, buf, TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", { "Cache-Control": cache });
  });
}

http.createServer((req, res) => {
  handle(req, res).catch(e => { console.error(e); if (!res.headersSent) send(res, 500, { code: "server_error" }); });
}).listen(PORT, () => console.log(`Trikala listening on ${PORT} (gemini: ${API_KEY ? "api key" : "vertex"}, models: ${MODELS.default} / ${MODELS.quick})`));

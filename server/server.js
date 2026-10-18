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

async function gemini(prompt, tier, signal) {
  const model = MODELS[tier] || MODELS.default;
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.4, maxOutputTokens: 16384 },
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
    const e = new Error(`gemini ${r.status}: ${raw.slice(0, 300)}`); e.code = code; e.status = r.status === 429 ? 429 : 502; throw e;
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

/* ---------- routes ---------- */
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (p === "/healthz") return send(res, 200, { ok: true, models: MODELS, gemini: API_KEY ? "api-key" : "vertex", firebase: !!firebaseConfig() });

  if (p === "/api/config") return send(res, 200, { firebase: firebaseConfig(), models: MODELS }, null, { "Cache-Control": "no-store" });

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
    req.on("close", () => { if (!res.writableEnded) ac.abort(); });
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

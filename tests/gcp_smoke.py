"""Google Cloud build check: real Cloud Run server + Google runtime, with Gemini and Firebase mocked.

Starts a fake Gemini API and the Node server, then drives the goal flow in Chromium:
question -> sharpen (quick model) -> clarify -> assessment -> sign-in -> plan saved to "Firestore".
Run: python3 tests/gcp_smoke.py
"""
import json, os, pathlib, re, socket, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = ROOT / "tests" / "shots"; SHOTS.mkdir(exist_ok=True)
sys.path.insert(0, str(ROOT / "tests"))
from fixtures import SHARPEN, GOAL, CLARIFY, PLAN, CHECKIN

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

CALLS = []
class FakeGemini(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        prompt = body["contents"][0]["parts"][0]["text"]
        model = re.search(r"/models/([^:]+):generateContent", self.path).group(1)
        CALLS.append({"model": model, "key": self.headers.get("x-goog-api-key"), "json": body["generationConfig"].get("responseMimeType")})
        if model == "gemini-3.8-flash":   # simulate the main model being unavailable on the project
            return self._send(404, {"error": {"code": 404, "message": "model not found"}})
        if "FORCE_429" in prompt:
            return self._send(429, {"error": {"code": 429}})
        r = (SHARPEN if "You help people ask Trikala" in prompt else CLARIFY if "follow-up questions that matter most" in prompt
             else PLAN if "turn a chosen route into a practical plan" in prompt
             else (CHECKIN if "CHECK-IN:" in prompt else GOAL) if "goal engine" in prompt else {"ok": True})
        text = json.dumps(r)
        if "fenced" in prompt: text = "```json\n" + text + "\n```"
        self._send(200, {"candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": "STOP"}]})
    def _send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

# Minimal Firestore/Auth compat stand-in. It enforces the two Firestore rules that bite in practice:
# collection paths must have an odd number of segments, and arrays can't contain arrays.
FAKE_FIREBASE = r"""
(function(){
 const S=window.__FS={};
 const bad=v=>Array.isArray(v)?v.some(x=>Array.isArray(x)||bad(x)):(v&&typeof v==="object")?Object.values(v).some(bad):false;
 const col=path=>{if(path.split("/").length%2===0)throw new Error("Invalid collection path "+path);
  const q={orderBy(){return q},limit(){return q},where(){return q},
   get:async()=>{const docs=Object.keys(S).filter(k=>k.startsWith(path+"/")&&!k.slice(path.length+1).includes("/")).map(k=>({id:k.split("/").pop(),exists:true,data:()=>JSON.parse(JSON.stringify(S[k]))}));return{size:docs.length,empty:!docs.length,docs}},
   doc:id=>{id=id||Math.random().toString(36).slice(2);const k=path+"/"+id;return{id,
    get:async()=>({id,exists:k in S,data:()=>k in S?JSON.parse(JSON.stringify(S[k])):undefined}),
    set:async d=>{if(bad(d))throw new Error("Nested arrays are not supported");S[k]=JSON.parse(JSON.stringify(d))},
    delete:async()=>{delete S[k]}}}};return q};
 const user={uid:"anon-123",isAnonymous:true,displayName:null};let signed=null;
 window.firebase={initializeApp(){return{
  firestore(){return{settings(){},collection:col}},
  auth(){return{onAuthStateChanged(cb){setTimeout(()=>cb(signed));return()=>{}},signInAnonymously:async()=>{signed=user;window.__SIGNINS=(window.__SIGNINS||0)+1;return{user}}}}}}};
})();
"""

fails, errors = [], []
def check(cond, msg):
    (print("  ok  ", msg) if cond else (fails.append(msg), print("  FAIL", msg)))

gport, sport = free_port(), free_port()
gem = ThreadingHTTPServer(("127.0.0.1", gport), FakeGemini)
threading.Thread(target=gem.serve_forever, daemon=True).start()
env = dict(os.environ, PORT=str(sport), GEMINI_API_KEY="test-key", GEMINI_BASE_URL=f"http://127.0.0.1:{gport}",
           FIREBASE_API_KEY="fake", FIREBASE_AUTH_DOMAIN="x.firebaseapp.com", FIREBASE_PROJECT_ID="x", FIREBASE_APP_ID="1:2:web:3",
           RATE_LIMIT_PER_IP="200", USAGE_STORE="memory")
srv = subprocess.Popen(["node", str(ROOT / "server" / "server.js")], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
BASE = f"http://127.0.0.1:{sport}"
try:
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", sport), 0.2).close(); break
        except OSError: time.sleep(0.1)

    import urllib.request, urllib.error
    def post(prompt, tier="default"):
        req = urllib.request.Request(BASE + "/api/generate", json.dumps({"prompt": prompt, "tier": tier}).encode(), {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e: return e.code, json.loads(e.read())

    print("server")
    h = json.loads(urllib.request.urlopen(BASE + "/healthz").read())
    check(h["ok"] and h["firebase"] and h["gemini"] == "api-key", "healthz reports Gemini and Firebase")
    st, j = post("hello", "quick")
    check(st == 200 and json.loads(j["text"]) == {"ok": True}, "/api/generate returns Gemini text")
    check(CALLS[-1]["model"] == "gemini-3.5-flash-lite" and CALLS[-1]["key"] == "test-key" and CALLS[-1]["json"] == "application/json",
          "quick tier uses Flash-Lite, API key header and JSON mode")
    st, j = post("FORCE_429")
    check(st in (429, 502) and j["code"] in ("rate_limited", "upstream_error"), "Gemini 429 on every model is reported as an error")
    st, j = post("hello")
    check(st == 200 and [c["model"] for c in CALLS[-2:]] == ["gemini-3.8-flash", "gemini-3.6-flash"], "unavailable main model falls back to the next Flash")
    h2 = json.loads(urllib.request.urlopen(BASE + "/api/health").read())
    check(h2["working"].get("default") == "gemini-3.6-flash", "server remembers the working model")
    d = json.loads(urllib.request.urlopen(BASE + "/api/diag").read())
    check(any(r["model"] == "gemini-3.8-flash" and not r["ok"] for r in d["results"]) and any(r["ok"] for r in d["results"]), "diagnostics report per-model status")
    st, j = post("")
    check(st == 400, "empty prompt rejected")
    html = urllib.request.urlopen(BASE + "/").read().decode()
    check('<script src="/runtime.js"></script>' in html and "Claude" not in html, "page has the Google runtime and no Claude wording")

    print("browser")
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        pg.route("https://www.gstatic.com/firebasejs/**", lambda r: r.fulfill(status=200, content_type="text/javascript",
                 body=FAKE_FIREBASE if "app-compat" in r.request.url else ""))
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(BASE + "/"); pg.wait_for_timeout(1500)
        for _ in range(4):
            pg.evaluate("""['.cn button','.pro-skip','#wskip','#wskip2'].forEach(s=>{const e=document.querySelector(s);if(e&&e.offsetParent)e.click()})""")
            pg.wait_for_timeout(500)
        pg.evaluate("document.querySelectorAll('.pre,#pre').forEach(e=>e.remove())")
        check(pg.evaluate("window.TK_SOURCE") == "gcp", "runtime loaded before the app")
        check(pg.evaluate("window.__SIGNINS") == 1, "Firebase anonymous sign-in on first visit")

        pg.fill("#q", "I want to be rich"); pg.click("#snext"); pg.wait_for_timeout(1200)
        check(pg.locator(".sugg:not(.skel)").count() == 2, "sharpen suggestions come back from Gemini")
        check(any("flash-lite" in c["model"] for c in CALLS[-3:]), "prompt helper uses a quick (Flash-Lite) model")

        pg.fill("#q", "Can I build ₹2 crore in investments by 2032, starting from ₹15 lakh?")
        pg.click("#snext"); pg.wait_for_timeout(1200)
        check(pg.locator(".clq").count() == 3, "clarify questions from Gemini")
        pg.locator(".clq").nth(0).locator(".clopt").nth(2).click()
        pg.locator(".clq").nth(1).locator(".clin").fill("Lead product designer, 9 years")
        pg.click("#run"); pg.wait_for_selector(".goalhead", timeout=10000); pg.wait_for_timeout(1200)
        check(pg.locator(".fcol").count() == 3, "goal assessment renders from Gemini")
        check(CALLS[-1]["model"] == "gemini-3.6-flash", "assessment goes straight to the working model")
        pg.screenshot(path=str(SHOTS / "gcp-1-assessment.png"), full_page=True)
        check("Claude" not in pg.inner_text("body"), "no Claude wording on screen")

        pg.locator(".pickroute.main").click(); pg.wait_for_timeout(500)
        check(pg.is_visible("#signin") and "Trikala account" in pg.inner_text("#siGo"), "sign-in offers a Trikala account")
        pg.check("#siConsent"); pg.click("#siGo")
        pg.wait_for_selector("#goalDetail", timeout=10000); pg.wait_for_timeout(800)
        keys = pg.evaluate("Object.keys(window.__FS)")
        goal_keys = [k for k in keys if k.startswith("users/anon-123/goals/")]
        check(len(goal_keys) == 1, "goal saved to Firestore under users/{uid}/goals")
        check(any(k == "users/anon-123/profile/main" for k in keys), "profile saved to Firestore")
        doc = pg.evaluate(f"window.__FS[{json.dumps(goal_keys[0] if goal_keys else '')}]") or {}
        check(isinstance(doc.get("_j"), str) and "updated" in doc, "documents stored as JSON with sortable fields")
        check(pg.locator(".gtodo").count() == 3, "plan from Gemini shows on goal home")
        pg.screenshot(path=str(SHOTS / "gcp-2-goal-home.png"))

        n = pg.evaluate("window.claude.use('db').then(d=>d.collection('data/users/anon-123/goals').get()).then(s=>s.docs.map(x=>x.data().id).length)")
        check(n == 1, "goals read back through the runtime")
        b.close()
finally:
    srv.terminate(); gem.shutdown()
    out = srv.stdout.read() if srv.stdout else ""

check(not errors, "no page errors" + (": " + "; ".join(errors[:3]) if errors else ""))
print(f"\n{len(fails)} failed" if fails else "\nall passed")
if fails: print(out[-2000:])
sys.exit(1 if fails else 0)

"""Usage tracking, limits, admin controls and alerts, against the real server.

Fakes: Gemini (returns usageMetadata), Google's Firebase signing certs (a key made here),
and the Telegram Bot API. Firestore is off (USAGE_STORE=memory).
Run: python3 tests/usage_test.py
"""
import base64, json, os, pathlib, socket, subprocess, sys, tempfile, threading, time, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent.parent
fails = []
def check(cond, msg):
    print("  ok  " if cond else "  FAIL", msg)
    if not cond: fails.append(msg)
def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

# --- a signing key standing in for Google's, and tokens signed with it ---
tmp = pathlib.Path(tempfile.mkdtemp())
subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(tmp / "k.pem"), "-out", str(tmp / "c.pem"),
                "-days", "1", "-subj", "/CN=test"], check=True, capture_output=True)
CERT = (tmp / "c.pem").read_text()
b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def id_token(uid, project="proj-x", anon=True, email=None, kid="k1", exp_in=3600):
    now = int(time.time())
    head = {"alg": "RS256", "kid": kid, "typ": "JWT"}
    body = {"iss": f"https://securetoken.google.com/{project}", "aud": project, "sub": uid, "iat": now - 10, "exp": now + exp_in,
            "firebase": {"sign_in_provider": "anonymous" if anon else "password"}}
    if email: body["email"] = email
    signing = (b64u(json.dumps(head).encode()) + "." + b64u(json.dumps(body).encode())).encode()
    (tmp / "in").write_bytes(signing)
    sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", str(tmp / "k.pem"), str(tmp / "in")], check=True, capture_output=True).stdout
    return signing.decode() + "." + b64u(sig)

TG = []
class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path == "/certs": return self._send(200, {"k1": CERT})
        self._send(404, {})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if self.path.startswith("/botTESTTOKEN/"):
            TG.append({"method": self.path.split("/")[-1], **body}); return self._send(200, {"ok": True})
        # Gemini
        self._send(200, {"candidates": [{"content": {"parts": [{"text": "{\"ok\":true}"}]}, "finishReason": "STOP"}],
                         "usageMetadata": {"promptTokenCount": 3000, "candidatesTokenCount": 1500, "thoughtsTokenCount": 500, "totalTokenCount": 5000}})

fport, sport = free_port(), free_port()
fake = ThreadingHTTPServer(("127.0.0.1", fport), Fake); threading.Thread(target=fake.serve_forever, daemon=True).start()
F = f"http://127.0.0.1:{fport}"
env = dict(os.environ, PORT=str(sport), GEMINI_API_KEY="k", GEMINI_BASE_URL=F, USAGE_STORE="memory",
           FIREBASE_PROJECT_ID="proj-x", FIREBASE_API_KEY="fake", FIREBASE_CERTS_URL=F + "/certs",
           ADMIN_KEY="admin-secret-123", TELEGRAM_BOT_TOKEN="TESTTOKEN", TELEGRAM_API_BASE=F,
           DAILY_TOKEN_BUDGET="60000", USER_DAILY_TOKENS="20000", GUEST_DAILY_TOKENS="10000", ALERT_BURST_CALLS="100",
           RATE_LIMIT_PER_IP="500")
srv = subprocess.Popen(["node", str(ROOT / "server" / "server.js")], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
B = f"http://127.0.0.1:{sport}"

def req(path, body=None, headers=None, method=None):
    h = {"Content-Type": "application/json", **(headers or {})}
    r = urllib.request.Request(B + path, json.dumps(body).encode() if body is not None else None, h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=15) as res: return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read() or b"{}"
        try: return e.code, json.loads(raw)
        except ValueError: return e.code, {}
def gen(tok=None, sid="s-test", ua="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/130 Mobile Safari/604.1"):
    h = {"X-Trikala-Session": sid, "User-Agent": ua}
    if tok: h["X-Trikala-Token"] = tok
    return req("/api/generate", {"prompt": "hi", "tier": "default"}, h)
ADM = {"X-Admin-Key": "admin-secret-123"}

try:
    for _ in range(60):
        try: socket.create_connection(("127.0.0.1", sport), 0.2).close(); break
        except OSError: time.sleep(0.1)
    time.sleep(0.3)

    print("identity")
    alice = id_token("alice-uid-1", anon=False, email="alice@example.com")
    st, j = gen(alice, sid="s-alice")
    check(st == 200 and j.get("text"), "verified user gets an answer")
    st, s = req("/api/admin/summary", headers=ADM)
    u = {x["uid"]: x for x in s["users"]}
    check("alice-uid-1" in u and u["alice-uid-1"]["label"] == "alice@example.com" and u["alice-uid-1"]["kind"] == "account", "signed-in user tracked by email")
    check(u["alice-uid-1"]["today"]["tokens"] == 5000 and u["alice-uid-1"]["device"] == "iPhone · Chrome", "tokens and device recorded from Gemini's counts")
    check(abs(s["totals"]["cost"] - (3000 * 0.30 + 2000 * 2.50) / 1e6) < 1e-9, "cost estimate counts thinking tokens as output")
    forged = id_token("mallory", project="other-project")
    gen(forged, sid="s-mal")
    expired = id_token("old-uid", exp_in=-60)
    gen(expired, sid="s-old")
    st, s = req("/api/admin/summary", headers=ADM)
    ids = [x["uid"] for x in s["users"]]
    check("mallory" not in ids and "old-uid" not in ids and any(i.startswith("unverified-") for i in ids), "wrong-project and expired tokens are treated as unverified")
    tampered = alice[:-6] + ("AAAAAA" if not alice.endswith("AAAAAA") else "BBBBBB")
    gen(tampered, sid="s-tamper")
    st, s = req("/api/admin/summary", headers=ADM)
    check(s["users"] and [x for x in s["users"] if x["uid"] == "alice-uid-1"][0]["today"]["calls"] == 1, "tampered signature isn't counted as the real user")

    print("admin access")
    st, _ = req("/api/admin/summary"); check(st == 401, "summary needs the admin key")
    st, _ = req("/api/admin/summary", headers={"X-Admin-Key": "wrong"}); check(st == 401, "wrong key refused")
    st, _ = req("/api/admin/act", {"action": "pause"}, {"X-Admin-Key": "nope"}); check(st == 401, "controls need the admin key")
    with urllib.request.urlopen(B + "/admin") as r: check(r.status == 200 and b"Usage dashboard" in r.read(), "dashboard page is served")

    print("per-person limit and alert")
    bob = id_token("bob-uid-2")
    codes = [gen(bob, sid="s-bob")[0] for _ in range(5)]
    check(codes[:4] == [200] * 4 and codes[4] == 429, "person is stopped at their daily limit (20k = 4 calls)")
    st, j = gen(bob, sid="s-bob"); check(j.get("code") == "user_limit" and "today's limit" in j.get("message", ""), "limit message is plain and says when it resets")
    st, j = gen(alice, sid="s-alice"); check(st == 200, "other people are unaffected")

    print("blocking and closing sessions")
    st, _ = req("/api/admin/act", {"action": "block", "arg": "alice-uid-1"}, ADM); check(st == 200, "block from the dashboard")
    st, j = gen(alice, sid="s-alice"); check(st == 403 and j.get("code") == "blocked", "blocked person is refused at once")
    req("/api/admin/act", {"action": "unblock", "arg": "alice-uid-1"}, ADM)
    st, _ = gen(alice, sid="s-alice"); check(st == 200, "unblock restores access")
    req("/api/admin/act", {"action": "closeSession", "arg": "s-alice"}, ADM)
    st, j = gen(alice, sid="s-alice"); check(st == 403, "closed session is refused")
    st, _ = gen(alice, sid="s-alice-newtab"); check(st == 200, "closing a session doesn't block the person")

    print("pause and app budget")
    frank = id_token("frank-uid-6")
    req("/api/admin/act", {"action": "pause"}, ADM)
    st, j = gen(frank, sid="s-frank"); check(st == 503 and j.get("code") == "paused", "pause stops everyone")
    req("/api/admin/act", {"action": "resume"}, ADM)
    st, _ = gen(frank, sid="s-frank"); check(st == 200, "resume restores")
    carol = id_token("carol-uid-3")
    for _ in range(4): gen(carol, sid="s-carol")
    dave = id_token("dave-uid-4")
    st, j = gen(dave, sid="s-dave")
    check(j.get("code") == "budget", "whole-app budget stops new requests (60k)")
    req("/api/admin/act", {"action": "limits", "arg": {"dailyTokens": 1000000}}, ADM)
    st, s = req("/api/admin/summary", headers=ADM)
    check(s["limits"]["dailyTokens"] == 1000000, "limits can be raised from the dashboard")
    st, _ = gen(dave, sid="s-dave"); check(st == 200, "raised budget lets requests through")
    st, _ = req("/api/admin/act", {"action": "limits", "arg": {"dailyTokens": -5}}, ADM)
    st, s = req("/api/admin/summary", headers=ADM); check(s["limits"]["dailyTokens"] == 1000000, "negative limits are ignored")

    print("telegram")
    secret = __import__("hashlib").sha256(b"tg:admin-secret-123").hexdigest()[:24]
    TGH = {"X-Telegram-Bot-Api-Secret-Token": secret}
    st, _ = req(f"/api/tg/{secret}", {"callback_query": {"id": "x", "data": "pause", "message": {"chat": {"id": 777}}}})
    check(st == 401, "updates without Telegram's secret header are refused")
    st, _ = req(f"/api/tg/{secret}", {"message": {"chat": {"id": 777}, "text": "/start admin-secret-123"}}, {"X-Telegram-Bot-Api-Secret-Token": "x" * 24})
    check(st == 401, "wrong secret header is refused")
    TG.clear()
    req(f"/api/tg/{secret}", headers=TGH, body={"message": {"chat": {"id": 777}, "text": "/start wrong-key"}})
    check(TG and "To link alerts" in TG[-1]["text"], "linking needs the admin key")
    req(f"/api/tg/{secret}", headers=TGH, body={"message": {"chat": {"id": 777}, "text": "/start admin-secret-123"}})
    check("Linked" in TG[-1]["text"], "admin links their chat with /start <key>")
    TG.clear()
    erin = id_token("erin-uid-5")
    for _ in range(3): gen(erin, sid="s-erin")   # 15k of 20k -> crosses 60% alert
    time.sleep(0.5)                              # alerts go out just after the response
    sent = [m for m in TG if m["method"] == "sendMessage" and m["chat_id"] == "777"]
    check(any("using a lot today" in m["text"] for m in sent), "heavy user triggers an alert")
    btns = [b["callback_data"] for m in sent for row in m["reply_markup"]["inline_keyboard"] for b in row if "callback_data" in b]
    check("block:erin-uid-5" in btns and "sess:s-erin" in btns, "alert has Block and Close session buttons")
    req(f"/api/tg/{secret}", headers=TGH, body={"callback_query": {"id": "cb1", "data": "block:erin-uid-5", "message": {"chat": {"id": 777}}}})
    st, j = gen(erin, sid="s-erin"); check(st == 403, "tapping Block in Telegram blocks them")
    req(f"/api/tg/{secret}", headers=TGH, body={"callback_query": {"id": "cb2", "data": "pause", "message": {"chat": {"id": 999}}}})
    st, _ = gen(dave, sid="s-dave"); check(st == 200, "buttons from other chats are ignored")
    req(f"/api/tg/{secret}", headers=TGH, body={"message": {"chat": {"id": 777}, "text": "/status"}})
    check("Today:" in TG[-1]["text"], "/status reports today's usage")
    st, _ = req("/api/tg/wrongsecret", {"message": {"chat": {"id": 1}, "text": "/start admin-secret-123"}})
    check(st != 200, "webhook path is secret")

    print("cors")
    r = urllib.request.Request(B + "/api/generate", method="OPTIONS", headers={"Origin": "https://evil.example", "Access-Control-Request-Headers": "x-trikala-token"})
    try: urllib.request.urlopen(r); code = 200
    except urllib.error.HTTPError as e: code = e.code
    check(code == 403, "unknown sites can't call the API from a browser")
finally:
    srv.terminate()
    out = srv.communicate(timeout=5)[0]
    if fails: print(out[-3000:])

print("\n" + ("all passed" if not fails else f"{len(fails)} failed"))
sys.exit(1 if fails else 0)

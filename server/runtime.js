/* Trikala — Google runtime.
   The app talks to its backend through window.claude.use(name). On claude.ai that is the artifact
   runtime; here the same three services are backed by Google:
     "sample" -> Gemini, through /api/generate on Cloud Run
     "user"   -> Firebase Authentication (anonymous account, upgradable later)
     "db"     -> Cloud Firestore, scoped by security rules to the signed-in user
   If Firebase isn't configured the app still works: answers come from Gemini and history stays on the device. */
(function () {
  "use strict";
  window.TK_SOURCE = "gcp";
  // Send uncaught errors to the server log (no personal data: message, source line, user agent).
  (function () {
    var sent = 0;
    function report(msg, where) {
      if (sent++ > 10) return;
      try { navigator.sendBeacon ? navigator.sendBeacon("/api/clientlog", JSON.stringify({ m: String(msg).slice(0, 300), w: String(where || "").slice(0, 120), ua: navigator.userAgent.slice(0, 160) }))
        : fetch("/api/clientlog", { method: "POST", body: JSON.stringify({ m: String(msg).slice(0, 300), w: where }), keepalive: true }); } catch (e) {}
    }
    window.addEventListener("error", function (e) { report(e.message, (e.filename || "").split("/").pop() + ":" + e.lineno + ":" + e.colno); });
    window.addEventListener("unhandledrejection", function (e) { var r = e.reason; report(r && (r.message || r.code || r) , "promise"); });
    var ce = console.error; console.error = function () { try { report(Array.prototype.map.call(arguments, String).join(" "), "console"); } catch (e) {} return ce.apply(console, arguments); };
  })();
  var FB = "https://www.gstatic.com/firebasejs/10.14.1/";

  var cfgP = fetch("/api/config", { cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return {}; });

  function loadScript(src) {
    return new Promise(function (ok, bad) {
      var s = document.createElement("script"); s.src = src; s.async = false;
      s.onload = ok; s.onerror = function () { bad(new Error("load " + src)); };
      document.head.appendChild(s);
    });
  }

  /* ---------- Firebase (Auth + Firestore) ---------- */
  var fbP = null;
  function firebaseReady() {
    if (fbP) return fbP;
    fbP = cfgP.then(function (cfg) {
      if (!cfg || !cfg.firebase || !cfg.firebase.apiKey) return null;
      return loadScript(FB + "firebase-app-compat.js")
        .then(function () { return Promise.all([loadScript(FB + "firebase-auth-compat.js"), loadScript(FB + "firebase-firestore-compat.js")]); })
        .then(function () {
          var app = window.firebase.initializeApp(cfg.firebase);
          var fs = app.firestore();
          try { fs.settings({ ignoreUndefinedProperties: true, merge: true }); } catch (e) {}
          var auth = app.auth();
          return new Promise(function (ok) { var u = auth.onAuthStateChanged(function (x) { u(); ok(x); }); })
            .then(function (user) { return user || auth.signInAnonymously().then(function (c) { return c.user; }); })
            .then(function (user) { return user ? { auth: auth, fs: fs, user: user } : null; });
        });
    }).catch(function (e) { console.warn("[trikala] Firebase unavailable, using device storage:", e && e.message); return null; });
    return fbP;
  }

  /* Firestore needs odd-length collection paths and has no nested arrays, so the app's documents
     are stored as JSON text with the sortable fields (id, created, updated) kept alongside. */
  function fixPath(p) {
    var s = String(p).split("/").filter(Boolean);
    if (s.length % 2 === 0) s = s[0] === "data" ? s.slice(1) : [s[0] + "_" + s[1]].concat(s.slice(2));
    return s.join("/");
  }
  function pack(d) {
    var o = { _j: JSON.stringify(d === undefined ? null : d), _v: 1 };
    if (d && typeof d === "object") ["id", "created", "updated", "asOf"].forEach(function (k) { if (d[k] != null && typeof d[k] !== "object") o[k] = d[k]; });
    return o;
  }
  function unpack(raw) {
    if (raw && typeof raw._j === "string") { try { return JSON.parse(raw._j); } catch (e) { return null; } }
    return raw;
  }
  function wrapDoc(snap) { return { id: snap.id, exists: snap.exists, data: function () { return unpack(snap.data()); } }; }
  function wrapQuery(q) {
    return {
      orderBy: function (f, dir) { return wrapQuery(q.orderBy(f, dir)); },
      limit: function (n) { return wrapQuery(q.limit(n)); },
      where: function (f, op, v) { return wrapQuery(q.where(f, op, v)); },
      get: function () { return q.get().then(function (s) { return { size: s.size, empty: s.empty, docs: s.docs.map(wrapDoc) }; }); }
    };
  }
  function makeDb(fs) {
    return {
      collection: function (p) {
        var col = fs.collection(fixPath(p));
        var q = wrapQuery(col);
        q.doc = function (id) {
          var ref = id ? col.doc(String(id)) : col.doc();
          return {
            id: ref.id,
            get: function () { return ref.get().then(wrapDoc); },
            set: function (d) { return ref.set(pack(d)); },
            update: function (d) { return ref.get().then(function (s) { return ref.set(pack(Object.assign({}, unpack(s.data()) || {}, d))); }); },
            delete: function () { return ref.delete(); }
          };
        };
        q.add = function (d) { var ref = col.doc(); return ref.set(pack(d)).then(function () { return { id: ref.id }; }); };
        return q;
      }
    };
  }

  /* ---------- who is asking: verified sign-in token + one id per browser tab ---------- */
  var SID = (function () {
    try { var v = sessionStorage.getItem("tk.sid"); if (!v) { v = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); sessionStorage.setItem("tk.sid", v); } return v; }
    catch (e) { return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  })();
  function idToken() {
    var t = firebaseReady().then(function (f) { return f && f.user && f.user.getIdToken ? f.user.getIdToken() : ""; }).catch(function () { return ""; });
    return Promise.race([t, new Promise(function (ok) { setTimeout(function () { ok(""); }, 4000); })]);
  }
  function authHeaders() {
    return idToken().then(function (tok) {
      var h = { "Content-Type": "application/json", "X-Trikala-Session": SID };
      if (tok) h["X-Trikala-Token"] = tok;
      return h;
    });
  }
  // A short, plain notice when the owner has paused the app, closed this session, or a daily limit is hit.
  var STOP = { paused: 1, blocked: 1, budget: 1, user_limit: 1 };
  function notice(text) {
    try {
      var n = document.getElementById("tk-stop");
      if (!n) {
        n = document.createElement("div"); n.id = "tk-stop"; n.setAttribute("role", "alert");
        n.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(96px + env(safe-area-inset-bottom,0px));z-index:2147483000;max-width:min(92vw,440px);" +
          "background:#0f141e;color:#f2f5fc;border-radius:14px;padding:12px 16px;font:500 14px/1.45 Inter,system-ui,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.28)";
        document.body.appendChild(n);
      }
      n.textContent = text;
      clearTimeout(n._t); n._t = setTimeout(function () { n.remove(); }, 9000);
    } catch (e) {}
  }

  /* ---------- Gemini ---------- */
  function err(code, text) { var e = { code: code }; if (text) e.text = text; return e; }
  // Gemini sometimes wraps the object in a one-item array or in a single key like {"response": {...}}.
  function unwrap(v) {
    if (Array.isArray(v) && v.length === 1 && v[0] && typeof v[0] === "object" && !Array.isArray(v[0])) return v[0];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      var k = Object.keys(v);
      if (k.length === 1 && /^(response|result|output|data|answer|json)$/i.test(k[0]) && v[k[0]] && typeof v[k[0]] === "object") return v[k[0]];
    }
    return v;
  }
  function parseJSON(t) {
    var s = String(t || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try { return unwrap(JSON.parse(s)); } catch (e) {}
    var i = s.search(/[\{\[]/), j = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
    if (i >= 0 && j > i) { try { return unwrap(JSON.parse(s.slice(i, j + 1))); } catch (e) {} }
    throw err("invalid_json", t);
  }
  function generate(prompt, opts) {
    opts = opts || {};
    // Never leave the app waiting forever: give up after 115s (the server gives up before that).
    // Quick steps (sharpen, clarify) give up after 12s so the app shows its built-in fallback instead of a spinner.
    var limit = opts.modelTier === "quick" ? 12000 : 100000;
    var ac = new AbortController(), timer = setTimeout(function () { ac.abort(); }, limit);
    if (opts.signal) { if (opts.signal.aborted) ac.abort(); else opts.signal.addEventListener("abort", function () { ac.abort(); }); }
    // On the clean address the page talks to the service directly, so long answers aren't cut off at 60s.
    return Promise.all([cfgP, authHeaders()]).then(function (got) {
      var c = got[0], headers = got[1];
      var base = c && c.apiBase && c.apiBase.indexOf(location.origin) !== 0 ? c.apiBase : "";
      return fetch(base + "/api/generate", {
        method: "POST", headers: headers, signal: ac.signal,
        body: JSON.stringify({ prompt: String(prompt), tier: opts.modelTier === "quick" ? "quick" : "default" })
      }).catch(function (e) {
        // If the direct call is blocked (CORS, network policy), retry through the page's own address.
        if (!base || ac.signal.aborted) throw e;
        return fetch("/api/generate", {
          method: "POST", headers: headers, signal: ac.signal,
          body: JSON.stringify({ prompt: String(prompt), tier: opts.modelTier === "quick" ? "quick" : "default" })
        });
      });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok && STOP[j.code]) notice(j.message || "Trikala can't answer right now.");
        if (!r.ok) throw err(j.code || (r.status === 429 ? "rate_limited" : "upstream_error"));
        if (!j.text) throw err("empty_completion");
        if (typeof opts.onText === "function") { try { opts.onText({ text: j.text }); } catch (e) {} }
        return j.text;
      });
    }, function (e) { throw err(e && e.name === "AbortError" ? (opts.signal && opts.signal.aborted ? "cancelled" : "upstream_error") : "upstream_error"); })
      .finally(function () { clearTimeout(timer); });
  }
  var sample = function (prompt, opts) { return generate(prompt, opts).then(function (text) { return { text: text }; }); };
  sample.json = function (prompt, opts) { return generate(prompt, opts).then(parseJSON); };
  sample.text = function (prompt, opts) { return generate(prompt, opts); };

  /* ---------- the runtime the app expects ---------- */
  window.claude = {
    use: function (name) {
      if (name === "sample") return Promise.resolve(sample);
      if (name === "db") return firebaseReady().then(function (f) { return f ? makeDb(f.fs) : null; });
      if (name === "user") return firebaseReady().then(function (f) {
        if (!f) return null;
        return {
          me: function () { return Promise.resolve({ id: f.user.uid, name: f.user.displayName || "", anonymous: f.user.isAnonymous }); },
          id: function () { return Promise.resolve(f.user.uid); },
          isOwner: function () { return Promise.resolve(false); },
          can: function () { return Promise.resolve(true); }
        };
      });
      return Promise.resolve(null);
    }
  };
})();

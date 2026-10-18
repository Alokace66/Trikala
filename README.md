# Trikala

**Don't predict your future. Improve your odds.**

Trikala is a personal decision-intelligence app. Ask it about something you want to achieve, and instead of a single probability it shows what's working for you, what's working against you, which of those factors you can actually control, what to do next, what to watch, and whether a different route would give you better odds of reaching the same goal.

One app, two engines, chosen by the question:

- **Goal engine** — "Can I / should I…?" An opportunity band (low / moderate / high, never false-precision percentages), factors grouped as controllable, partly controllable and outside your control, highest-leverage actions, indicators to monitor, alternative routes, a roadmap, and check-ins that show whether your odds moved because of you or because the world changed.
- **Forecast engine** — "Will X happen?" Calibrated odds, scenarios and signals, with an optional Vedic lens.

A prompt helper under the question box routes the question, rates its clarity, and asks a fast model for two or three sharper rewrites when a question is too vague to answer well.

## How it uses Google Cloud

| Service | What it does in Trikala |
|---|---|
| **Gemini** (Vertex AI on Cloud Run, or the Gemini API) | Every model call: question sharpening and routing (Flash-Lite), clarifying questions, goal assessments, route plans, check-ins and forecasts (Flash). JSON mode keeps outputs structured so the UI can render factors, actions and routes. |
| **Cloud Run** | Hosts the whole app as one service: the web app, the `/api/generate` endpoint that calls Gemini with the service account (no API key in the browser), per-IP and daily rate limits, and structured logs. |
| **Firebase Authentication** | Every visitor gets an anonymous account on first load, so they can ask without signing up. Saving a goal asks for consent first. |
| **Cloud Firestore** | Stores each person's forecasts, goals, check-in history and profile under `users/{uid}`, locked to that user by security rules. Also holds tester feedback and session logs. |

```
Browser (public/index.html + server/runtime.js)
   │  Firebase Auth (anonymous) ──► uid
   │  Firestore  users/{uid}/goals, forecasts, profile   (rules: owner only)
   │
   └─► Cloud Run  ── server/server.js
         ├─ GET  /            app, with the Google runtime injected
         ├─ GET  /api/config  public Firebase web config
         └─ POST /api/generate ─► Gemini (Vertex AI, service account) ─► JSON
```

The app talks to its backend through one interface, `window.claude.use("sample" | "user" | "db")`. On Google Cloud, `server/runtime.js` implements it with Gemini, Firebase Auth and Firestore, so the same `public/index.html` runs unchanged.

## Layout
- `public/index.html` — the whole app
- `server/server.js` — Cloud Run service, no npm dependencies (Node 20+)
- `server/runtime.js` — Gemini + Firebase Auth + Firestore runtime for the app
- `firestore.rules` — Firestore security rules
- `Dockerfile` — container for Cloud Run
- `deploy/deploy.sh` — one-shot setup and deploy (APIs, Firestore, Firebase app, anonymous auth, rules, IAM, Cloud Run)
- `design/tokens.json` — design tokens, single source of truth; `npm run tokens` regenerates the CSS
- `tests/` — Playwright end-to-end tests with mocked model and storage

## Run locally
```bash
GEMINI_API_KEY=your-ai-studio-key npm start      # http://localhost:8080
```
Without Firebase settings, history stays on the device. Add `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID` and `FIREBASE_APP_ID` to use Firestore.

## Deploy
```bash
PROJECT_ID=your-project ./deploy/deploy.sh
```
Configuration (environment variables on the Cloud Run service):

| Variable | Default | |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.8-flash` | assessments, plans, forecasts |
| `GEMINI_MODEL_QUICK` | `gemini-3.5-flash-lite` | prompt helper |
| `GEMINI_API_KEY` | unset | if set, uses the Gemini API instead of Vertex AI |
| `GOOGLE_CLOUD_LOCATION` | `global` | Vertex AI location |
| `RATE_LIMIT_PER_IP` / `DAILY_CAP` | `40` per 10 min / `3000` per day | abuse protection |

## Test
`npm test` (Python 3 + Playwright with Chromium): design-token drift check, the full app flow with a mocked runtime, and `tests/gcp_smoke.py`, which runs the real Cloud Run server and Google runtime against a fake Gemini API and Firestore.

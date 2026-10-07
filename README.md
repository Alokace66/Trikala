# Trikala

One app, two engines, chosen by the user's question:

- **Forecast** — "Will X happen?" Calibrated odds, scenarios, actions, optional Vedic lens.
- **Goal** — "Can I / should I…?" Opportunity band (low/moderate/high), factors split by controllability, alternative routes, roadmap, reassessment loop. No astrology, no percentages.

A prompt helper sits under the question box: it routes the question, rates clarity, offers hint chips (no API cost) and, on request or when a vague question hits Next, asks a quick model for 2–3 sharper rewrites with `[fill-in]` placeholders.

## Layout
- `public/index.html` — the whole app (published as a claude.ai artifact)
- `design/tokens.json` — design tokens, single source of truth (light + dark values)
- `design/tokens.css` — generated
- `scripts/sync-tokens.py` — regenerates the `@tokens` block in index.html and tokens.css
- `tests/e2e.py` — Playwright run with a mocked Claude runtime; screenshots in `tests/shots/`

## Changing the design
Edit `design/tokens.json`, run `npm run tokens`, never hand-edit the generated block. `npm test` fails if they drift.

## Test
`npm test` (Python 3 + Playwright with Chromium).

"""End-to-end check of the Ask flow with a mocked Claude runtime.

Covers: theme switch (auto/light/dark), prompt helper (route pill, clarity, hint
chips, sharpen suggestions, gate on Next), goal engine render, forecast routing.
Run: python3 tests/e2e.py  (writes screenshots to tests/shots/)
"""
import json, pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = ROOT / "tests" / "shots"
SHOTS.mkdir(exist_ok=True)

SHARPEN = {"route": "goal", "clarity": "vague", "why": "Say how much, by when, and where you're starting from.",
           "missing": ["measurable outcome", "deadline"],
           "suggestions": [{"text": "Can I build ₹2 crore in investments by 2032, starting from [current savings]?", "adds": "amount + deadline"},
                           {"text": "Can I reach a ₹50 LPA role by 2028 as a [current role]?", "adds": "income target"}]}
GOAL = {"goal": "Build ₹2 crore in investments by 2032", "path": "Saving 20% of salary in mutual funds",
        "opportunity": "moderate", "potential": "high", "controlShare": "3 of 4 major limiting factors are controllable",
        "headline": "Your savings rate is the main constraint, and it's yours to change.", "verdict": "prepare",
        "verdictWhy": "The target is reachable if contributions rise over the next year.",
        "factors": [{"name": "Monthly savings rate", "impact": "high", "control": "controllable", "state": "hurts", "note": "At today's rate you reach about half the target."},
                    {"name": "Income growth", "impact": "high", "control": "partial", "state": "helps", "note": "A role change could lift it sharply."},
                    {"name": "Equity market returns", "impact": "high", "control": "uncontrollable", "state": "mixed", "note": "Long-run average assumed."},
                    {"name": "Asset allocation", "impact": "medium", "control": "controllable", "state": "mixed", "note": "Too much in debt funds for an 8-year goal."}],
        "actions": [{"action": "Raise SIP by 10% every April", "why": "Compounding does most of the work", "impact": "high", "effort": "low", "effect": "Closes about a third of the gap"}],
        "monitor": [{"indicator": "Real returns over 3 years", "why": "Plan assumes long-run equity returns", "trigger": "Below inflation for 3 straight years"}],
        "paths": [{"name": "Save harder", "route": "Same job, bigger SIPs", "control": "high", "time": "8 years", "risk": "low", "fit": "Simple but slow", "recommended": False},
                  {"name": "Earn more first", "route": "Switch to a higher-paying role, then invest the raise", "control": "medium", "time": "6-8 years", "risk": "medium", "fit": "Uses your experience", "recommended": True}],
        "roadmap": [{"when": "Next 30 days", "milestone": "Automate a higher SIP", "checkpoint": "Mandate live"}],
        "reassess": "In 6 months, with your portfolio value.", "assumptions": ["10% long-run equity return"]}

MOCK = """
window.__MOCK__=%s;
window.claude={use:async n=>n==="sample"?(()=>{const f=async()=>({text:""});f.json=async(p,o)=>{
  const M=window.__MOCK__;const r=/You help people ask Trikala/.test(p)?M.sharpen:/goal engine/.test(p)?M.goal:null;
  if(o&&o.onText){const t=JSON.stringify(r||{});for(let i=0;i<4;i++){await new Promise(z=>setTimeout(z,60));o.onText({text:t.slice(0,t.length*(i+1)/4)})}}
  if(!r)throw{code:"upstream_error"};return JSON.parse(JSON.stringify(r))};return f})():null};
""" % json.dumps({"sharpen": SHARPEN, "goal": GOAL})

errors, fails = [], []
def check(cond, msg):
    (print("  ok  ", msg) if cond else (fails.append(msg), print("  FAIL", msg)))

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    pg.add_init_script(MOCK)
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto((ROOT / "public" / "index.html").as_uri())
    pg.wait_for_timeout(1500)
    for _ in range(4):  # dismiss consent, prologue and welcome sheets, whatever order they appear in
        pg.evaluate("""['.cn button','.pro-skip','#wskip','#wskip2'].forEach(s=>{const e=document.querySelector(s);if(e&&e.offsetParent)e.click()})""")
        pg.wait_for_timeout(500)
    pg.evaluate("document.querySelectorAll('.pre,#pre').forEach(e=>e.remove())")

    # theme: auto -> light
    pg.click("#themeBtn"); pg.wait_for_timeout(400)
    check(pg.evaluate("document.documentElement.dataset.theme") == "light", "theme switches to light")
    pg.screenshot(path=str(SHOTS / "1-light-ask.png"))

    # helper on a vague goal question
    pg.fill("#q", "I want to be rich"); pg.wait_for_timeout(200)
    check(pg.is_visible("#qhelp"), "helper appears")
    check(pg.get_attribute("#qhelp", "data-route") == "goal", "routes 'I want to be rich' to goal")
    check(pg.get_attribute("#clar", "data-c") == "vague", "flags it as vague")
    check(pg.locator(".qchip").count() >= 3, "shows hint chips")
    pg.click("#snext"); pg.wait_for_timeout(600)
    check(pg.locator(".sugg:not(.skel)").count() == 2, "Next on a vague question shows sharpen suggestions")
    check(pg.evaluate("+document.querySelector('.astep.on').dataset.s") == 1, "gate keeps user on step 1")
    pg.screenshot(path=str(SHOTS / "2-light-helper.png"), full_page=False)
    pg.locator(".sugg").first.click(); pg.wait_for_timeout(200)
    check("[" in pg.input_value("#q"), "suggestion fills in with placeholders")
    pg.click("#snext"); pg.wait_for_timeout(200)
    check(pg.evaluate("+document.querySelector('.astep.on').dataset.s") == 1, "placeholders block Next")
    pg.fill("#q", "Can I build ₹2 crore in investments by 2032, starting from ₹15 lakh?")
    pg.click("#snext"); pg.wait_for_timeout(300)
    check(pg.evaluate("+document.querySelector('.astep.on').dataset.s") == 2, "advances to step 2")
    check(pg.inner_text("#lbl-ctx") == "Where you are today", "step 2 relabels for goals")
    check(pg.is_visible("#run"), "goal route has 2 steps (run on step 2)")
    pg.fill("#ctx", "Product designer, 9 yrs")
    pg.click("#run"); pg.wait_for_selector(".goalhead", timeout=8000); pg.wait_for_timeout(1500)
    check(pg.locator(".fcol").count() == 3, "goal result groups factors by control")
    check(pg.locator(".gpath.rec").count() == 1, "one recommended route")
    pg.screenshot(path=str(SHOTS / "3-light-goal.png"), full_page=True)

    # dark
    pg.click("#themeBtn"); pg.wait_for_timeout(500)
    check(pg.evaluate("document.documentElement.dataset.theme") == "dark", "theme switches to dark")
    pg.screenshot(path=str(SHOTS / "4-dark-goal.png"), full_page=True)
    pg.click("#themeBtn")
    check(pg.evaluate("document.documentElement.dataset.theme") is None, "theme back to auto")

    # forecast routing
    pg.click("#editBtn"); pg.fill("#q", "Will gold trade above $3,000 by March 2027?"); pg.wait_for_timeout(200)
    check(pg.get_attribute("#qhelp", "data-route") == "forecast", "routes gold question to forecast")
    check(pg.get_attribute("#clar", "data-c") == "sharp", "gold question is sharp")
    pg.fill("#q", "Will I get a job abroad?"); pg.wait_for_timeout(100)
    check(pg.get_attribute("#qhelp", "data-route") == "goal", "'Will I get a job abroad' routes to goal")
    pg.fill("#q", "When will I get married?"); pg.wait_for_timeout(100)
    check(pg.get_attribute("#qhelp", "data-route") == "forecast", "marriage question stays forecast (chart flow)")
    pg.click("#swRoute"); pg.wait_for_timeout(100)
    check(pg.get_attribute("#qhelp", "data-route") == "goal", "manual route switch works")

    # history row for the saved goal
    pg.click("#tab-history"); pg.wait_for_timeout(600)
    check(pg.locator(".goalrow").count() >= 1, "goal saved to history")
    pg.screenshot(path=str(SHOTS / "5-history.png"))
    b.close()

check(not errors, "no page errors" + (": " + "; ".join(errors[:3]) if errors else ""))
print(f"\n{len(fails)} failed")
sys.exit(1 if fails else 0)

"""End-to-end check of the Ask flow with a mocked Claude runtime.

Covers: theme switch, prompt helper and router, clarify step, assessment, route
pick, sign-in consent and device-to-account handoff, plan, goal home (actions,
indicators, check-in), Goals list, Explore, forecast routing, anonymous limit.
Run: python3 tests/e2e.py  (writes screenshots to tests/shots/)
"""
import json, pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = ROOT / "tests" / "shots"
SHOTS.mkdir(exist_ok=True)

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from fixtures import SHARPEN, GOAL, CLARIFY, PLAN, CHECKIN

MOCK = """
window.__MOCK__=%s;
const DB={};window.__DB=DB;
const col=path=>({doc:id=>({id,get:async()=>({exists:!!DB[path+"/"+id],data:()=>DB[path+"/"+id]}),set:async d=>{DB[path+"/"+id]=JSON.parse(JSON.stringify(d))},update:async d=>{Object.assign(DB[path+"/"+id],d)},delete:async()=>{delete DB[path+"/"+id]}}),
 orderBy(){return this},limit(){return this},where(){return this},
 get:async()=>({docs:Object.keys(DB).filter(k=>k.startsWith(path+"/")&&!k.slice(path.length+1).includes("/")).map(k=>({id:k,data:()=>DB[k]}))})});
const sample=(()=>{const f=async()=>({text:""});f.json=async(p,o)=>{
  const M=window.__MOCK__;const r=/You help people ask Trikala/.test(p)?M.sharpen:/follow-up questions that matter most/.test(p)?M.clarify:/turn a chosen route into a practical plan/.test(p)?M.plan:/goal engine/.test(p)?(/CHECK-IN:/.test(p)?M.checkin:M.goal):null;
  if(o&&o.onText){const t=JSON.stringify(r||{});for(let i=0;i<4;i++){await new Promise(z=>setTimeout(z,40));o.onText({text:t.slice(0,t.length*(i+1)/4)})}}
  if(!r)throw{code:"upstream_error"};return JSON.parse(JSON.stringify(r))};return f})();
window.claude={use:async n=>n==="sample"?sample:n==="db"?{collection:col}:n==="user"?{me:async()=>({id:"u1",name:"Tester"}),id:async()=>"u1",isOwner:async()=>true,can:async()=>true}:null};
""" % json.dumps({"sharpen": SHARPEN, "goal": GOAL, "clarify": CLARIFY, "plan": PLAN, "checkin": CHECKIN})

def boot(pg):
    pg.goto((ROOT / "public" / "index.html").as_uri())
    pg.wait_for_timeout(1500)
    for _ in range(4):  # dismiss consent, prologue and welcome sheets, whatever order they appear in
        pg.evaluate("""['.cn button','.pro-skip','#wskip','#wskip2'].forEach(s=>{const e=document.querySelector(s);if(e&&e.offsetParent)e.click()})""")
        pg.wait_for_timeout(500)
    pg.evaluate("document.querySelectorAll('.pre,#pre').forEach(e=>e.remove())")

step = lambda pg: pg.evaluate("+document.querySelector('.astep.on').dataset.s")

errors, fails = [], []
def check(cond, msg):
    (print("  ok  ", msg) if cond else (fails.append(msg), print("  FAIL", msg)))

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    pg.add_init_script(MOCK)
    pg.on("pageerror", lambda e: errors.append(str(e)))
    boot(pg)

    # theme: auto -> light
    pg.click("#themeBtn"); pg.wait_for_timeout(400)
    check(pg.evaluate("document.documentElement.dataset.theme") == "light", "theme switches to light")
    check(pg.locator("#tab-goals").count() == 1 and pg.locator("#tab-explore").count() == 1, "tabs are Ask, Goals, Forecasts, Explore")
    pg.screenshot(path=str(SHOTS / "1-light-ask.png"))

    # helper on a vague goal question
    pg.fill("#q", "I want to be rich"); pg.wait_for_timeout(200)
    check(pg.get_attribute("#qhelp", "data-route") == "goal", "routes 'I want to be rich' to goal")
    check(pg.get_attribute("#clar", "data-c") == "vague", "flags it as vague")
    pg.click("#snext"); pg.wait_for_timeout(600)
    check(pg.locator(".sugg:not(.skel)").count() == 2, "Next on a vague question shows sharpen suggestions")
    check(step(pg) == 1, "gate keeps user on step 1")
    pg.locator(".sugg").first.click(); pg.wait_for_timeout(200)
    pg.click("#snext"); pg.wait_for_timeout(200)
    check(step(pg) == 1, "placeholders block Next")

    # clarify step
    pg.fill("#q", "Can I build ₹2 crore in investments by 2032, starting from ₹15 lakh?")
    pg.click("#snext"); pg.wait_for_timeout(600)
    check(step(pg) == 4, "goal route goes to the clarify step")
    check(pg.locator(".clq").count() == 3, "clarify shows tailored questions")
    pg.locator(".clq").nth(0).locator(".clopt").nth(2).click()
    pg.locator(".clq").nth(1).locator(".clin").fill("Lead product designer, 9 years")
    pg.screenshot(path=str(SHOTS / "2-clarify.png"))
    pg.click("#run"); pg.wait_for_selector(".goalhead", timeout=8000); pg.wait_for_timeout(1200)
    check(pg.locator(".fcol").count() == 3, "assessment groups factors by control")
    check(pg.locator(".pickroute[data-route]").count() == 2, "every route offers 'Make this my plan'")
    check("Lead product designer" in pg.inner_text(".gused"), "'What we used about you' lists the answers")
    check(pg.evaluate("JSON.parse(localStorage.getItem('trikala.goals')||'[]').length") == 1, "anonymous answer kept on the device")
    pg.screenshot(path=str(SHOTS / "3-assessment.png"), full_page=True)

    # make this my plan -> sign-in -> plan -> goal home
    pg.locator(".pickroute.main").click(); pg.wait_for_timeout(400)
    check(pg.is_visible("#signin"), "picking a route asks for sign-in")
    pg.screenshot(path=str(SHOTS / "4-signin.png"))
    pg.click("#siGo"); pg.wait_for_timeout(200)
    check("Tick the box" in pg.inner_text("#siErr"), "consent is required")
    pg.check("#siConsent"); pg.click("#siGo")
    pg.wait_for_selector("#goalDetail", timeout=8000); pg.wait_for_timeout(600)
    keys = pg.evaluate("Object.keys(window.__DB).filter(k=>k.startsWith('data/users/u1/goals/'))")
    check(len(keys) == 1, "goal moved to the account after sign-in")
    check(pg.evaluate("JSON.parse(localStorage.getItem('trikala.goals')||'[]').length") == 0, "device copy cleared")
    prof = pg.evaluate("(Object.entries(window.__DB).find(([k])=>k.endsWith('/profile/main'))||[0,{}])[1]")
    check(prof.get("consent", {}).get("tracking") is True, "consent recorded on the profile")
    check(prof.get("facts", {}).get("role", "").startswith("Lead product"), "clarify answers became profile facts")
    check(pg.locator(".gtodo").count() == 3, "plan actions listed on goal home")
    check(pg.locator(".hrow2").count() == 6, "health shows six dimensions before the first check-in")

    # act, log, check in
    pg.locator(".gtodo input").first.check(); pg.wait_for_timeout(300)
    done = pg.evaluate("Object.entries(window.__DB).find(([k])=>k.startsWith('data/users/u1/goals/'))[1].actions.filter(a=>a.status==='done').length")
    check(done == 1, "ticking an action saves it")
    pg.locator("input[data-ind]").first.fill("₹40,000"); pg.locator("button[data-gact='log']").first.click(); pg.wait_for_timeout(300)
    check("₹40,000" in pg.inner_text("#goalDetail"), "indicator reading logged")
    pg.click("[data-gact='checkin-open']"); pg.fill("#ciNotes", "Raised SIP, moved debt funds"); pg.click("[data-gact='checkin-run']")
    pg.wait_for_selector(".ctag.you", timeout=8000); pg.wait_for_timeout(500)
    check(pg.locator(".ghrow").count() == 2, "check-in adds a second assessment")
    check(pg.locator(".hrow2").count() == 7, "momentum appears after a check-in")
    pg.screenshot(path=str(SHOTS / "5-goal-home.png"), full_page=True)
    pg.evaluate("document.getElementById('themeBtn').click()"); pg.wait_for_timeout(400)
    pg.screenshot(path=str(SHOTS / "6-goal-home-dark.png"), full_page=True)
    pg.evaluate("document.getElementById('themeBtn').click()"); pg.wait_for_timeout(200)
    pg.click("[data-gact='back']"); pg.wait_for_timeout(300)
    check(pg.locator(".gcard2").count() == 1, "goal listed in Goals")
    pg.screenshot(path=str(SHOTS / "7-goals-list.png"))

    # forecasts and explore
    pg.click("#tab-history"); pg.wait_for_timeout(400)
    check("₹2 crore" not in pg.inner_text("#history"), "goals no longer appear in Forecasts")
    pg.click("#tab-explore"); pg.wait_for_timeout(300)
    check(pg.is_visible("#page-explore"), "Explore page opens")
    pg.locator(".xcard[data-go='trends']").click(); pg.wait_for_timeout(300)
    check(pg.is_visible("#page-trends") and pg.get_attribute("#tab-explore", "aria-selected") == "true", "Trends opens under Explore")

    # forecast routing still works
    pg.click("#tab-ask"); pg.wait_for_timeout(200)
    pg.click("#editBtn"); pg.wait_for_timeout(200)
    pg.fill("#q", "Will gold trade above $3,000 by March 2027?"); pg.wait_for_timeout(200)
    check(pg.get_attribute("#qhelp", "data-route") == "forecast", "routes gold question to forecast")
    pg.fill("#q", "When will I get married?"); pg.wait_for_timeout(100)
    check(pg.get_attribute("#qhelp", "data-route") == "forecast", "marriage question stays forecast (chart flow)")

    # anonymous limit in a fresh browser
    ctx2 = b.new_context(viewport={"width": 390, "height": 844}); pg2 = ctx2.new_page(); pg2.add_init_script(MOCK)
    pg2.on("pageerror", lambda e: errors.append(str(e)))
    boot(pg2)
    pg2.evaluate("localStorage.setItem('trikala.anon',JSON.stringify({d:new Date().toISOString().slice(0,10),n:5}))")
    pg2.fill("#q", "Can I save ₹50 lakh by 2030 from ₹10 lakh today?"); pg2.click("#snext"); pg2.wait_for_timeout(600)
    pg2.click("#run"); pg2.wait_for_timeout(400)
    check(pg2.is_visible("#signin"), "daily anonymous limit asks for sign-in")
    ctx2.close()
    b.close()

check(not errors, "no page errors" + (": " + "; ".join(errors[:3]) if errors else ""))
print(f"\n{len(fails)} failed")
sys.exit(1 if fails else 0)

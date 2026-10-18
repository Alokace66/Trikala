"""Canned model answers shared by the e2e tests (claude.ai mock and Gemini mock)."""
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

CLARIFY = {"questions": [
    {"id": "q1", "q": "How much do you invest each month now?", "type": "choice", "options": ["Under ₹10k", "₹10–25k", "₹25–50k", "Over ₹50k"], "key": "savings"},
    {"id": "q2", "q": "What's your current role?", "type": "text", "placeholder": "e.g. Lead designer", "key": "role"},
    {"id": "q3", "q": "How much risk can you take?", "type": "choice", "options": ["Low", "Medium", "High"], "key": "constraints"}]}
PLAN = {"milestones": [{"when": "By Dec 2026", "milestone": "SIP raised to ₹40k", "checkpoint": "Mandate live"},
                       {"when": "By Jun 2027", "milestone": "Role offer at 30% higher pay", "checkpoint": "Two final rounds"}],
        "actions": [{"action": "Raise SIP to ₹40k this month", "why": "Biggest controllable lever", "impact": "high", "effort": "low"},
                    {"action": "Shortlist 10 companies that pay 30% more", "why": "Income drives the plan", "impact": "high", "effort": "medium"},
                    {"action": "Move debt funds into an index fund", "why": "8-year horizon", "impact": "medium", "effort": "low"}],
        "indicators": [{"name": "Monthly amount invested", "why": "Leading signal for the target", "trigger": "Below ₹30k two months running"},
                       {"name": "Interview calls per month", "why": "Shows the income route is working", "trigger": "Zero calls for 6 weeks"}],
        "checkinDays": 30}
CHECKIN = dict(GOAL, opportunity="high", headline="Your higher SIP moved you up a band.",
               change={"summary": "Odds improved from moderate to high.", "personal": "You raised your SIP and moved out of debt funds.", "external": "Markets were flat, so they didn't help or hurt."},
               health={"feasibility": "high", "control": "high", "readiness": "medium", "risk": "low", "pathEfficiency": "medium", "timing": "medium"})
GOAL["health"] = {"feasibility": "medium", "control": "high", "readiness": "medium", "risk": "medium", "pathEfficiency": "medium", "timing": "medium"}

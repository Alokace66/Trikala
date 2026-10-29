#!/usr/bin/env bash
# One-shot setup and deploy of Trikala to Google Cloud.
# Run from the repo root, in Cloud Shell or anywhere gcloud is logged in:
#   ./deploy/deploy.sh            (uses the current or first project; or set PROJECT_ID=...)
# Optional: REGION (default asia-south1), SERVICE (default trikala), TELEGRAM_BOT_TOKEN (usage alerts),
#           DAILY_TOKEN_BUDGET / USER_DAILY_TOKENS (token limits; also editable on /admin),
#           GEMINI_API_KEY (use an AI Studio key instead of Vertex AI), MIN_INSTANCES (default 1).
# Safe to re-run: every step checks before it creates.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
[ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ] && PROJECT_ID="$(gcloud projects list --format='value(projectId)' --limit=1)"
[ -n "$PROJECT_ID" ] || { echo "No Google Cloud project found. Create one in the console, then re-run."; exit 1; }
echo "Using project: $PROJECT_ID"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-trikala}"
MIN_INSTANCES="${MIN_INSTANCES:-1}"
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
TOKEN() { gcloud auth print-access-token; }
api() { # method url [json]
  curl -sS -X "$1" "$2" -H "Authorization: Bearer $(TOKEN)" -H "x-goog-user-project: $PROJECT_ID" \
    -H "Content-Type: application/json" ${3:+--data "$3"}
}
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

# Clean public address: a Firebase Hosting site (e.g. https://trikala.web.app) that forwards to Cloud Run,
# so the region never shows in the link. The service still runs in $REGION.
HOST_API="https://firebasehosting.googleapis.com/v1beta1"
setup_hosting() {
  say "Clean address (Firebase Hosting)"
  gcloud services enable firebasehosting.googleapis.com --quiet
  SITE="${SITE:-}"
  if [ -z "$SITE" ]; then
    SITE="$(api GET "$HOST_API/projects/$PROJECT_ID/sites" \
      | json "next((s['name'].split('/')[-1] for s in d.get('sites',[]) if s.get('type')!='DEFAULT_SITE' and s['name'].split('/')[-1].startswith('trikala')),'')")"
  fi
  if [ -z "$SITE" ]; then
    for TRY in trikala trikala-app trikala-foresight trikala-forecasting "trikala-${PROJECT_NUMBER: -6}"; do
      if api POST "$HOST_API/projects/$PROJECT_ID/sites?siteId=$TRY" '{}' | grep -q '"defaultUrl"'; then SITE="$TRY"; break; fi
    done
  fi
  [ -n "$SITE" ] || { echo "!! Couldn't reserve a web.app name; set SITE=your-name and re-run."; return 0; }
  VERSION="$(api POST "$HOST_API/sites/$SITE/versions" \
    "{\"config\":{\"rewrites\":[{\"glob\":\"**\",\"run\":{\"serviceId\":\"$SERVICE\",\"region\":\"$REGION\"}}]}}" | json "d['name']")"
  api PATCH "$HOST_API/$VERSION?update_mask=status" '{"status":"FINALIZED"}' >/dev/null
  api POST "$HOST_API/sites/$SITE/releases?versionName=$VERSION" '{}' >/dev/null
  PUBLIC_URL="https://$SITE.web.app"
  echo "site $SITE -> $SERVICE ($REGION)"

  # Let sign-in work on the new address.
  DOMS="$(api GET "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config" \
    | python3 -c "import json,sys; d=json.load(sys.stdin).get('authorizedDomains',[]); [d.append(x) for x in sys.argv[1:] if x not in d]; print(json.dumps({'authorizedDomains':d}))" \
      "$SITE.web.app" "$SITE.firebaseapp.com")"
  api PATCH "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config?updateMask=authorizedDomains" "$DOMS" >/dev/null \
    && echo "sign-in allowed on $SITE.web.app"

  # Long AI calls go straight to the service (Hosting stops forwarding after 60s); allow the new address to call it.
  RUN_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
  gcloud run services update "$SERVICE" --region "$REGION" --quiet \
    --update-env-vars "^@^PUBLIC_API_BASE=$RUN_URL@ALLOWED_ORIGINS=https://$SITE.web.app,https://$SITE.firebaseapp.com" >/dev/null
  echo "direct API calls allowed from $PUBLIC_URL"
}

# Usage tracking: admin key, Firestore access for the service, Telegram alerts.
setup_usage() {
  say "Usage tracking and alerts"
  SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role="roles/datastore.user" \
    --condition=None --quiet >/dev/null 2>&1 && echo "service can record usage in Firestore" || echo "!! couldn't grant Firestore access"
  CUR="$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json 2>/dev/null \
    | python3 -c "import json,sys
try: e={x['name']:x.get('value','') for x in json.load(sys.stdin)['spec']['template']['spec']['containers'][0].get('env',[])}
except Exception: e={}
print(e.get('ADMIN_KEY',''), e.get('TELEGRAM_BOT_TOKEN',''))")"
  ADMIN_KEY="${ADMIN_KEY:-$(echo "$CUR" | cut -d' ' -f1)}"
  [ -n "$ADMIN_KEY" ] || ADMIN_KEY="$(python3 -c 'import secrets;print(secrets.token_urlsafe(18))')"
  TG="${TELEGRAM_BOT_TOKEN:-$(echo "$CUR" | cut -s -d' ' -f2)}"
  VARS="ADMIN_KEY=$ADMIN_KEY@PUBLIC_URL=${PUBLIC_URL:-}"
  [ -n "$TG" ] && VARS="$VARS@TELEGRAM_BOT_TOKEN=$TG"
  [ -n "${DAILY_TOKEN_BUDGET:-}" ] && VARS="$VARS@DAILY_TOKEN_BUDGET=$DAILY_TOKEN_BUDGET"
  [ -n "${USER_DAILY_TOKENS:-}" ] && VARS="$VARS@USER_DAILY_TOKENS=$USER_DAILY_TOKENS"
  gcloud run services update "$SERVICE" --region "$REGION" --quiet --update-env-vars "^@^$VARS" >/dev/null
  RUN_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
  if [ -n "$TG" ]; then
    HOOK="$(python3 -c "import hashlib,sys;print(hashlib.sha256(('tg:'+sys.argv[1]).encode()).hexdigest()[:24])" "$ADMIN_KEY")"
    curl -sS "https://api.telegram.org/bot$TG/setWebhook" --data-urlencode "url=$RUN_URL/api/tg/$HOOK" \
      --data-urlencode 'allowed_updates=["message","callback_query"]' | grep -q '"ok":true' \
      && echo "Telegram alerts connected" || echo "!! Telegram webhook failed; check TELEGRAM_BOT_TOKEN"
    BOT="$(curl -sS "https://api.telegram.org/bot$TG/getMe" | python3 -c "import json,sys;print(json.load(sys.stdin).get('result',{}).get('username',''))" 2>/dev/null)"
  fi
  DASH="${PUBLIC_URL:-$RUN_URL}/admin"
}
usage_note() {
  say "Usage dashboard: $DASH"
  echo "   Admin key: $ADMIN_KEY   (keep it private)"
  if [ -n "${BOT:-}" ]; then echo "   Phone alerts: open https://t.me/$BOT and send:  /start $ADMIN_KEY"
  elif [ -z "${TG:-}" ]; then echo "   Phone alerts: create a bot with @BotFather, then re-run with TELEGRAM_BOT_TOKEN=... ./deploy/deploy.sh app"; fi
}

if [ "${1:-}" = "app" ]; then
  say "Redeploying the app only (keeps existing settings)"
  gcloud run deploy "$SERVICE" --source . --region "$REGION" --min-instances 1 --max-instances 1 --quiet
  setup_hosting
  setup_usage
  say "Live at ${PUBLIC_URL:-$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')}"; usage_note; exit 0
fi

say "Enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  aiplatform.googleapis.com firestore.googleapis.com firebase.googleapis.com firebaserules.googleapis.com \
  identitytoolkit.googleapis.com --quiet

say "Firestore database"
if ! gcloud firestore databases describe --database='(default)' >/dev/null 2>&1; then
  gcloud firestore databases create --location="$REGION" --type=firestore-native --quiet
else echo "exists"; fi

say "Adding Firebase to the project"
if ! api GET "https://firebase.googleapis.com/v1beta1/projects/$PROJECT_ID" | grep -q '"projectId"'; then
  api POST "https://firebase.googleapis.com/v1beta1/projects/$PROJECT_ID:addFirebase" '{}' >/dev/null
  echo "requested; waiting 20s"; sleep 20
else echo "already a Firebase project"; fi

say "Firebase web app"
APP_ID="$(api GET "https://firebase.googleapis.com/v1beta1/projects/$PROJECT_ID/webApps" \
  | json "next((a['appId'] for a in d.get('apps',[]) if a.get('displayName')=='Trikala'),'')")"
if [ -z "$APP_ID" ]; then
  api POST "https://firebase.googleapis.com/v1beta1/projects/$PROJECT_ID/webApps" '{"displayName":"Trikala"}' >/dev/null
  for i in 1 2 3 4 5 6; do
    sleep 5
    APP_ID="$(api GET "https://firebase.googleapis.com/v1beta1/projects/$PROJECT_ID/webApps" \
      | json "next((a['appId'] for a in d.get('apps',[]) if a.get('displayName')=='Trikala'),'')")"
    [ -n "$APP_ID" ] && break
  done
fi
CFG="$(api GET "https://firebase.googleapis.com/v1beta1/projects/$PROJECT_ID/webApps/$APP_ID/config")"
FB_API_KEY="$(echo "$CFG" | json "d['apiKey']")"
FB_AUTH_DOMAIN="$(echo "$CFG" | json "d.get('authDomain','')")"
echo "web app $APP_ID"

say "Anonymous sign-in"
OUT="$(api PATCH "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config?updateMask=signIn.anonymous.enabled" \
  '{"signIn":{"anonymous":{"enabled":true}}}')"
if echo "$OUT" | grep -q '"error"'; then
  api POST "https://identitytoolkit.googleapis.com/v2/projects/$PROJECT_ID/identityPlatform:initializeAuth" '{}' >/dev/null || true
  OUT="$(api PATCH "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config?updateMask=signIn.anonymous.enabled" \
    '{"signIn":{"anonymous":{"enabled":true}}}')"
fi
if echo "$OUT" | grep -q '"error"'; then
  echo "!! Couldn't turn on anonymous sign-in automatically."
  echo "   Firebase console > Authentication > Get started > Sign-in method > Anonymous > Enable."
else echo "enabled"; fi

say "Firestore security rules"
RULES_JSON="$(python3 -c "import json;print(json.dumps({'source':{'files':[{'name':'firestore.rules','content':open('firestore.rules').read()}]}}))")"
RULESET="$(api POST "https://firebaserules.googleapis.com/v1/projects/$PROJECT_ID/rulesets" "$RULES_JSON" | json "d['name']")"
REL="projects/$PROJECT_ID/releases/cloud.firestore"
if api GET "https://firebaserules.googleapis.com/v1/$REL" | grep -q '"rulesetName"'; then
  api PATCH "https://firebaserules.googleapis.com/v1/$REL" "{\"release\":{\"name\":\"$REL\",\"rulesetName\":\"$RULESET\"}}" >/dev/null
else
  api POST "https://firebaserules.googleapis.com/v1/projects/$PROJECT_ID/releases" "{\"name\":\"$REL\",\"rulesetName\":\"$RULESET\"}" >/dev/null
fi
echo "released $RULESET"

say "Gemini access for the Cloud Run service account"
SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role="roles/aiplatform.user" \
  --condition=None --quiet >/dev/null
echo "$SA can call Vertex AI"

say "Build permissions for Cloud Run source deploys"
# New projects no longer give the default compute account Editor, so builds can't read the uploaded source.
for ROLE in roles/run.builder roles/storage.objectViewer roles/artifactregistry.writer roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role="$ROLE" \
    --condition=None --quiet >/dev/null 2>&1 && echo "granted $ROLE" || echo "skipped $ROLE"
done
echo "waiting 45s for permissions to take effect"; sleep 45

say "Deploying to Cloud Run ($REGION)"
ENV="GOOGLE_CLOUD_PROJECT=$PROJECT_ID,FIREBASE_API_KEY=$FB_API_KEY,FIREBASE_AUTH_DOMAIN=$FB_AUTH_DOMAIN,FIREBASE_PROJECT_ID=$PROJECT_ID,FIREBASE_APP_ID=$APP_ID"
[ -n "${GEMINI_MODEL:-}" ] && ENV="$ENV,GEMINI_MODEL=$GEMINI_MODEL"
[ -n "${GEMINI_MODEL_QUICK:-}" ] && ENV="$ENV,GEMINI_MODEL_QUICK=$GEMINI_MODEL_QUICK"
[ -n "${GEMINI_API_KEY:-}" ] && ENV="$ENV,GEMINI_API_KEY=$GEMINI_API_KEY"
gcloud run deploy "$SERVICE" --source . --region "$REGION" --allow-unauthenticated \
  --min-instances "$MIN_INSTANCES" --max-instances 1 --concurrency 40 --timeout 120 --memory 512Mi \
  --update-env-vars "$ENV" --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"

say "Smoke test"
curl -sS "$URL/api/health"; echo
curl -sS -X POST "$URL/api/generate" -H 'Content-Type: application/json' \
  -d '{"prompt":"Reply with JSON {\"ok\":true,\"engine\":\"gemini\"} and nothing else.","tier":"quick"}'; echo

setup_hosting
setup_usage
say "Live at ${PUBLIC_URL:-$URL}"
usage_note

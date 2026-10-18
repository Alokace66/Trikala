#!/usr/bin/env bash
# One-shot setup and deploy of Trikala to Google Cloud.
# Run from the repo root, in Cloud Shell or anywhere gcloud is logged in:
#   PROJECT_ID=my-project ./deploy/deploy.sh
# Optional: REGION (default asia-south1), SERVICE (default trikala),
#           GEMINI_API_KEY (use an AI Studio key instead of Vertex AI), MIN_INSTANCES (default 1).
# Safe to re-run: every step checks before it creates.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
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

say "Deploying to Cloud Run ($REGION)"
ENV="GOOGLE_CLOUD_PROJECT=$PROJECT_ID,FIREBASE_API_KEY=$FB_API_KEY,FIREBASE_AUTH_DOMAIN=$FB_AUTH_DOMAIN,FIREBASE_PROJECT_ID=$PROJECT_ID,FIREBASE_APP_ID=$APP_ID"
[ -n "${GEMINI_MODEL:-}" ] && ENV="$ENV,GEMINI_MODEL=$GEMINI_MODEL"
[ -n "${GEMINI_MODEL_QUICK:-}" ] && ENV="$ENV,GEMINI_MODEL_QUICK=$GEMINI_MODEL_QUICK"
[ -n "${GEMINI_API_KEY:-}" ] && ENV="$ENV,GEMINI_API_KEY=$GEMINI_API_KEY"
gcloud run deploy "$SERVICE" --source . --region "$REGION" --allow-unauthenticated \
  --min-instances "$MIN_INSTANCES" --max-instances 3 --concurrency 40 --timeout 120 --memory 512Mi \
  --set-env-vars "$ENV" --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"

say "Smoke test"
curl -sS "$URL/healthz"; echo
curl -sS -X POST "$URL/api/generate" -H 'Content-Type: application/json' \
  -d '{"prompt":"Reply with JSON {\"ok\":true,\"engine\":\"gemini\"} and nothing else.","tier":"quick"}'; echo

say "Live at $URL"

#!/usr/bin/env bash
#
# Prints the environment variables to paste into Render's dashboard, read
# from your local server/.env.
#
# Exists because hand-copying a MongoDB URI and three API keys between a file
# and a web form is exactly the kind of task that produces a single wrong
# character and a deploy that fails for no visible reason.
#
# Values are printed to YOUR terminal only. Nothing is sent anywhere.
#
#   bash server/scripts/print-deploy-env.sh

set -euo pipefail

ENV_FILE="$(dirname "$0")/../.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "No server/.env found. Copy .env.example to .env and fill it in first." >&2
  exit 1
fi

read_var() {
  # Last occurrence wins, matching how dotenv itself resolves duplicates.
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true
}

# Set in the Render dashboard under Environment. These are the keys marked
# `sync: false` in render.yaml, which is why Render does not expect them in
# the file.
KEYS=(
  MONGODB_URI
  JWT_ACCESS_SECRET
  GEMINI_API_KEY
  GROQ_API_KEY
  UPSTASH_REDIS_REST_URL
  UPSTASH_REDIS_REST_TOKEN
  SENTRY_DSN
)

echo
echo "Paste these into Render → your service → Environment"
echo "───────────────────────────────────────────────────────"

missing=()

for key in "${KEYS[@]}"; do
  value="$(read_var "$key")"

  if [[ -z "$value" ]]; then
    missing+=("$key")
    continue
  fi

  printf '%s=%s\n' "$key" "$value"
done

echo
echo "Plus one you can only fill in after Vercel gives you a URL:"
echo "CORS_ORIGINS=https://<your-project>.vercel.app"
echo

if (( ${#missing[@]} > 0 )); then
  echo "Not set locally (optional ones are fine to skip):"
  for key in "${missing[@]}"; do
    echo "  - $key"
  done
  echo
fi

echo "Reminder: MONGODB_URI must end with the database name (/papertrail),"
echo "otherwise Mongoose silently writes everything to a database called 'test'."
echo

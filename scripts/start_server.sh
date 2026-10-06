#!/bin/bash
set -euo pipefail
APP_DIR="/home/ubuntu/aerwell-api"
ENV_FILE="/home/ubuntu/aerwell-api/.env"
APP_NAME="aerwell-api"
command -v npm >/dev/null
command -v pm2 >/dev/null
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing per-application environment file: $ENV_FILE" >&2
  exit 1
fi
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
# Recreate only this process so an old PM2 environment cannot override its .env.
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then pm2 delete "$APP_NAME"; fi
# Never source a .env. dotenv loads the file inside this application's cwd, and a
# value inherited from this shell would win over it (and be baked into pm2).
# Every key of src/config/env.ts is listed (env.test.ts fails if one is missing).
STRIP=(-u NODE_ENV -u PORT -u HOST -u MONGODB_URI -u CORS_ORIGIN
  -u RATE_LIMIT_WINDOW_MS -u RATE_LIMIT_MAX -u ALFRED_API_INTERNAL_URL
  -u ALFRED_AUTH_URL -u ALFRED_AUTH_JWKS_URL -u ALFRED_AUTH_CLIENT_ID
  -u ALFRED_AUTH_CLIENT_SECRET -u STAFF_JWT_SECRET -u AWS_REGION -u AWS_S3_BUCKET
  -u SES_FROM_EMAIL -u ADMIN_BASE_URL -u PUBLIC_API_URL -u AERWELL_ORG_ID -u STRIPE_SECRET_KEY
  -u STRIPE_PUBLISHABLE_KEY -u STRIPE_WEBHOOK_SECRET -u TRANSCRIBE_REGION
  -u BEDROCK_REGION -u BEDROCK_MODEL_FAST -u BEDROCK_MODEL_SMART
  -u PARTNER_CONTRACT_ENABLED -u ALFRED_PARTNER_AUDIENCE -u ALFRED_PARTNER_ORG_ID
  -u ALFRED_API_URL -u PARTNER_OUTBOX_ENABLED -u PARTNER_OUTBOX_INTERVAL_MS
  -u PARTNER_OUTBOX_BATCH_SIZE -u PARTNER_OUTBOX_MAX_ATTEMPTS
  -u PARTNER_OUTBOX_PUBLISH_TIMEOUT_MS
  # The app's AWS principal is IAM user aerwell (keys in the .env). An inherited
  # key or profile (the box also runs everhaus-api/alfred-api) would win silently.
  -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u AWS_PROFILE )
# Indexes BEFORE traffic: webhook dedupe and booking idempotency rely on unique indexes.
env "${STRIP[@]}" npm run db:sync-indexes
# --kill-timeout: SIGINT drains live visit captures (flush + save) before exit.
env "${STRIP[@]}" pm2 start dist/index.js --name "$APP_NAME" --cwd "$APP_DIR" \
  --restart-delay=3000 --max-restarts=5 --kill-timeout=50000 --time
pm2 save

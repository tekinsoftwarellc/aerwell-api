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
# Never source a .env. dotenv loads the file inside this application's cwd.
env -u NODE_ENV -u PORT -u HOST -u MONGODB_URI -u CORS_ORIGIN \
  -u RATE_LIMIT_WINDOW_MS -u RATE_LIMIT_MAX -u ALFRED_AUTH_URL \
  -u ALFRED_AUTH_JWKS_URL -u ALFRED_AUTH_CLIENT_ID -u ALFRED_AUTH_CLIENT_SECRET \
  -u AERWELL_ORG_ID -u ALFRED_API_INTERNAL_URL \
  pm2 start dist/index.js --name "$APP_NAME" --cwd "$APP_DIR" \
  --restart-delay=3000 --max-restarts=5 --time
pm2 save

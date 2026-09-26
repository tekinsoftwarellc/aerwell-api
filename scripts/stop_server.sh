#!/bin/bash
set -euo pipefail
APP_NAME="aerwell-api"
if command -v pm2 >/dev/null 2>&1 && pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 stop "$APP_NAME"
fi

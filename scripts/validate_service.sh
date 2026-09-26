#!/bin/bash
set -euo pipefail
HEALTH_URL="http://127.0.0.1:3003/api/v1/health"
READY_URL="http://127.0.0.1:3003/api/v1/health/ready"
for attempt in $(seq 1 20); do
  if curl --silent --show-error --fail --max-time 1 "$HEALTH_URL" >/dev/null \
    && curl --silent --show-error --fail --max-time 1 "$READY_URL" >/dev/null; then
    echo "Aerwell API health and Mongo readiness passed on port 3003."
    exit 0
  fi
  echo "Waiting for Aerwell API (${attempt}/20)."
  sleep 3
done
echo "Aerwell API health check failed." >&2
exit 1

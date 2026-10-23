#!/bin/sh
# Container entrypoint: what start_server.sh did before `pm2 start` on EC2.
#   1. sync indexes (unique/partial-unique indexes must exist before traffic); a failure
#      exits non-zero so the task never serves without them. SKIP_INDEX_SYNC=1 skips it
#      (emergency only; one-off tasks tolerate the idempotent sync).
#   2. exec the command (the server, or a one-off `node dist/scripts/*.js`).
# SYNC_CMD overrides the sync command for container-entrypoint.test.mjs.
set -eu

if [ "${SKIP_INDEX_SYNC:-}" != "1" ]; then
  ${SYNC_CMD:-node dist/scripts/sync-indexes.js}
fi

exec "$@"

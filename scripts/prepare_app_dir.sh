#!/bin/bash
set -euo pipefail
APP_DIR="/home/ubuntu/aerwell-api"
mkdir -p "$APP_DIR"
chown -R ubuntu:ubuntu "$APP_DIR"
if [ -d "$APP_DIR/scripts" ]; then
  find "$APP_DIR/scripts" -type f -name '*.sh' -exec chmod 755 {} +
fi

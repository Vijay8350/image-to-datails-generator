#!/usr/bin/env bash
# Redeploy: pull latest from GitHub, install prod deps, restart under pm2.
# .env is gitignored, so local secrets survive a pull.
set -euo pipefail
cd "$(dirname "$0")"
echo "==> pulling"
git pull --ff-only origin main
echo "==> installing production deps"
npm ci --omit=dev
echo "==> restarting"
pm2 restart meesho-listing --update-env
sleep 2
echo "==> health"
curl -fsS http://127.0.0.1:3000/api/health && echo
echo "==> done: https://ship.apanjob.com/meesho/"

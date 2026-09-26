#!/bin/bash
# Выкладка новой версии на сервер (рядом со старой игрой, порт 8788).
#   ./deploy/deploy.sh [root@82.97.249.219]
set -euo pipefail
HOST="${1:-root@82.97.249.219}"
cd "$(dirname "$0")/.."
npx --yes esbuild@0.24.0 server/src/index.ts --bundle --platform=node --target=node20 --format=cjs --outfile=deploy/server.cjs --log-level=warning
(cd client && npx vite build)
rsync -az --delete client/dist/ "$HOST:/opt/castlefight3d/dist/"
rsync -az deploy/server.cjs deploy/castlefight3d.service "$HOST:/opt/castlefight3d/"
ssh "$HOST" 'set -e
  install -m 644 /opt/castlefight3d/castlefight3d.service /etc/systemd/system/castlefight3d.service
  chown -R castlefight3d:castlefight3d /opt/castlefight3d/dist /opt/castlefight3d/server.cjs
  systemctl daemon-reload
  systemctl enable --now castlefight3d.service
  systemctl restart castlefight3d.service
  sleep 1.5
  systemctl is-active castlefight3d.service
  curl -fsS http://127.0.0.1:8788/health && echo " health ok"'

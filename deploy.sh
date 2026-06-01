#!/bin/bash
set -euo pipefail

PROJECT_DIR="/root/arena-fps"
DEPLOY_DIR="/opt/arena-fps"
SERVICE_NAME="arena-fps"
PORT="${PORT:-7777}"

echo "=== Arena FPS Deploy ==="

# 0. Stop service
echo "[0/4] Stopping service..."
systemctl stop "$SERVICE_NAME" 2>/dev/null || true
sleep 1
# Kill anything still holding the port
kill $(lsof -ti:$PORT) 2>/dev/null || true
sleep 1

# 1. Copy source to deployment directory
echo "[1/4] Copying source..."
cp -a "$PROJECT_DIR/." "$DEPLOY_DIR/"
chown -R arena-fps:arena-fps "$DEPLOY_DIR"

# 2. Install dependencies
echo "[2/4] Installing dependencies..."
cd "$DEPLOY_DIR"
npm install --include=dev --silent

# 3. Build client + server
echo "[3/4] Building..."
npm run build 2>&1 | tail -3
npx tsc -p server/tsconfig.json 2>&1 | tail -3 || true

# 4. Start service
echo "[4/4] Starting service..."
systemctl start "$SERVICE_NAME"
sleep 2

# Health check
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${PORT}/ 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
    echo "Deploy complete. Service responding with HTTP $HTTP_CODE"
else
    echo "WARNING: Service returned HTTP $HTTP_CODE"
    systemctl status "$SERVICE_NAME" --no-pager | tail -5
fi

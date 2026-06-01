#!/bin/bash
set -euo pipefail

PROJECT_DIR="/root/arena-fps"
DEPLOY_DIR="/opt/arena-fps"
SERVICE_NAME="arena-fps"

echo "=== Arena FPS Deploy ==="

# 0. Stop service and free port
echo "[0/5] Stopping service..."
systemctl stop "$SERVICE_NAME" 2>/dev/null || true
sleep 1
# Kill anything still holding the port
kill $(lsof -ti:7777) 2>/dev/null || true
sleep 1

# 1. Copy source to deployment directory
echo "[1/5] Copying source..."
cp -a "$PROJECT_DIR/." "$DEPLOY_DIR/"
chown -R arena-fps:arena-fps "$DEPLOY_DIR"

# 2. Install dependencies
echo "[2/4] Installing dependencies..."
cd "$DEPLOY_DIR"
npm install --include=dev --silent

# 3. Build
echo "[3/5] Building..."
npm run build 2>&1 | tail -3

# 4. Restart service
echo "[4/5] Restarting service..."
systemctl restart "$SERVICE_NAME"
sleep 3

# 5. Health check
echo "[5/5] Health check..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7777/ 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
    echo "Deploy complete. Service responding with HTTP $HTTP_CODE"
else
    echo "WARNING: Service returned HTTP $HTTP_CODE"
    systemctl status "$SERVICE_NAME" --no-pager | tail -5
fi

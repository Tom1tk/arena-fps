/**
 * Arena FPS — Server entry point (M0 skeleton)
 *
 * Serves the static client build and hosts a WebSocket server.
 * Full lobby/match logic will be added in M5.
 */
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, '../../dist/client');

const PORT = Number(process.env.PORT || 3444);

// --- HTTP server (serves static files in production) ---
const mimeTypes: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  // In dev mode, Vite handles the client — just respond with a placeholder
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
    return;
  }

  // Serve static files from dist/client
  let filePath = path.join(CLIENT_DIST, url.pathname);

  // Fallback to index.html for SPA routing
  if (!fs.existsSync(filePath)) {
    filePath = path.join(CLIENT_DIST, 'index.html');
  }

  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

// --- WebSocket server ---
const wss = new WebSocketServer({ server });

console.log(`[Server] Starting on port ${PORT}`);

wss.on('connection', (ws: WebSocket) => {
  console.log('[WS] Client connected');

  ws.on('message', (data: WebSocket.Data) => {
    // Echo for now — binary protocol will be implemented in M5/M6
    console.log(`[WS] Received ${data.byteLength} bytes`);
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });

  ws.on('error', (err) => {
    console.error('[WS] Client error:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
  console.log(`[Server] Client dist: ${CLIENT_DIST}`);
});

// --- Graceful shutdown ---
process.on('SIGINT', () => {
  console.log('[Server] Shutting down...');
  wss.clients.forEach((ws) => ws.close());
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  console.log('[Server] Terminating...');
  wss.clients.forEach((ws) => ws.close());
  server.close(() => process.exit(0));
});

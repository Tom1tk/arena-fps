/**
 * Arena FPS — Server entry point
 *
 * M5: WebSocket server with lobby management.
 * - Room create → lobby code (5-char)
 * - Join by code with validation
 * - Ready/start gating (host can't ready, all must be ready)
 * - Host transfer on host leave
 * - Host disband on host leave when 0 players
 * - MAX_PLAYERS cap (8)
 * - Heartbeat keep-alive (25s, miss limit 3)
 */
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { LobbyManager } from './lobby.js';
import { GameWorld } from './gameWorld.js';
import { MAX_PLAYERS, NAME_MIN, NAME_MAX, HEARTBEAT_INTERVAL_S, HEARTBEAT_MISS_LIMIT, SERVER_TICK_HZ, TICK_DT } from '../../shared/constants.js';
import type { InputFrame } from '../../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Client dist is at <project_root>/dist/client — server JS is at <project_root>/dist/server/server/src/
const CLIENT_DIST = path.resolve(__dirname, '../../../client');

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
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      timestamp: Date.now(),
      rooms: lobbyManager.roomCount(),
      players: lobbyManager.totalPlayers(),
    }));
    return;
  }

  // Serve static files from dist/client
  let filePath = url.pathname === '/' ? path.join(CLIENT_DIST, 'index.html') : path.join(CLIENT_DIST, url.pathname);
  if (!fs.existsSync(filePath)) {
    // SPA fallback: serve index.html for any route that doesn't match a file
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
const lobbyManager = new LobbyManager();

console.log(`[Server] Starting on port ${PORT}`);

// --- Heartbeat timer ---
const heartbeatInterval = setInterval(() => {
  for (const client of wss.clients) {
    if ((client as any).__hbTimer) {
      (client as any).__hbTimer++;
      if ((client as any).__hbTimer >= HEARTBEAT_MISS_LIMIT) {
        console.log(`[WS] Heartbeat miss limit reached, disconnecting`);
        client.close(1001, 'Heartbeat timeout');
        continue;
      }
    }
    // Ping all clients
    if (client.readyState === WebSocket.OPEN) {
      client.ping();
    }
  }
}, HEARTBEAT_INTERVAL_S * 1000);

heartbeatInterval.unref(); // Don't keep process alive

wss.on('connection', (ws: WebSocket) => {
  console.log(`[WS] Client connected (${wss.clients.size} total)`);

  // Initialize heartbeat timer
  (ws as any).__hbTimer = 0;

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'welcome',
    version: '0.5.0',
    maxPlayers: MAX_PLAYERS,
    nameMin: NAME_MIN,
    nameMax: NAME_MAX,
  }));

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString()) as any;
      handleMessage(ws, msg);
    } catch (err) {
      console.error('[WS] Message parse error:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
    }
  });

  ws.on('pong', () => {
    // Reset heartbeat timer on pong
    (ws as any).__hbTimer = 0;
  });

  ws.on('close', (code: number, reason: Buffer) => {
    console.log(`[WS] Client disconnected (code: ${code})`);
    const result = lobbyManager.leaveRoom(ws);
    if (result.room) {
      // Handle game world disconnect
      if (result.room.gameWorld) {
        for (const player of result.room.gameWorld.players.values()) {
          if (player.ws === ws) {
            player.connected = false;
            break;
          }
        }
      }
      // Notify remaining players
      lobbyManager.broadcastRoster(result.room.code);
      if (result.room.players.size > 0) {
        lobbyManager.broadcastRoster(result.room.code);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] Client error:', err.message);
  });
});

function handleMessage(ws: WebSocket, msg: any): void {
  switch (msg.type) {
    case 'create': {
      // Host creates a room
      const name = sanitizeName(msg.name);
      const error = validateName(name);
      if (error) {
        ws.send(JSON.stringify({ type: 'error', message: error }));
        return;
      }
      // Check if already in a room
      if (lobbyManager.getRoomCode(ws)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Already in a room' }));
        return;
      }
      const code = lobbyManager.createRoom(ws, name);
      const playerInfo = lobbyManager.getPlayer(ws);
      ws.send(JSON.stringify({
        type: 'created',
        code,
        name,
        isHost: true,
        serverId: playerInfo!.player.serverId,
      }));
      lobbyManager.broadcastRoster(code);
      console.log(`[Lobby] Room ${code} created by ${name}`);
      break;
    }

    case 'join': {
      // Player joins by code
      const name = sanitizeName(msg.name);
      const error = validateName(name);
      if (error) {
        ws.send(JSON.stringify({ type: 'error', message: error }));
        return;
      }
      const code = msg.code?.toUpperCase();
      if (!code || code.length !== 5) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid lobby code' }));
        return;
      }
      // Check if already in a room
      if (lobbyManager.getRoomCode(ws)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Already in a room' }));
        return;
      }
      const joinError = lobbyManager.joinRoom(ws, name, code);
      if (joinError) {
        ws.send(JSON.stringify({ type: 'error', message: joinError.error }));
        return;
      }
      const joinedPlayer = lobbyManager.getPlayer(ws);
      ws.send(JSON.stringify({
        type: 'joined',
        code,
        name,
        serverId: joinedPlayer!.player.serverId,
      }));
      lobbyManager.broadcastRoster(code);
      console.log(`[Lobby] ${name} joined room ${code}`);
      break;
    }

    case 'leave': {
      const result = lobbyManager.leaveRoom(ws);
      if (result.room) {
        ws.send(JSON.stringify({ type: 'left' }));
        lobbyManager.broadcastRoster(result.room.code);
      }
      break;
    }

    case 'ready': {
      const result = lobbyManager.toggleReady(ws);
      if (result.error) {
        ws.send(JSON.stringify({ type: 'error', message: result.error }));
        return;
      }
      // Broadcast handled in toggleReady
      ws.send(JSON.stringify({
        type: 'ready_state',
        ready: result.ready,
      }));
      break;
    }

    case 'start': {
      // Only host can start
      const info = lobbyManager.getPlayer(ws);
      if (!info) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not in a room' }));
        return;
      }
      if (!info.player.isHost) {
        ws.send(JSON.stringify({ type: 'error', message: 'Only host can start' }));
        return;
      }
      if (info.room.phase === 'playing') {
        ws.send(JSON.stringify({ type: 'error', message: 'Match already in progress' }));
        return;
      }
      // Start the match via LobbyManager
      lobbyManager.startMatch(info.room.code);
      console.log(`[Game] Match started in room ${info.room.code}`);
      break;
    }

    case 'input': {
      // Client game input with optional redundancy
      const pInfo = lobbyManager.getPlayer(ws);
      if (!pInfo || !pInfo.room.gameWorld) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not in a match' }));
        return;
      }
      const world = pInfo.room.gameWorld;
      const player = [...world.players.values()].find(p => p.ws === ws);
      if (player) {
        // Process primary input
        const input: InputFrame = {
          seq: msg.seq as number,
          viewTick: msg.viewTick as number,
          moveX: msg.moveX as number,
          moveZ: msg.moveZ as number,
          yaw: msg.yaw as number,
          pitch: msg.pitch as number,
          buttons: msg.buttons as number,
        };
        world.processInput(player.id, input);
        // Process redundant inputs
        if (msg.redundant && Array.isArray(msg.redundant)) {
          for (const r of msg.redundant) {
            world.processInput(player.id, {
              seq: r.seq as number,
              viewTick: r.viewTick as number,
              moveX: r.moveX as number,
              moveZ: r.moveZ as number,
              yaw: r.yaw as number,
              pitch: r.pitch as number,
              buttons: r.buttons as number,
            });
          }
        }
      }
      break;
    }

    case 'heartbeat': {
      (ws as any).__hbTimer = 0;
      break;
    }

    default:
      console.log(`[WS] Unknown message type: ${msg.type}`);
  }
}

// --- Game tick loop ---
const gameTickInterval = setInterval(() => {
  for (const [, room] of lobbyManager.roomEntries) {
    if (room.phase === 'countdown' || room.phase === 'playing') {
      if (!room.gameWorld) continue;

      // Transition from countdown to playing
      if (room.phase === 'countdown') {
        const elapsed = (Date.now() - room.startedAt) / 1000;
        if (elapsed >= 3) {
          room.phase = 'playing';
          lobbyManager.broadcast(room.code, {
            type: 'match_start',
            phase: 'playing',
          });
          console.log(`[Game] Room ${room.code} now playing`);
        }
      }

      // Run game tick
      const snapshot = room.gameWorld.tick();

      // Broadcast snapshot to all players with per-client ack
      for (const [playerWs] of room.players) {
        if (playerWs.readyState !== WebSocket.OPEN) continue;
        // Get per-player ack seq
        const player = [...room.gameWorld.players.values()].find(p => p.ws === playerWs);
        const ackInputSeq = player ? player.ackInputSeq : 0;
        const data = JSON.stringify({
          type: 'snapshot',
          tick: snapshot.serverTick,
          ackInputSeq,
          players: snapshot.players,
          events: snapshot.events,
        });
        playerWs.send(data);
      }
    }
  }
}, 1000 / SERVER_TICK_HZ);
gameTickInterval.unref();

function sanitizeName(name: string): string {
  return (name || '').trim().replace(/[<>]/g, '').slice(0, NAME_MAX);
}

function validateName(name: string): string | null {
  if (!name) return 'Name is required';
  if (name.length < NAME_MIN) return `Name must be at least ${NAME_MIN} characters`;
  if (name.length > NAME_MAX) return `Name must be at most ${NAME_MAX} characters`;
  return null;
}

server.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
  console.log(`[Server] Client dist: ${CLIENT_DIST}`);
});

// --- Graceful shutdown ---
process.on('SIGINT', () => {
  console.log('[Server] Shutting down...');
  clearInterval(heartbeatInterval);
  wss.clients.forEach((ws) => ws.close(1001, 'Server shutdown'));
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  console.log('[Server] Terminating...');
  clearInterval(heartbeatInterval);
  wss.clients.forEach((ws) => ws.close(1001, 'Server shutdown'));
  server.close(() => process.exit(0));
});

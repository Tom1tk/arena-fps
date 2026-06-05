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
import { MAX_PLAYERS, NAME_MIN, NAME_MAX, HEARTBEAT_INTERVAL_S, HEARTBEAT_MISS_LIMIT, SERVER_TICK_HZ, TICK_DT, POST_MATCH_DURATION_S, START_COUNTDOWN_S } from '../../shared/constants.js';
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

// M1: Connection/room limits (DoS protection)
const MAX_CONNECTIONS = 200;
const MAX_ROOMS = 50;
const MAX_CONN_PER_IP = 8;
const ipConnCount = new Map<string, number>();

function getClientIp(req: any): string {
  // Behind Cloudflare: use CF-Connecting-IP; otherwise use remoteAddress
  const cfIp = req.headers?.['cf-connecting-ip'];
  if (typeof cfIp === 'string') return cfIp;
  return (req.socket?.remoteAddress as string) ?? 'unknown';
}

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

wss.on('connection', (ws: WebSocket, req: any) => {
  // M1: Enforce connection limits
  const ip = getClientIp(req);
  const currentIpCount = ipConnCount.get(ip) ?? 0;

  if (wss.clients.size >= MAX_CONNECTIONS) {
    ws.close(1013, 'Server full');
    return;
  }
  if (currentIpCount >= MAX_CONN_PER_IP) {
    ws.close(1013, 'Too many connections from your IP');
    return;
  }

  ipConnCount.set(ip, currentIpCount + 1);
  (ws as any).__ip = ip; // store for close handler

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

  ws.on('close', (code: number, _reason: Buffer) => {
    // M1: Decrement per-IP counter
    const closeIp = (ws as any).__ip as string;
    const count = ipConnCount.get(closeIp);
    if (count !== undefined && count > 1) {
      ipConnCount.set(closeIp, count - 1);
    } else if (count !== undefined) {
      ipConnCount.delete(closeIp);
    }

    console.log(`[WS] Client disconnected (code: ${code})`);
    const result = lobbyManager.leaveRoom(ws);
    if (result.room) {
      // Handle game world disconnect
      if (result.room.gameWorld) {
        for (const player of result.room.gameWorld.players.values()) {
          if (player.ws === ws) {
            player.connected = false;
            // M2: Schedule removal after grace period (10s) for reconnect
            const playerId = player.id;
            setTimeout(() => {
              result.room!.gameWorld?.removePlayer(playerId);
            }, 10000);
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

/**
 * Sanitise client input fields to prevent NaN/Infinity corruption.
 * All values are clamped to safe ranges; non-finite numbers become defaults.
 */
function sanitizeInput(m: any): InputFrame {
  const num = (v: any, lo: number, hi: number, dflt = 0): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
  };
  return {
    seq:      num(m.seq, 0, Number.MAX_SAFE_INTEGER),
    viewTick: num(m.viewTick, 0, Number.MAX_SAFE_INTEGER),
    moveX:    num(m.moveX, -1, 1),
    moveZ:    num(m.moveZ, -1, 1),
    yaw:      num(m.yaw, -Math.PI * 4, Math.PI * 4),
    pitch:    num(m.pitch, -Math.PI / 2, Math.PI / 2),
    buttons:  (m.buttons | 0) & 0b1111, // only the 4 defined ButtonFlags bits
  };
}

function handleMessage(ws: WebSocket, msg: any): void {
  if (typeof msg.type !== 'string') return;
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
      // M1: Reject if room limit reached (createRoom returns '' when full)
      if (!code) {
        ws.send(JSON.stringify({ type: 'error', message: 'Server full — too many rooms' }));
        return;
      }
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
        // Process primary input — sanitised to prevent NaN/Infinity
        const input: InputFrame = sanitizeInput(msg);
        world.processInput(player.id, input);
        // Process redundant inputs
        if (msg.redundant && Array.isArray(msg.redundant)) {
          for (const r of msg.redundant) {
            world.processInput(player.id, sanitizeInput(r));
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
/**
 * M5: Measure tick duration and warn on overruns.
 */
const tickTimer = setInterval(() => {
  const start = performance.now();
  for (const [, room] of lobbyManager.roomEntries) {
    if (room.phase === 'countdown' || room.phase === 'playing') {
      if (!room.gameWorld) continue;

      // Transition from countdown to playing (M5: tick-based, not wall-clock)
      if (room.phase === 'countdown') {
        const countdownStartTick = room.countdownStartTick ?? room.gameWorld.serverTick;
        if (room.countdownStartTick === undefined) {
          // Store on first tick — set by lobby.ts startMatch
        }
        const ticksElapsed = room.gameWorld.serverTick - countdownStartTick;
        const ticksNeeded = Math.ceil(START_COUNTDOWN_S * SERVER_TICK_HZ);
        if (ticksElapsed >= ticksNeeded) {
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
      // TODO(L1): Replace JSON.stringify with binary serialization (MessagePack/flatbuffers)
      // for production. At 30Hz × 20 players × 400B = ~240 KB/s, JSON overhead is significant.
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

      // When the match ends, enter post_match exactly once and broadcast
      // match_end + scoreboard. The post_match block below owns the timed
      // scoreboard window and the eventual lobby reset.
      if (room.gameWorld.matchEnded) {
        room.postMatchStartTick = room.gameWorld.serverTick;
        const scoreboard = [...room.gameWorld.players.values()].map(p => ({
          id: p.id,
          name: p.name,
          kills: p.kills,
          deaths: p.deaths,
          left: !p.connected,
        }));
        room.phase = 'post_match';
        lobbyManager.broadcast(room.code, { type: 'match_end', scoreboard });
        console.log(`[Game] Room ${room.code} match ended -> post_match`);
      }
    }

    // Post-match: keep ticking/broadcasting for the scoreboard background,
    // then reset to the LOBBY (players stay connected and re-ready).
    else if (room.phase === 'post_match' && room.gameWorld) {
      // M5: tick-based post-match timer
      const postMatchStartTick = room.postMatchStartTick ?? room.gameWorld.serverTick;
      const ticksElapsed = room.gameWorld.serverTick - postMatchStartTick;
      const ticksNeeded = Math.ceil(POST_MATCH_DURATION_S * SERVER_TICK_HZ);
      if (ticksElapsed < ticksNeeded) {
        const snapshot = room.gameWorld.tick();
        for (const [playerWs] of room.players) {
          if (playerWs.readyState !== WebSocket.OPEN) continue;
          const player = [...room.gameWorld.players.values()].find(p => p.ws === playerWs);
          const ackInputSeq = player ? player.ackInputSeq : 0;
          playerWs.send(JSON.stringify({
            type: 'snapshot',
            tick: snapshot.serverTick,
            ackInputSeq,
            players: snapshot.players,
            events: snapshot.events,
          }));
        }
      } else {
        room.gameWorld?.dispose();
        room.gameWorld = null;
        for (const [, p] of room.players) p.ready = false;
        room.phase = 'lobby';
        const roster = [...room.players.values()];
        lobbyManager.broadcast(room.code, { type: 'return_to_lobby', roster });
        lobbyManager.broadcastRoster(room.code);
        console.log(`[Game] Room ${room.code} reset to lobby`);
      }
    }
  }
  // M5: Warn on tick overrun (>25ms per full loop)
  const elapsed = performance.now() - start;
  if (elapsed > 25) {
    console.warn(`[Tick] Overrun: ${elapsed.toFixed(1)}ms (tick budget: ${1000 / SERVER_TICK_HZ}ms)`);
  }
}, 1000 / SERVER_TICK_HZ);
tickTimer.unref();

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

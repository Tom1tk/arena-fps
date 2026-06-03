# Arena FPS

A multiplayer first-person shooter that runs entirely in the browser. Authoritative
server simulation at 30 Hz, Three.js rendering (WebGPU / WebGL2), zero external
assets — all geometry and audio are generated procedurally.

| Layer | Stack |
|---|---|
| Rendering | Three.js r184 (WebGPU primary, WebGL2 fallback) |
| Client | TypeScript · Vite · pointer-lock FPS controller |
| Server | Node.js · `ws` WebSocket server · 30 Hz authoritative tick |
| Shared | `/shared` — constants, types, arena layout, collision helpers |
| Tests | Vitest (30 passing) |

---

## Quick Start

```bash
# Install dependencies
npm install

# Development (client on :5173, server on :3444)
npm run dev            # client hot-reload
npm run server:dev     # server with tsx watch (separate terminal)

# Production
npm run build          # tsc -b + vite build
```

---

## Project Structure

```
arena-fps/
├── client/                    # Browser frontend
│   ├── src/
│   │   ├── main.ts            # Entry: render loop, HUD, game phases
│   │   ├── arena.ts           # Arena floor, obstacles, lighting
│   │   ├── inputSource.ts     # Keyboard / mouse / pointer-lock
│   │   ├── hitscan.ts         # Client-side hit visualization
│   │   ├── viewmodel.ts       # Procedural weapon + walk bob + recoil + sway
│   │   ├── audio.ts           # Synthesized audio (positional PannerNode)
│   │   ├── netClient.ts       # WebSocket protocol, message dispatch
│   │   ├── netGame.ts         # Client-side prediction + reconciliation
│   │   ├── remotePlayers.ts   # Remote player meshes (capsule + HP bar + name)
│   │   ├── fpsCounter.ts      # Throttled FPS readout
│   │   └── settingsStore.ts   # localStorage settings persistence
│   └── index.html             # Inline CSS for HUD, menus, overlays
├── server/
│   └── src/
│       ├── index.ts           # HTTP + WS server, tick loop, static file serving
│       ├── gameWorld.ts       # Authoritative game state, simulation tick
│       └── lobby.ts           # Room create/join/ready/start, roster mgmt
├── shared/
│   ├── constants.ts           # Single source of truth (speeds, arena, match)
│   └── types.ts               # Interfaces: InputFrame, PlayerState, Snapshot, etc.
├── tests/
│   └── init.test.ts           # Shared constants + types validation (30 tests)
└── deploy.sh                  # Production deploy script (systemd service)
```

---

## Gameplay

- **Mode:** Free-for-all deathmatch to **30 kills** (FFA kill goal).
- **Map:** 40 × 40 arena with 12 cover obstacles, 8 spawn points.
- **Weapon:** Semi-automatic pistol — 34 body / 100 headshot damage, 360 RPM,
  15-round mag, 1.6 s reload.
- **Movement:** WASD + jump (Space) + crouch (Ctrl), swept capsule-vs-AABB
  collision, directional camera.
- **Players:** Up to **8** simultaneous players.

---

## Networking

```
┌──────────────────────────────────────────────────────────────────┐
│                        SERVER (30 Hz)                            │
│  ┌──────────────┐  tick()  ┌──────────────┐                     │
│  │  Input Drain  │ ──────►  │  GameWorld    │ ──► Snapshots     │
│  │  (≤5/tick)   │          │  Simulation   │   broadcast to all │
│  └──────────────┘          └──────────────┘                     │
└──────────────────────────────────────────────────────────────────┘
         ▲ WS: input (seq, redundancy)            │ WS: snapshot
         │                                        ▼
┌──────────────────────────────────────────────────────────────────┐
│                       CLIENT                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │  Input Queue  │  │ Prediction + │  │ Interpolation (100 ms) │  │
│  │  (3 frames)   │  │ Reconcile    │  │ Remote entities       │  │
│  └──────────────┘  └──────────────┘  └───────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

| Feature | Detail |
|---|---|
| Tick rate | 30 Hz (33 ms) |
| Input redundancy | Last 3 unacked inputs sent each frame |
| Client prediction | Local simulation step reconciled on snapshot |
| Entity interpolation | 100 ms delay buffer, smooth lerp |
| Lag compensation | 1000 ms server-side rewind buffer for hitscan |
| Heartbeat | 25 s ping / 3-miss disconnect |

---

## Match Flow

```
Main Menu → Play Online → Create/Join Lobby → Ready → 3-s Countdown
    → Match (FFA to 30 kills) → 15-s Post-Match Scoreboard
    → Return to Lobby (players stay connected, re-ready for next round)
```

- **Mid-match join** is supported — late players spawn when they connect.
- Players who disconnect during a match are tagged `(left)` on the scoreboard.
- After the 15-second post-match window, both clients return to the lobby
  panel automatically — the WebSocket connection is preserved.

---

## Features

| Category | Implemented |
|---|---|
| **Rendering** | WebGPU/WebGL2, DPR clamp, quality toggle (Low/Med/High),
  render interpolation, procedural arena geometry |
| **Controls** | Pointer-lock FPS, WASD + jump + crouch, mouse look,
  configurable sensitivity / FOV, settings persisted to localStorage |
| **Weapon** | Procedural viewmodel with walk bob, recoil animation,
  head-turn sway, semi-auto fire, reload animation, hit markers |
| **Audio** | Positional audio via `PannerNode` (HRTF), synthesized gunshot /
  reload / footsteps / jump / land, directional to remote player position |
| **Multiplayer** | WebSocket through Cloudflare Tunnel, lobby codes,
  ready/start gating, host transfer, heartbeat keepalive |
| **HUD** | Crosshair, kill feed, damage indicator, death overlay,
  Tab scoreboard, FPS counter (1 Hz DOM update) |

---

## Configuration

All tunable values live in `shared/constants.ts` — a single source of truth
shared between client and server:

| Constant | Default | Description |
|---|---|---|
| `MOVE_SPEED` | 7.0 m/s | Ground movement speed |
| `CROUCH_SPEED` | 3.5 m/s | Crouched movement speed |
| `GRAVITY` | 20 m/s² | Downward acceleration |
| `JUMP_VELOCITY` | 6.0 m/s | Initial jump velocity |
| `GUN_DAMAGE` | 34 | Body hit damage |
| `HEADSHOT_DAMAGE` | 100 | Instant kill |
| `FIRE_RATE_MS` | 166 | 360 RPM cooldown |
| `MAG_SIZE` | 15 | Rounds per magazine |
| `RELOAD_TIME` | 1.6 s | Full reload duration |
| `MAX_PLAYERS` | 8 | Concurrent players |
| `KILL_GOAL` | 30 | Kills to end match |
| `POST_MATCH_DURATION_S` | 15 | Scoreboard display time |
| `SERVER_TICK_HZ` | 30 | Authoritative tick rate |
| `ARENA_HALF` | 20 | Half-size of 40 × 40 map |

---

## Deployment

```bash
# Deploy to production (systemd service on port 7777)
./deploy.sh

# Service runs as user arena-fps, data at /opt/arena-fps
systemctl status arena-fps
curl http://localhost:7777/health
```

The server serves static files from `/opt/arena-fps/dist/client/` and the
WebSocket endpoint is `ws://<host>/` on the same port. A Cloudflare Tunnel
provides public access.

---

## Development

```bash
# Build client + server
npm run build              # tsc -b + vite build → dist/

# Type check (no emit)
npx tsc -b --noEmit
npx tsc -p server/tsconfig.json --noEmit

# Test
npm test                   # 30 tests
npm run test:watch         # Vitest watch mode
```

---

## Browser Support

| Browser | Rendering Path |
|---|---|
| Chrome 131+ | WebGPU (primary) |
| Firefox / Safari / Chrome < 131 | WebGL2 (automatic fallback) |
| Mobile | Supported (touch controls not implemented) |

---

## License

MIT

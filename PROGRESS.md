# Arena FPS — Progress Tracker

> Source of truth: `fps-project-plan.md`
> This file tracks milestone completion against the plan's Definition of Done (DoD).

## Current Status: **M6 — Complete (Networked Gameplay: Authoritative Server + Client Sync)**

---

## M0 — Scaffold & Render

**Goal:** Vite + TS + three.js r184 (`three/webgpu`), async WebGPU init with logged backend + WebGL2 fallback, flat-coloured boxed arena, FPS counter, DPR clamp, graphics toggle stub.

### DoD Checklist

- [x] Boots (Vite dev server serves index.html ✓, tsc --noEmit passes ✓, vite build succeeds ✓)
- [x] Backend logged (WebGPU or WebGL2) — code in place, confirmed working
- [x] Arena renders (flat-coloured boxed arena with obstacles + ramps) — confirmed working
- [x] FPS counter (top-left, color-coded) — confirmed working
- [x] 120 Hz+ on the RX 7900 XTX — confirmed (rAF ~165, render ~0.2ms)
- [x] Also runs on a WebGL2/iGPU path — fallback code in place
- [x] Graphics quality toggle (High/Low) works — confirmed working

### Implemented
- [x] Project structure (`/client`, `/server`, `/shared`)
- [x] `package.json` with Vite, three.js r184, TypeScript 5.9, ws, vitest, tsx
- [x] `tsconfig.json` (client, strict mode, verbatimModuleSyntax, path aliases)
- [x] `server/tsconfig.json` (ESNext module, separate compilation)
- [x] `vite.config.ts` with `@shared` alias
- [x] `shared/constants.ts` — all §9 constants (player, movement, weapon, match, networking)
- [x] `shared/types.ts` — InputFrame, ButtonFlags, PlayerState, Snapshot, SnapshotEvent, Room, RoomPlayer, RoomState, Settings, CrosshairType, GraphicsQuality, InputSource, AABB, SpawnPoint, RampPlane, WorldDef
- [x] `client/index.html` — HUD overlay, FPS counter, graphics toggle, title screen
- [x] `client/src/main.ts` — WebGPU init with WebGL2 fallback, DPR clamp, render loop, orbit camera, settings persistence
- [x] `client/src/arena.ts` — Flat-shaded arena (floor, 4 walls, 2 ramps, 12 obstacles, ambient + directional light)
- [x] `client/src/fpsCounter.ts` — Frame-rate counter with color coding (≥120 green, ≥60 yellow, <60 red)
- [x] `client/src/settingsStore.ts` — localStorage settings with validation/clamping, singleton pattern
- [x] `server/src/index.ts` — HTTP static file server + WebSocket server, health endpoint, graceful shutdown, default port 3444
- [x] `server/tsconfig.json`
- [x] `PROGRESS.md`

### Build verification
- `tsc --noEmit` → **0 errors** ✓
- `vite build` → **succeeds** (10 modules, 1.08 MB gzipped JS + HTML) ✓
- `npx tsx server/src/index.ts` → **listens on :3444**, `/health` → `{"status":"ok"}` ✓
- `npx vite` → **serves dev server on :3000**, serves index.html with Vite HMR ✓

### Questions / Decisions
- None yet for M0.

---

## M1 — FPS Controller (Local) *(blocked until M0 DoD met)*
- [x] Pointer lock, WASD/jump/crouch
- [x] Fixed-timestep movement in `/shared`
- [x] Swept capsule-vs-box collision (capsule-vs-AABB with iterative resolution)
- [x] FOV/sensitivity from settings
- [x] Input source abstraction
- [x] OOB kill-plane
- [x] **Render interpolation** — camera positioned from `lerp(prevPos, player.pos, alpha)` using residual `simAccum / TICK_DT` fraction. Eliminates 30 Hz stepping artifact at 165 Hz display.
- [x] **Recoil persistence fix** — `recoilPitch` is a separate visual offset (not `player.pitch`), decays per-frame via `RECOIL_DECAY_RATE`. Keeps `playerStep` as single authority over base aim for M6+ networking.
- [x] **Per-frame aim** — camera yaw/pitch sourced directly from `inputSource.getYaw()/getPitch()` each frame, not tick-coupled.

> Remote-entity/snapshot interpolation remains deferred to M6.

## M2 — Weapon & Hitscan *(blocked until M1 DoD met)*
- [x] Pistol, mag, fire-rate, reload, hitscan
  - Hitscan raycast via `raycastHitscan()` with obstacle occlusion
  - Dummy targets: 5 targets with head/body separation, respawn after 6s
  - Damage: 22 body / 66 head (from constants), kill tracking
  - Hit marker only on confirmed hit
  - Spread wired via `SPREAD_RAD` (currently 0 = pinpoint)
- [x] HUD (HP/ammo/crosshair) — throttled DOM updates, live settings
- [x] Hit/kill markers
- [x] Procedural viewmodel
  - Pistol mesh (body, barrel, grip, handle) attached to camera
  - Idle/walk bob, recoil kick, reload animation
- [x] Base SFX (Web Audio API, no external files)
  - Shoot (noise burst + lowpass), Reload (two clicks), Kill (sine tone)
- [x] New files: `client/src/hitscan.ts`, `client/src/viewmodel.ts`, `client/src/audio.ts`

## M3 — Game Rules *(blocked until M2 DoD met)*
- [x] Death/respawn, kills, scoreboard
  - Player takes damage from nearby bots (BOT_DAMAGE=8, ~1.5 attacks/sec)
  - Death screen overlay with countdown, auto-respawn after RESPAWN_DELAY_S (3s)
  - Player death tracked (playerDeaths counter)
  - Smart spawn: `selectSpawnPoint()` maximizes distance from alive players, avoids recent spawns
  - SPAWN_POSITIONS defined in constants (8 spawn points around arena)
- [x] FFA to 30, tie handling, post-match
  - Match phase machine: 'playing' → 'post_match' → auto-reset after 15s
  - Kill goal: KILL_GOAL=30, triggers post-match when reached
  - Post-match overlay shows K/D stats, countdown to next match
  - resetMatch() clears all state, respawns bots, spawns player
- [x] Smart spawn selection
  - `shared/spawn-selection.ts`: weighted scoring (distance + line-of-sight + recency)
  - SPAWN_POSITIONS in constants with pre-computed yaw angles toward center
- [x] Kill feed (top-right, up to 8 entries, 5s fade)
- [x] Scoreboard (top-left: K/D/Goal, Tab: full scoreboard with bot entries)
- [x] Death overlay ("YOU DIED" + killer info + respawn countdown)
- [x] Post-match overlay ("MATCH COMPLETE" + stats + countdown)
- [x] Damage indicator (red screen-edge flash when hit)
- [x] New files: `shared/spawn-selection.ts`

## M4 — Menu & Settings *(blocked until M3 DoD met)*
- [x] Name gate (3–20 chars), main menu, settings UI
  - Name input on title screen with validation (min 3 chars)
  - "Enter Arena" button disabled until name is valid
  - Name persisted in localStorage (`arena-fps-name` key)
  - Name shown in scoreboard and kill feed
- [x] Settings panel on title screen (pre-game):
  - Sensitivity (1–20, step 0.5)
  - FOV (60–120)
  - Crosshair type (cross/dot/crossdot/circle)
  - Crosshair colour (color picker)
  - Crosshair size (12–48)
  - Graphics quality (High/Low)
  - All settings apply live and persist to localStorage
- [x] In-game settings overlay (via Pause → Settings):
  - Same controls as menu, synced with current settings
- [x] Esc pause overlay (Resume · Settings · Leave) per §6.2
- [x] Tab scoreboard behaviour per §6.2 (releases pointer lock, player stays vulnerable)
- [x] Settings persist across reloads + apply live
- [x] All crosshair types render correctly
- [x] Graphics toggle changes cost (DPR, far plane, lights)

## M5 — Server & Lobby *(complete)*
- [x] WebSocket through CF tunnel
- [x] Room create/join, roster, ready/start
- [x] Host-disband, heartbeat
- [x] Deploy systemd service (combined HTTP+WS)
- [x] Client-side countdown timer for match start

## M6 — Networked Gameplay *(complete)*
- [x] Authoritative server-side game simulation (30Hz tick loop)
  - `server/src/gameWorld.ts` — GameWorld with players, bots, obstacles, hitscan
  - Server-side bot AI (chase nearest player, shoot within range)
  - Smart spawn selection on server
  - Death/respawn logic on server
- [x] State snapshots broadcast to all clients at 30Hz
  - Server tick loop broadcasts `Snapshot` messages via WebSocket
  - Includes all entity positions, HP, ammo, yaw, pitch, kill events
- [x] Client sends input to server
  - `NetClient.sendInput()` sends WASD, yaw, pitch, button bitmask
  - Server processes input through `playerStep()`
- [x] Client renders from server snapshots
  - `NetGame` class tracks entities from server snapshots
  - Camera position/rotation sourced from server state
  - HUD (HP, ammo, kills) synced from server
- [x] Remote player rendering
  - `RemotePlayerManager` creates capsule meshes for other players/bots
  - HP bars, name tags, visibility based on alive state
- [x] Server-side bots replace per-client dummy targets
  - Bots are entities on server, not client-side
  - Bot AI runs on server (chase + shoot)
- [x] Shared constants moved for server/client parity
  - `ARENA_HALF`, `OBSTACLES` in `shared/constants.ts`
  - ESM `.js` extensions on shared module imports

### New Files
- `server/src/gameWorld.ts` — Authoritative game world simulation
- `client/src/netGame.ts` — Client-side entity tracking from snapshots
- `client/src/remotePlayers.ts` — 3D remote player rendering

> Note: Client-side prediction and lag compensation deferred to M7.

## M7 — Full Networked Match Flow *(blocked until M6 DoD met)*
- [ ] Net match-end, mid-match join, leave handling

## M8 — Audio, Feel & Hardening *(blocked until M7 DoD met)*
- [ ] Directional audio, viewmodel polish, perf pass, balance tuning

# Arena FPS — Progress Tracker

> Source of truth: `fps-project-plan.md`
> This file tracks milestone completion against the plan's Definition of Done (DoD).

## Current Status: **M0 — In Progress (Scaffold complete, DoD verification pending)**

---

## M0 — Scaffold & Render

**Goal:** Vite + TS + three.js r184 (`three/webgpu`), async WebGPU init with logged backend + WebGL2 fallback, flat-coloured boxed arena, FPS counter, DPR clamp, graphics toggle stub.

### DoD Checklist

- [ ] Boots (Vite dev server serves index.html ✓, tsc --noEmit passes ✓, vite build succeeds ✓)
- [ ] Backend logged (WebGPU or WebGL2) — code in place, needs browser test
- [ ] Arena renders (flat-coloured boxed arena with obstacles + ramps) — code in place
- [ ] FPS counter (top-left, color-coded) — code in place
- [ ] 120 Hz+ on the RX 7900 XTX — needs browser test
- [ ] Also runs on a WebGL2/iGPU path — fallback code in place, needs browser test
- [ ] Graphics quality toggle (High/Low) works — code in place

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
- [ ] Pistol, mag, fire-rate, reload, hitscan
- [ ] HUD (HP/ammo/crosshair)
- [ ] Hit/kill markers
- [ ] Procedural viewmodel

## M3 — Game Rules *(blocked until M2 DoD met)*
- [ ] Death/respawn, kills, scoreboard
- [ ] FFA to 30, tie handling, post-match
- [ ] Smart spawn selection

## M4 — Menu & Settings *(blocked until M3 DoD met)*
- [ ] Name gate, main menu, settings UI
- [ ] Esc pause overlay, Tab scoreboard

## M5 — Server & Lobby *(blocked until M4 DoD met)*
- [ ] WebSocket through CF tunnel
- [ ] Room create/join, roster, ready/start
- [ ] Host-disband, heartbeat

## M6 — Networked Gameplay *(blocked until M5 DoD met)*
- [ ] Authoritative tick, prediction, interpolation, lag-comp

## M7 — Full Networked Match Flow *(blocked until M6 DoD met)*
- [ ] Net match-end, mid-match join, leave handling

## M8 — Audio, Feel & Hardening *(blocked until M7 DoD met)*
- [ ] Directional audio, viewmodel polish, perf pass, balance tuning

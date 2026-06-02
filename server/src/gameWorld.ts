/**
 * Arena FPS — Server-side authoritative game world
 *
 * Implements §4.3 (server tick loop), §4.5 (solid-no-push collision),
 * §4.6 (lag-compensated hitscan with ring buffer), §4.7 (lifecycle).
 */
import {
  TICK_DT, PLAYER_MAX_HP, MAG_SIZE, DAMAGE_BODY, DAMAGE_HEAD,
  RESPAWN_DELAY_S, PLAYER_EYE_HEIGHT, ARENA_HALF, HITSCAN_MAX_RANGE,
  SPAWN_POSITIONS, LAGCOMP_HISTORY_TICKS, INPUT_BUFFER_MAX,
  MAX_PLAYERS, KILL_GOAL, RELOAD_TIME_S, FIRE_RATE_RPM,
} from '../../shared/constants.js';
import { OBSTACLES as SHARED_OBSTACLES } from '../../shared/constants.js';
import { playerStep, type PlayerSim } from '../../shared/simulation/step.js';
import type { InputFrame, Snapshot, SnapshotEvent, PlayerState } from '../../shared/types.js';
import { selectSpawnPoint } from '../../shared/spawn-selection.js';
import { WebSocket } from 'ws';

// --- Types ---

interface SimAABB {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

// Convert shared {min, max} obstacles to sim {minX, maxX, ...} format
const OBSTACLES: SimAABB[] = SHARED_OBSTACLES.map(o => ({
  minX: o.min.x, maxX: o.max.x,
  minY: o.min.y, maxY: o.max.y,
  minZ: o.min.z, maxZ: o.max.z,
}));

const WORLD_BOUNDS: SimAABB = {
  minX: -ARENA_HALF, maxX: ARENA_HALF,
  minY: -10, maxY: 100,
  minZ: -ARENA_HALF, maxZ: ARENA_HALF,
};

// Lag-comp history: stores player state per tick for rewinding
interface LagCompEntry {
  tick: number;
  eyeX: number; eyeY: number; eyeZ: number;
  yaw: number; pitch: number;
  alive: boolean;
  crouching: boolean;
}

let nextPlayerId = 1;
let nextBotId = 100;

// --- Server Player ---

export interface ServerPlayer {
  ws: WebSocket;
  id: number;
  name: string;
  sim: PlayerSim;
  hp: number;
  ammo: number;
  kills: number;
  deaths: number;
  alive: boolean;
  reloading: boolean;
  reloadTimer: number;
  fireCooldown: number;
  respawnTimer: number;
  // Input handling (§4.3 — drain inputs)
  inputBuffer: Map<number, InputFrame>;
  lastInputSeq: number;
  lastIntent: InputFrame | null;       // repeated if no new input
  intentRepeatTicks: number;           // clamp repeat to avoid permanent freeze
  // Lag-comp ring buffer (§4.6)
  lagCompHistory: LagCompEntry[];
  // Per-client ack tracking (§4.3)
  ackInputSeq: number;
  connected: boolean;
}

// --- Server Bot ---

export interface ServerBot {
  id: number;
  name: string;
  sim: PlayerSim;
  hp: number;
  kills: number;
  deaths: number;
  alive: boolean;
  deathTimer: number;
  moveTimer: number;
  shootTimer: number;
  patrolAngle: number;
}

// --- Game World ---

export class GameWorld {
  players: Map<number, ServerPlayer> = new Map();
  bots: ServerBot[] = [];
  serverTick = 0;
  events: SnapshotEvent[] = [];
  matchEnded = false;
  private recentSpawns: Array<{ pos: { x: number; y: number; z: number }; time: number }> = [];

  constructor(public botCount: number = 5) {
    if (botCount <= 0) return;
    const botNames = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
    for (let i = 0; i < botCount && i < 5; i++) {
      const sp = SPAWN_POSITIONS[i];
      this.bots.push({
        id: nextBotId++,
        name: botNames[i],
        sim: {
          pos: { x: sp.pos.x, y: sp.pos.y, z: sp.pos.z },
          vel: { x: 0, y: 0, z: 0 },
          yaw: sp.yaw, pitch: 0,
          grounded: false, crouching: false,
          eyeHeight: PLAYER_EYE_HEIGHT,
        },
        hp: PLAYER_MAX_HP,
        kills: 0, deaths: 0, alive: true,
        deathTimer: 0,
        moveTimer: Math.random() * 3,
        shootTimer: Math.random(),
        patrolAngle: sp.yaw,
      });
    }
  }

  addPlayer(ws: WebSocket, name: string): number {
    const id = nextPlayerId++;
    const spawn = this.pickSpawn();
    const p: ServerPlayer = {
      ws, id, name,
      sim: {
        pos: { x: spawn.pos.x, y: spawn.pos.y, z: spawn.pos.z },
        vel: { x: 0, y: 0, z: 0 },
        yaw: spawn.yaw, pitch: 0,
        grounded: false, crouching: false,
        eyeHeight: PLAYER_EYE_HEIGHT,
      },
      hp: PLAYER_MAX_HP, ammo: MAG_SIZE,
      kills: 0, deaths: 0, alive: true,
      reloading: false, reloadTimer: 0, fireCooldown: 0, respawnTimer: 0,
      inputBuffer: new Map(), lastInputSeq: 0,
      lastIntent: null, intentRepeatTicks: 0,
      lagCompHistory: [],
      ackInputSeq: 0,
      connected: true,
    };
    this.players.set(id, p);
    this.recentSpawns.push({ pos: { ...p.sim.pos }, time: Date.now() / 1000 });
    this.events.push({ type: 'Spawn', id, pos: { ...p.sim.pos } });
    return id;
  }

  removePlayer(id: number): void {
    this.players.delete(id);
  }

  /**
   * Accept input from a client. Stores in per-player buffer for
   * §4.3 drain processing. Handles redundancy (same seq ignored).
   */
  processInput(playerId: number, input: InputFrame): void {
    const p = this.players.get(playerId);
    if (!p) return;
    // Ignore already-acked inputs
    if (input.seq <= p.ackInputSeq) return;
    // Store in buffer
    p.inputBuffer.set(input.seq, input);
    // Cap buffer size
    while (p.inputBuffer.size > INPUT_BUFFER_MAX) {
      const oldestSeq = Math.min(...p.inputBuffer.keys());
      p.inputBuffer.delete(oldestSeq);
    }
    // Update ack seq
    if (input.seq > p.ackInputSeq) {
      p.ackInputSeq = input.seq;
    }
  }

  /**
   * Server tick loop — §4.3 order:
   * 1. Drain inputs
   * 2. Step movement
   * 3. Process fire (lag-comp hitscan)
   * 4. Apply outcomes
   * 5. Record history (lag-comp ring buffer)
   * 6. Respawns
   * 7. Build & broadcast snapshot
   */
  tick(): Snapshot {
    this.serverTick++;
    const dt = TICK_DT;
    this.events = [];

    // === Phase 1: Drain inputs & Step movement ===
    // Build other-players list for solid-no-push collision (§4.5)
    const allPlayers = [...this.players.values()];
    const otherPlayersList: Array<{ x: number; y: number; z: number; height: number }> =
      allPlayers.map(p => ({
        x: p.sim.pos.x, y: 0, z: p.sim.pos.z,
        height: p.sim.eyeHeight,
      }));

    for (const p of this.players.values()) {
      if (!p.connected) continue;

      if (!p.alive) {
        p.respawnTimer -= dt;
        if (p.respawnTimer <= 0) this.doRespawnPlayer(p);
        this.recordLagCompEntry(p);
        continue;
      }

      // --- Drain: pick highest-seq input not yet processed ---
      let input: InputFrame | null = null;
      let drainedSeq = -1;
      for (const [seq, buf] of p.inputBuffer) {
        if (seq > p.lastInputSeq && seq > drainedSeq) {
          input = buf;
          drainedSeq = seq;
        }
      }

      // If no new input, repeat last intent (clamped to ~10 ticks = 333ms)
      if (!input) {
        if (p.lastIntent && p.intentRepeatTicks < 10) {
          input = p.lastIntent;
          p.intentRepeatTicks++;
        } else {
          p.intentRepeatTicks = 0;
          // No input and no intent — still apply gravity/physics
          playerStep(p.sim, {
            seq: this.serverTick, viewTick: 0,
            moveX: 0, moveZ: 0,
            yaw: p.sim.yaw, pitch: p.sim.pitch,
            buttons: 0,
          }, dt, WORLD_BOUNDS, OBSTACLES, otherPlayersList.filter(o => !(Math.abs(o.x - p.sim.pos.x) < 1 && Math.abs(o.z - p.sim.pos.z) < 1)));
          this.recordLagCompEntry(p);
          continue;
        }
      } else {
        // Drain consumed input
        p.inputBuffer.delete(drainedSeq);
        p.lastInputSeq = drainedSeq;
        p.lastIntent = input;
        p.intentRepeatTicks = 0;
      }

      // --- Reload handling ---
      if (p.reloading) {
        p.reloadTimer -= dt;
        if (p.reloadTimer <= 0) {
          p.reloading = false;
          p.ammo = MAG_SIZE;
          this.events.push({ type: 'ReloadEnd', id: p.id });
        }
        playerStep(p.sim, input, dt, WORLD_BOUNDS, OBSTACLES, otherPlayersList);
        this.recordLagCompEntry(p);
        continue;
      }

      // --- Start reload ---
      if ((input.buttons & 8) && p.ammo < MAG_SIZE) {
        p.reloading = true;
        p.reloadTimer = RELOAD_TIME_S;
        this.events.push({ type: 'ReloadStart', id: p.id });
      }

      // --- Fire (lag-comp hitscan) ---
      p.fireCooldown -= dt;
      const fireRateDt = 60 / FIRE_RATE_RPM;
      if ((input.buttons & 4) && !p.reloading && p.ammo > 0 && p.fireCooldown <= 0) {
        p.ammo--;
        p.fireCooldown = fireRateDt;
        const origin = { x: p.sim.pos.x, y: p.sim.pos.y, z: p.sim.pos.z };
        const dirX = -Math.sin(input.yaw) * Math.cos(input.pitch);
        const dirY = Math.sin(input.pitch);
        const dirZ = -Math.cos(input.yaw) * Math.cos(input.pitch);
        this.events.push({ type: 'Shot', id: p.id, origin, dir: { x: dirX, y: dirY, z: dirZ } });
        // Lag-comp hitscan with viewTick
        this.doHitscan(origin, dirX, dirY, dirZ, p, input.viewTick);
      }

      // --- Jump event ---
      if ((input.buttons & 1) && p.sim.grounded) {
        this.events.push({ type: 'Jump', id: p.id });
      }

      // --- Step movement with other players as colliders (§4.5) ---
      playerStep(p.sim, input, dt, WORLD_BOUNDS, OBSTACLES, otherPlayersList);

      // --- Record lag-comp history ---
      this.recordLagCompEntry(p);
    }

    // === Phase 2: Bots ===
    for (const bot of this.bots) {
      if (!bot.alive) {
        bot.deathTimer -= dt;
        if (bot.deathTimer <= 0) this.doRespawnBot(bot);
        continue;
      }
      this.doBotAI(bot, dt);
    }

    // === Phase 3: Check KILL_GOAL (§4.3 step 4) ===
    if (!this.matchEnded) {
      for (const p of this.players.values()) {
        if (p.kills >= KILL_GOAL) {
          this.matchEnded = true;
          this.events.push({ type: 'MatchEnd', id: p.id, kills: p.kills });
          break;
        }
      }
    }

    // === Phase 4: Build & broadcast snapshot ===
    const states: PlayerState[] = [];
    for (const p of this.players.values()) {
      states.push({
        id: p.id, name: p.name,
        pos: { ...p.sim.pos }, vel: { ...p.sim.vel },
        yaw: p.sim.yaw, pitch: p.sim.pitch,
        hp: p.hp, ammo: p.ammo, alive: p.alive,
        crouch: p.sim.crouching, flags: p.reloading ? 1 : 0,
        kills: p.kills, deaths: p.deaths,
      });
    }
    for (const b of this.bots) {
      states.push({
        id: b.id, name: b.name,
        pos: { ...b.sim.pos }, vel: { ...b.sim.vel },
        yaw: b.sim.yaw, pitch: b.sim.pitch,
        hp: b.hp, ammo: 99, alive: b.alive,
        crouch: false, flags: 0, kills: b.kills, deaths: b.deaths,
      });
    }

    return {
      serverTick: this.serverTick,
      ackInputSeq: 0, // per-client acks tracked in ServerPlayer.ackInputSeq
      players: states,
      events: this.events,
    };
  }

  /**
   * Record one entry in the lag-comp ring buffer.
   * Keeps the last LAGCOMP_HISTORY_TICKS entries per player.
   */
  private recordLagCompEntry(p: ServerPlayer): void {
    p.lagCompHistory.push({
      tick: this.serverTick,
      eyeX: p.sim.pos.x, eyeY: p.sim.pos.y, eyeZ: p.sim.pos.z,
      yaw: p.sim.yaw, pitch: p.sim.pitch,
      alive: p.alive,
      crouching: p.sim.crouching,
    });
    // Trim old entries
    const maxAge = this.serverTick - LAGCOMP_HISTORY_TICKS;
    while (p.lagCompHistory.length > 1 && p.lagCompHistory[0].tick < maxAge) {
      p.lagCompHistory.shift();
    }
  }

  /**
   * Reconstruct a player's position at a given tick from lag-comp history.
   * Returns null if player has no history or is outside the window.
   */
  getPlayerStateAt(playerId: number, targetTick: number):
    { x: number; y: number; z: number; yaw: number; pitch: number; alive: boolean } | null {
    const p = this.players.get(playerId);
    if (!p || p.lagCompHistory.length === 0) return null;

    const hist = p.lagCompHistory;
    // Find bracketing entries
    let prev = hist[0];
    let next = hist[hist.length - 1];

    for (let i = 0; i < hist.length - 1; i++) {
      if (hist[i].tick <= targetTick && hist[i + 1].tick >= targetTick) {
        prev = hist[i];
        next = hist[i + 1];
        break;
      }
    }

    // If targetTick is before our oldest entry, use oldest
    if (targetTick < prev.tick) {
      return {
        x: prev.eyeX, y: prev.eyeY, z: prev.eyeZ,
        yaw: prev.yaw, pitch: prev.pitch, alive: prev.alive,
      };
    }

    // If after newest, use newest
    if (targetTick > next.tick) {
      return {
        x: next.eyeX, y: next.eyeY, z: next.eyeZ,
        yaw: next.yaw, pitch: next.pitch, alive: next.alive,
      };
    }

    // Interpolate between prev and next
    const range = next.tick - prev.tick;
    const t = range > 0 ? (targetTick - prev.tick) / range : 0;
    return {
      x: prev.eyeX + (next.eyeX - prev.eyeX) * t,
      y: prev.eyeY + (next.eyeY - prev.eyeY) * t,
      z: prev.eyeZ + (next.eyeZ - prev.eyeZ) * t,
      yaw: prev.yaw + (next.yaw - prev.yaw) * t,
      pitch: prev.pitch + (next.pitch - prev.pitch) * t,
      alive: prev.alive && next.alive,
    };
  }

  /**
   * Lag-compensated hitscan (§4.6).
   *
   * The shooter's viewTick tells us what tick the client was rendering at
   * when they fired. We rewind all targets to that tick to give a fair
   * hit check — "what the shooter saw is what they get."
   */
  private doHitscan(
    origin: { x: number; y: number; z: number },
    dx: number, dy: number, dz: number,
    shooter: ServerPlayer,
    viewTick: number,
  ): void {
    const hitRadius = PLAYER_EYE_HEIGHT; // Use player radius from shared
    const maxRange = HITSCAN_MAX_RANGE;

    // Validate viewTick — must be within lag-comp window
    let targetTick = viewTick;
    if (targetTick <= 0 || targetTick > this.serverTick) {
      targetTick = this.serverTick; // Fallback to current
    }
    const minTick = this.serverTick - LAGCOMP_HISTORY_TICKS;
    if (targetTick < minTick) {
      targetTick = minTick; // Clamp to oldest available
    }

    let closest = maxRange;
    let hitPlayer: ServerPlayer | null = null;
    let hitBot: ServerBot | null = null;
    let head = false;

    // Check other players at targetTick
    for (const p of this.players.values()) {
      if (p === shooter) continue;

      // Rewind target to viewTick
      const state = this.getPlayerStateAt(p.id, targetTick);
      if (!state || !state.alive) continue;

      const result = this.raycastEntity(origin, dx, dy, dz, state, hitRadius);
      if (result && result.dist < closest) {
        closest = result.dist;
        hitPlayer = p;
        head = result.head;
      }
    }

    // Check bots at targetTick (bots don't have lag-comp history, use current)
    for (const b of this.bots) {
      if (!b.alive) continue;
      const result = this.raycastEntity(origin, dx, dy, dz, b.sim.pos, hitRadius);
      if (result && result.dist < closest) {
        closest = result.dist;
        hitBot = b;
        head = result.head;
      }
    }

    // Apply damage (to current authoritative state)
    if (hitPlayer) {
      const dmg = head ? DAMAGE_HEAD : DAMAGE_BODY;
      hitPlayer.hp -= dmg;
      this.events.push({ type: 'Hit', by: shooter.id, target: hitPlayer.id, dmg, head });
      if (hitPlayer.hp <= 0) {
        hitPlayer.alive = false;
        hitPlayer.deaths++;
        hitPlayer.respawnTimer = RESPAWN_DELAY_S;
        shooter.kills++;
        this.events.push({ type: 'Kill', killer: shooter.id, victim: hitPlayer.id });
      }
    } else if (hitBot) {
      const dmg = head ? DAMAGE_HEAD : DAMAGE_BODY;
      hitBot.hp -= dmg;
      this.events.push({ type: 'Hit', by: shooter.id, target: hitBot.id, dmg, head });
      if (hitBot.hp <= 0) {
        hitBot.alive = false;
        hitBot.deaths++;
        hitBot.deathTimer = RESPAWN_DELAY_S;
        shooter.kills++;
        this.events.push({ type: 'Kill', killer: shooter.id, victim: hitBot.id });
      }
    }
  }

  /** Raycast against a single entity position. Returns {dist, head} or null. */
  private raycastEntity(
    origin: { x: number; y: number; z: number },
    dx: number, dy: number, dz: number,
    target: { x: number; y: number; z: number },
    radius: number,
  ): { dist: number; head: boolean } | null {
    const sx = target.x - origin.x;
    const sy = target.y - origin.y;
    const sz = target.z - origin.z;
    const dot = sx * dx + sy * dy + sz * dz;
    if (dot < 0 || dot > HITSCAN_MAX_RANGE) return null;
    const cx = origin.x + dx * dot;
    const cy = origin.y + dy * dot;
    const cz = origin.z + dz * dot;
    const ex = cx - target.x;
    const ey = cy - target.y;
    const ez = cz - target.z;
    const dist2 = ex * ex + ey * ey + ez * ez;
    if (dist2 < radius * radius) {
      return { dist: dot, head: cy > target.y + 0.2 };
    }
    return null;
  }

  private doBotAI(bot: ServerBot, dt: number): void {
    let nearest: ServerPlayer | null = null;
    let nearestDist2 = Infinity;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const dx = p.sim.pos.x - bot.sim.pos.x;
      const dz = p.sim.pos.z - bot.sim.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < nearestDist2) { nearestDist2 = d2; nearest = p; }
    }

    let buttons = 0;
    if (nearest && nearestDist2 < 100) {
      const dx = nearest.sim.pos.x - bot.sim.pos.x;
      const dz = nearest.sim.pos.z - bot.sim.pos.z;
      bot.sim.yaw = Math.atan2(-dx, -dz);
      bot.moveTimer -= dt;
      if (bot.moveTimer <= 0) {
        bot.patrolAngle = Math.atan2(-dx, -dz) + (Math.random() - 0.5) * 2;
        bot.moveTimer = 1 + Math.random() * 2;
      }
      bot.shootTimer -= dt;
      if (nearestDist2 < 400 && bot.shootTimer <= 0) {
        bot.shootTimer = 0.5 + Math.random() * 0.5;
        buttons |= 4;
        this.doBotShoot(bot, nearest);
      }
    } else {
      bot.moveTimer -= dt;
      if (bot.moveTimer <= 0) {
        bot.patrolAngle += (Math.random() - 0.5) * 2;
        bot.moveTimer = 2 + Math.random() * 3;
      }
      bot.sim.yaw = bot.patrolAngle;
    }

    const mx = Math.sin(-bot.patrolAngle);
    const mz = Math.cos(-bot.patrolAngle);
    playerStep(bot.sim, {
      seq: this.serverTick, viewTick: 0, moveX: mx, moveZ: mz,
      yaw: bot.sim.yaw, pitch: bot.sim.pitch, buttons,
    }, dt, WORLD_BOUNDS, OBSTACLES);
  }

  private doBotShoot(bot: ServerBot, target: ServerPlayer): void {
    if (!target.alive) return;
    const dx = target.sim.pos.x - bot.sim.pos.x;
    const dz = target.sim.pos.z - bot.sim.pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (Math.random() < Math.max(0.3, 1 - dist / 30)) {
      const dmg = DAMAGE_BODY;
      target.hp -= dmg;
      this.events.push({ type: 'Hit', by: bot.id, target: target.id, dmg, head: false });
      if (target.hp <= 0) {
        target.alive = false;
        target.deaths++;
        target.respawnTimer = RESPAWN_DELAY_S;
        bot.kills++;
        this.events.push({ type: 'Kill', killer: bot.id, victim: target.id });
      }
    }
  }

  private doRespawnPlayer(p: ServerPlayer): void {
    const sp = this.pickSpawn();
    p.sim.pos.x = sp.pos.x; p.sim.pos.y = sp.pos.y; p.sim.pos.z = sp.pos.z;
    p.sim.vel = { x: 0, y: 0, z: 0 };
    p.sim.yaw = sp.yaw; p.sim.pitch = 0; p.sim.grounded = false;
    p.hp = PLAYER_MAX_HP; p.ammo = MAG_SIZE; p.alive = true;
    p.reloading = false; p.reloadTimer = 0; p.fireCooldown = 0;
    this.recentSpawns.push({ pos: { ...p.sim.pos }, time: Date.now() / 1000 });
    this.events.push({ type: 'Spawn', id: p.id, pos: { ...p.sim.pos } });
  }

  private doRespawnBot(bot: ServerBot): void {
    const sp = this.pickSpawn();
    bot.sim.pos.x = sp.pos.x; bot.sim.pos.y = sp.pos.y; bot.sim.pos.z = sp.pos.z;
    bot.sim.vel = { x: 0, y: 0, z: 0 };
    bot.sim.yaw = sp.yaw; bot.sim.pitch = 0; bot.sim.grounded = false;
    bot.hp = PLAYER_MAX_HP; bot.alive = true; bot.deathTimer = 0;
  }

  private pickSpawn(): { pos: { x: number; y: number; z: number }; yaw: number } {
    const now = Date.now() / 1000;
    const all: Array<{ pos: { x: number; y: number; z: number }; yaw: number }> = [];
    for (const p of this.players.values()) if (p.alive) all.push({ pos: p.sim.pos, yaw: p.sim.yaw });
    for (const b of this.bots) if (b.alive) all.push({ pos: b.sim.pos, yaw: b.sim.yaw });
    return selectSpawnPoint(all, this.recentSpawns, now);
  }
}

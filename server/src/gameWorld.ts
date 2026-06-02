/**
 * Arena FPS — Server-side game world
 */
import {
  TICK_DT, PLAYER_MAX_HP, MAG_SIZE, DAMAGE_BODY, DAMAGE_HEAD,
  RESPAWN_DELAY_S, PLAYER_EYE_HEIGHT, ARENA_HALF,
  SPAWN_POSITIONS,
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
  inputBuffer: Map<number, InputFrame>;
  lastInputSeq: number;
  currentInput: InputFrame | null;
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
      inputBuffer: new Map(), lastInputSeq: 0, currentInput: null, connected: true,
    };
    this.players.set(id, p);
    this.recentSpawns.push({ pos: { ...p.sim.pos }, time: Date.now() / 1000 });
    this.events.push({ type: 'Spawn', id, pos: { ...p.sim.pos } });
    return id;
  }

  removePlayer(id: number): void {
    this.players.delete(id);
  }

  processInput(playerId: number, input: InputFrame): void {
    const p = this.players.get(playerId);
    if (!p) return;
    // Always accept the latest input — client sends every frame.
    // Store as current input to be consumed on next tick.
    p.currentInput = input;
  }

  tick(): Snapshot {
    this.serverTick++;
    const dt = TICK_DT;
    this.events = [];

    for (const p of this.players.values()) {
        if (!p.connected) continue;

        if (!p.alive) {
          p.respawnTimer -= dt;
          if (p.respawnTimer <= 0) this.doRespawnPlayer(p);
          continue;
        }

        // Use latest input from client
        const input = p.currentInput;
        if (!input) continue;

        // Reload
      if (p.reloading) {
        p.reloadTimer -= dt;
        if (p.reloadTimer <= 0) {
          p.reloading = false;
          p.ammo = MAG_SIZE;
          this.events.push({ type: 'ReloadEnd', id: p.id });
        }
        playerStep(p.sim, input, dt, WORLD_BOUNDS, OBSTACLES);
        continue;
      }

      // Start reload
      if ((input.buttons & 8) && p.ammo < MAG_SIZE) {
        p.reloading = true;
        p.reloadTimer = 1.6;
        this.events.push({ type: 'ReloadStart', id: p.id });
      }

      // Fire
      p.fireCooldown -= dt;
      if ((input.buttons & 4) && !p.reloading && p.ammo > 0 && p.fireCooldown <= 0) {
        p.ammo--;
        p.fireCooldown = 60 / 360;
        const origin = { x: p.sim.pos.x, y: p.sim.pos.y, z: p.sim.pos.z };
        const dirX = -Math.sin(input.yaw) * Math.cos(input.pitch);
        const dirY = Math.sin(input.pitch);
        const dirZ = -Math.cos(input.yaw) * Math.cos(input.pitch);
        this.events.push({ type: 'Shot', id: p.id, origin, dir: { x: dirX, y: dirY, z: dirZ } });
        this.doHitscan(origin, dirX, dirY, dirZ, p);
      }

      // Jump
      if ((input.buttons & 1) && p.sim.grounded) {
        this.events.push({ type: 'Jump', id: p.id });
      }

      playerStep(p.sim, input, dt, WORLD_BOUNDS, OBSTACLES);
    }

    // Bots
    for (const bot of this.bots) {
      if (!bot.alive) {
        bot.deathTimer -= dt;
        if (bot.deathTimer <= 0) this.doRespawnBot(bot);
        continue;
      }
      this.doBotAI(bot, dt);
    }

    // Build snapshot
    const states: PlayerState[] = [];
    for (const p of this.players.values()) {
      states.push({
        id: p.id, name: p.name,
        pos: { ...p.sim.pos }, vel: { ...p.sim.vel },
        yaw: p.sim.yaw, pitch: p.sim.pitch,
        hp: p.hp, ammo: p.ammo, alive: p.alive,
        crouch: p.sim.crouching, flags: p.reloading ? 1 : 0,
        kills: p.kills,
      });
    }
    for (const b of this.bots) {
      states.push({
        id: b.id, name: b.name,
        pos: { ...b.sim.pos }, vel: { ...b.sim.vel },
        yaw: b.sim.yaw, pitch: b.sim.pitch,
        hp: b.hp, ammo: 99, alive: b.alive,
        crouch: false, flags: 0, kills: b.kills,
      });
    }

    return {
      serverTick: this.serverTick,
      ackInputSeq: 0,
      players: states,
      events: this.events,
    };
  }

  private doHitscan(origin: { x: number; y: number; z: number },
    dx: number, dy: number, dz: number, shooter: ServerPlayer): void {
    const hitRadius = 0.5; // ~0.25^2 for body check
    let closest = 200;
    let hitPlayer: ServerPlayer | null = null;
    let hitBot: ServerBot | null = null;
    let head = false;

    // Check other players
    for (const p of this.players.values()) {
      if (p === shooter || !p.alive) continue;
      const result = this.raycastEntity(origin, dx, dy, dz, p.sim.pos, hitRadius);
      if (result && result.dist < closest) {
        closest = result.dist;
        hitPlayer = p;
        head = result.head;
      }
    }

    // Check bots
    for (const b of this.bots) {
      if (!b.alive) continue;
      const result = this.raycastEntity(origin, dx, dy, dz, b.sim.pos, hitRadius);
      if (result && result.dist < closest) {
        closest = result.dist;
        hitBot = b;
        head = result.head;
      }
    }

    // Apply damage
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
    if (dot < 0) return null;
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

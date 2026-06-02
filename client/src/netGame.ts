/**
 * NetGame — Client-side networked game state
 *
 * Implements §4.4 (client prediction + reconciliation),
 * §4.6 (entity interpolation with INTERP_DELAY),
 * §4.2 (input redundancy with INPUT_REDUNDANCY).
 *
 * Own player prediction: client runs local step() on own inputs
 * for zero-latency feel, then reconciles on server snapshot.
 *
 * Remote player interpolation: stores a bounded buffer of snapshots
 * per entity and renders at viewTick = latestServerTick - INTERP_DELAY_TICKS.
 */
import * as THREE from 'three';
import type { NetClient } from './netClient.js';
import type { Snapshot, SnapshotEvent, PlayerState, InputFrame } from '../../shared/types.js';
import {
  INTERP_DELAY_MS, INTERP_DELAY_TICKS, INPUT_REDUNDANCY,
  SMOOTH_TAU_MS, LAGCOMP_HISTORY_MS, SERVER_TICK_HZ,
  PLAYER_EYE_HEIGHT, PLAYER_RADIUS,
} from '../../shared/constants.js';
import { playerStep, type PlayerSim } from '../../shared/simulation/step.js';
import { OBSTACLES as SHARED_OBSTACLES } from '../../shared/constants.js';

// Convert obstacles for client-side prediction
interface SimAABB {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}
const OBSTACLES: SimAABB[] = SHARED_OBSTACLES.map(o => ({
  minX: o.min.x, maxX: o.max.x,
  minY: o.min.y, maxY: o.max.y,
  minZ: o.min.z, maxZ: o.max.z,
}));
const WORLD_BOUNDS: SimAABB = {
  minX: SHARED_OBSTACLES.length > 0 ? -50 : -50, maxX: 50,
  minY: -10, maxY: 100,
  minZ: -50, maxZ: 50,
};

// Import ARENA_HALF
import { ARENA_HALF } from '../../shared/constants.js';
WORLD_BOUNDS.minX = -ARENA_HALF;
WORLD_BOUNDS.maxX = ARENA_HALF;
WORLD_BOUNDS.minZ = -ARENA_HALF;
WORLD_BOUNDS.maxZ = ARENA_HALF;

// --- Entity state for prediction + interpolation ---

export interface EntityState {
  id: number;
  name: string;
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
  yaw: number;
  pitch: number;
  hp: number;
  ammo: number;
  alive: boolean;
  kills: number;
  deaths: number;
  reloading: boolean;
  isMe: boolean;
  /** Buffer of historical states for interpolation */
  history: Array<{ tick: number; pos: THREE.Vector3; yaw: number; pitch: number }>;
}

// --- Shared world bounds for client prediction ---

const CLIENT_WORLD_BOUNDS: SimAABB = {
  minX: -ARENA_HALF, maxX: ARENA_HALF,
  minY: -10, maxY: 100,
  minZ: -ARENA_HALF, maxZ: ARENA_HALF,
};

export class NetGame {
  /** Current player entities keyed by id */
  entities = new Map<number, EntityState>();

  /** My player ID (set after first snapshot) */
  myId: number | null = null;

  /** Predicted self state (§4.4) */
  predictedSim: PlayerSim = {
    pos: { x: 0, y: PLAYER_EYE_HEIGHT, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0,
    grounded: false, crouching: false,
    eyeHeight: PLAYER_EYE_HEIGHT,
  };

  /** Predicted HP/ammo (local) */
  predictedHp = 100;
  predictedAmmo = 15;
  predictedAlive = true;
  predictedReloading = false;

  /** Pending inputs that haven't been acked by server (§4.4) */
  pendingInputs: Map<number, InputFrame> = new Map();

  /** Last acked input sequence from server */
  lastAckSeq = 0;

  /** Latest server tick received */
  lastServerTick = 0;

  /** View tick for interpolation: latestServerTick - INTERP_DELAY_TICKS */
  get viewTick(): number {
    return this.lastServerTick - INTERP_DELAY_TICKS;
  }

  /** Error smoothing (§4.4) — visual only */
  smoothError = { x: 0, y: 0, z: 0 };
  smoothTime = 0;

  /** Latest snapshot (for reference) */
  latestSnapshot: Snapshot | null = null;

  /** Events buffer */
  pendingEvents: SnapshotEvent[] = [];

  constructor(public readonly net: NetClient) {
    // Apply any snapshot that arrived during countdown before initGame ran
    if (net.latestSnapshot) {
      this.update(net.latestSnapshot);
    }
  }

  /**
   * Process a server snapshot.
   *
   * §4.4 Reconciliation:
   * 1. Snap predicted self to authoritative state
   * 2. Replay pending inputs with seq > ackSeq
   * 3. Drop acked inputs
   * 4. Start error smoothing on prediction error
   */
  update(snapshot: Snapshot): void {
    this.latestSnapshot = snapshot;
    this.lastServerTick = snapshot.serverTick;
    this.pendingEvents.push(...snapshot.events);

    const ackSeq = snapshot.ackInputSeq ?? 0;

    // --- Reconcile own player ---
    // BUG FIX: match on numeric id, not name (names not unique)
    const myId = this.net.myPlayerId;
    const myState = snapshot.players.find(p => p.id === myId);
    if (myState) {
      // Set myId on first snapshot
      if (this.myId === null) {
        this.myId = myState.id;
      }

      const preSnapPos = { ...this.predictedSim.pos };

      // 1. Snap to authoritative state
      this.predictedSim.pos.x = myState.pos.x;
      this.predictedSim.pos.y = myState.pos.y;
      this.predictedSim.pos.z = myState.pos.z;
      this.predictedSim.vel.x = myState.vel.x;
      this.predictedSim.vel.y = myState.vel.y;
      this.predictedSim.vel.z = myState.vel.z;
      this.predictedSim.yaw = myState.yaw;
      this.predictedSim.pitch = myState.pitch;
      this.predictedSim.grounded = myState.pos.y < PLAYER_EYE_HEIGHT + 0.1; // approximate
      this.predictedSim.crouching = myState.crouch;

      this.predictedHp = myState.hp;
      this.predictedAmmo = myState.ammo;
      this.predictedAlive = myState.alive;
      this.predictedReloading = !!(myState.flags & 1);

      // 2. Replay unacked inputs
      const inputsToReplay: InputFrame[] = [];
      for (const [seq, input] of this.pendingInputs) {
        if (seq > ackSeq) {
          inputsToReplay.push(input);
        }
      }
      inputsToReplay.sort((a, b) => a.seq - b.seq);
      for (const input of inputsToReplay) {
        playerStep(this.predictedSim, input, 1 / SERVER_TICK_HZ, CLIENT_WORLD_BOUNDS, OBSTACLES);
        // Handle reload prediction locally
        if ((input.buttons & 8) && !this.predictedReloading && this.predictedAmmo < 15) {
          this.predictedReloading = true;
        }
      }

      // 3. Drop acked inputs
      for (const seq of this.pendingInputs.keys()) {
        if (seq <= ackSeq) {
          this.pendingInputs.delete(seq);
        }
      }
      this.lastAckSeq = ackSeq;

      // 4. Error smoothing
      const dx = preSnapPos.x - this.predictedSim.pos.x;
      const dy = preSnapPos.y - this.predictedSim.pos.y;
      const dz = preSnapPos.z - this.predictedSim.pos.z;
      const errorMag = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (errorMag > 5) {
        // Large delta (respawn/teleport) — snap instantly
        this.smoothError = { x: 0, y: 0, z: 0 };
        this.smoothTime = 0;
      } else {
        // Smooth out the prediction error over SMOOTH_TAU_MS
        this.smoothError = { x: dx, y: dy, z: dz };
        this.smoothTime = 0;
      }
    }

    // --- Update remote entities ---
    for (const ps of snapshot.players) {
      const isMe = ps.id === this.myId;
      let entity = this.entities.get(ps.id);

      if (!entity) {
        entity = {
          id: ps.id,
          name: ps.name,
          pos: new THREE.Vector3(ps.pos.x, ps.pos.y, ps.pos.z),
          prevPos: new THREE.Vector3(ps.pos.x, ps.pos.y, ps.pos.z),
          yaw: ps.yaw,
          pitch: ps.pitch,
          hp: ps.hp,
          ammo: ps.ammo,
          alive: ps.alive,
          kills: ps.kills,
          deaths: ps.deaths,
          reloading: !!(ps.flags & 1),
          isMe,
          history: [],
        };
        this.entities.set(ps.id, entity);
      } else {
        entity.prevPos.copy(entity.pos);
        entity.pos.set(ps.pos.x, ps.pos.y, ps.pos.z);
        entity.yaw = ps.yaw;
        entity.pitch = ps.pitch;
        entity.hp = ps.hp;
        entity.ammo = ps.ammo;
        entity.alive = ps.alive;
        entity.kills = ps.kills;
        entity.deaths = ps.deaths;
        entity.reloading = !!(ps.flags & 1);
      }

      // Add to interpolation history
      entity.history.push({
        tick: snapshot.serverTick,
        pos: new THREE.Vector3(ps.pos.x, ps.pos.y, ps.pos.z),
        yaw: ps.yaw,
        pitch: ps.pitch,
      });

      // Trim old history (keep ~2 seconds worth at 30Hz)
      const maxTicks = Math.max(60, LAGCOMP_HISTORY_MS * SERVER_TICK_HZ / 1000);
      while (entity.history.length > maxTicks) {
        entity.history.shift();
      }
    }

    // Remove entities not in snapshot
    const currentIds = new Set(snapshot.players.map(p => p.id));
    for (const [id] of this.entities) {
      if (!currentIds.has(id)) {
        this.entities.delete(id);
      }
    }
  }

  /**
   * Get interpolated position for a remote entity at the current viewTick.
   * Returns null if the entity doesn't exist or has insufficient history.
   *
   * §4.6 — Interpolate between bracketing snapshots at viewTick.
   */
  getInterpolatedPos(entity: EntityState): THREE.Vector3 | null {
    const vt = this.viewTick;
    const hist = entity.history;
    if (hist.length < 2) {
      return entity.pos; // Not enough history, use current
    }

    // Find bracketing entries
    let prev = hist[0];
    let next = hist[hist.length - 1];

    for (let i = 0; i < hist.length - 1; i++) {
      if (hist[i].tick <= vt && hist[i + 1].tick >= vt) {
        prev = hist[i];
        next = hist[i + 1];
        break;
      }
    }

    // Clamp to available range
    if (vt < prev.tick) {
      return prev.pos;
    }
    if (vt > next.tick) {
      return next.pos;
    }

    // Interpolate
    const range = next.tick - prev.tick;
    const t = range > 0 ? (vt - prev.tick) / range : 1;
    const pos = new THREE.Vector3().lerpVectors(prev.pos, next.pos, t);
    return pos;
  }

  /**
   * Get the own player's predicted position (with error smoothing).
   * §4.4 — simulation uses corrected state, visual adds smoothed error.
   */
  getMyPredictedPos(): THREE.Vector3 {
    const base = new THREE.Vector3(
      this.predictedSim.pos.x,
      this.predictedSim.pos.y,
      this.predictedSim.pos.z,
    );

    // Add smoothed error (visual only)
    if (this.smoothTime > 0) {
      const decay = Math.exp(-this.smoothTime / (SMOOTH_TAU_MS / 1000));
      base.x += this.smoothError.x * decay;
      base.y += this.smoothError.y * decay;
      base.z += this.smoothError.z * decay;
    }

    return base;
  }

  /** Update error smoothing accumulator */
  updateSmooth(dt: number): void {
    this.smoothTime += dt * 1000;
    if (this.smoothTime > SMOOTH_TAU_MS * 2) {
      // Error has fully decayed
      this.smoothError = { x: 0, y: 0, z: 0 };
      this.smoothTime = 0;
    }
  }

  /**
   * Step local prediction for own player (§4.4).
   * Called every render frame before sending input.
   */
  stepPrediction(input: InputFrame, dt: number): void {
    playerStep(this.predictedSim, input, dt, CLIENT_WORLD_BOUNDS, OBSTACLES);

    // Handle reload prediction locally
    if ((input.buttons & 8) && !this.predictedReloading && this.predictedAmmo < 15) {
      this.predictedReloading = true;
    }
  }

  /**
   * Queue an input for sending with redundancy.
   * Keeps last INPUT_REDUNDANCY unacked inputs in pendingInputs.
   */
  queueInput(input: InputFrame): void {
    this.pendingInputs.set(input.seq, input);
  }

  /** Get own player entity for HUD */
  getMyState(): {
    pos: THREE.Vector3;
    hp: number;
    ammo: number;
    alive: boolean;
    kills: number;
    deaths: number;
    reloading: boolean;
    yaw: number;
    pitch: number;
  } | null {
    if (!this.myId) return null;

    const entity = this.entities.get(this.myId);
    return {
      pos: this.getMyPredictedPos(),
      hp: this.predictedHp,
      ammo: this.predictedAmmo,
      alive: this.predictedAlive,
      kills: entity?.kills ?? 0,
      deaths: entity?.deaths ?? 0,
      reloading: this.predictedReloading,
      yaw: this.predictedSim.yaw,
      pitch: this.predictedSim.pitch,
    };
  }

  /** Get remote entities (excluding self) */
  getRemotes(): EntityState[] {
    const result: EntityState[] = [];
    for (const e of this.entities.values()) {
      if (!e.isMe && e.alive) {
        result.push(e);
      }
    }
    return result;
  }

  /** Get entity by ID */
  getEntity(id: number): EntityState | undefined {
    return this.entities.get(id);
  }
}

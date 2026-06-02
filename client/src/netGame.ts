/**
 * Arena FPS — Networked game state
 *
 * Manages the client-side state for networked matches:
 * - Sends input frames to server
 * - Receives snapshots and builds an entity map
 * - Provides interpolated player positions for rendering
 * - Processes server events (kills, spawns, hits)
 */
import type { InputFrame, Snapshot, PlayerState, SnapshotEvent } from '../../shared/types';
import type { NetClient } from './netClient';
import * as THREE from 'three';

// --- Button bits (match server) ---
const BTN_JUMP = 1;
const BTN_FIRE = 4;
const BTN_RELOAD = 8;

// --- Interpolation buffer ---
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
  isMe: boolean;
  reloading: boolean;
}

// --- Networked game state ---
export class NetGame {
  /** Map of entity ID → current state */
  entities = new Map<number, EntityState>();
  /** My player ID (set when snapshot arrives) */
  myId: number | null = null;
  /** Latest snapshot tick */
  lastTick: number = 0;
  /** Active events from latest snapshot */
  pendingEvents: SnapshotEvent[] = [];

  /** Constructor */
  constructor(private net: NetClient) {}

  /** Update from latest snapshot. Call every frame or every tick. */
  update(): void {
    const snap = this.net.latestSnapshot;
    if (!snap) return;
    if (snap.serverTick === this.lastTick) return; // no new data
    this.lastTick = snap.serverTick;

    // Process events first
    this.pendingEvents = snap.events || [];

    // Update entity map
    const newIds = new Set<number>();
    for (const ps of snap.players) {
      newIds.add(ps.id);
      let ent = this.entities.get(ps.id);
      if (!ent) {
        // New entity
        ent = {
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
          deaths: ps.deaths ?? 0,
          isMe: false,
          reloading: !!(ps.flags & 1),
        };
        this.entities.set(ps.id, ent);
      } else {
        // Update existing
        ent.prevPos.copy(ent.pos);
        ent.pos.set(ps.pos.x, ps.pos.y, ps.pos.z);
        ent.yaw = ps.yaw;
        ent.pitch = ps.pitch;
        ent.hp = ps.hp;
        ent.ammo = ps.ammo;
        ent.alive = ps.alive;
        ent.kills = ps.kills;
        ent.reloading = !!(ps.flags & 1);
      }
    }

    // Remove entities no longer in snapshot
    for (const [id] of this.entities) {
      if (!newIds.has(id)) {
        this.entities.delete(id);
      }
    }

    // Determine my ID from name
    if (this.myId === null) {
      const myName = this.net.name;
      for (const ps of snap.players) {
        if (ps.name === myName) {
          this.myId = ps.id;
          break;
        }
      }
    }

    // Mark 'me' flag
    for (const ent of this.entities.values()) {
      ent.isMe = ent.id === this.myId;
    }
  }

  /** Get my player entity */
  getMe(): EntityState | null {
    if (this.myId === null) return null;
    return this.entities.get(this.myId) || null;
  }

  /** Get all entities except me */
  getOthers(): EntityState[] {
    return [...this.entities.values()].filter(e => !e.isMe);
  }

  /** Get all entities */
  getAll(): EntityState[] {
    return [...this.entities.values()];
  }

  /** Get an entity by ID */
  get(id: number): EntityState | undefined {
    return this.entities.get(id);
  }

  /** Get all entities by name */
  getByName(name: string): EntityState | undefined {
    for (const e of this.entities.values()) {
      if (e.name === name) return e;
    }
    return undefined;
  }

  /** Reset state (new match) */
  reset(): void {
    this.entities.clear();
    this.myId = null;
    this.lastTick = 0;
    this.pendingEvents = [];
  }

  /** Send input frame to server */
  sendInput(seq: number, input: { moveX: number; moveZ: number; yaw: number; pitch: number; buttons: number }): void {
    this.net.sendInput(seq, input.moveX, input.moveZ, input.yaw, input.pitch, input.buttons);
  }
}

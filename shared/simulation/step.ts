// =============================================================================
// Arena FPS — Deterministic simulation step (shared between client & server)
// Pure function: same inputs => same outputs. No wall-clock, no DOM.
// =============================================================================
import {
  GRAVITY, JUMP_VELOCITY, MOVE_SPEED, CROUCH_SPEED,
  GROUND_ACCEL, GROUND_FRICTION, AIR_ACCEL,
  PLAYER_EYE_HEIGHT, PLAYER_CROUCH_HEIGHT, PLAYER_RADIUS,
  MAX_SLOPE_WALKABLE_DEG,
} from '../constants.js';
import type { InputFrame } from '../types';
import { clamp } from '../math.js';

const MAX_SLOPE_DOT = Math.cos((MAX_SLOPE_WALKABLE_DEG * Math.PI) / 180);

export interface PlayerSim {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  crouching: boolean;
  eyeHeight: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface AABB {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

// Scratch vectors to avoid allocation
const _dir = { x: 0, y: 0, z: 0 };
const _inputDir = { x: 0, y: 0, z: 0 };
const _pushDir = { x: 0, y: 0, z: 0 };

/**
 * Resolve capsule-vs-AABB collision.
 * Treats the player as a vertical capsule (swept to previous position) and pushes them
 * out of penetration along the minimum translation vector.
 * This is a simplified but effective approach for box obstacles.
 */
function resolveCapsuleAABB(
  p: PlayerSim,
  aabb: AABB,
  radius: number,
  _dt: number
): void {
  // Capsule center is at eye height; feet are at pos.y - eyeHeight
  const feetY = p.pos.y - p.eyeHeight;
  const topY = feetY + p.eyeHeight + 0.1; // slight margin above head
  const bottomY = feetY - 0.1; // slight margin below feet

  // Clamp capsule center to AABB expanded by radius on X/Z
  const cx = clamp(p.pos.x, aabb.minX - radius, aabb.maxX + radius);
  const cz = clamp(p.pos.z, aabb.minZ - radius, aabb.maxZ + radius);

  // Check if capsule overlaps AABB in Y
  const yOverlap = topY > aabb.minY && bottomY < aabb.maxY;
  if (!yOverlap) return;

  // Distance from capsule center to closest point on AABB in XZ
  const closestX = clamp(p.pos.x, aabb.minX, aabb.maxX);
  const closestZ = clamp(p.pos.z, aabb.minZ, aabb.maxZ);

  const dx = p.pos.x - closestX;
  const dz = p.pos.z - closestZ;
  const distXZ = Math.sqrt(dx * dx + dz * dz);

  // No collision if capsule center is far enough from AABB
  if (distXZ >= radius || distXZ < 0.0001) return;

  // Penetration depth
  const penetration = radius - distXZ;

  // Push direction (away from closest point)
  if (distXZ < 0.0001) {
    // Capsule center is directly above/below AABB — push up
    p.pos.y += Math.max(0, aabb.maxY - topY) > 0 ? 0 : penetration;
    return;
  }

  const pushX = (dx / distXZ) * penetration;
  const pushZ = (dz / distXZ) * penetration;

  p.pos.x += pushX;
  p.pos.z += pushZ;

  // Kill velocity component in push direction (prevent sliding into walls)
  const dot = p.vel.x * (dx / distXZ) + p.vel.z * (dz / distXZ);
  if (dot < 0) {
    p.vel.x -= dot * (dx / distXZ);
    p.vel.z -= dot * (dz / distXZ);
  }
}

/**
 * Resolve capsule-vs-capsule collision (player-vs-player).
 * Other player is treated as an immovable static collider (§4.5).
 * Only the moving player is displaced; the other is untouched.
 */
function resolveCapsuleVsCapsule(
  p: PlayerSim,
  other: { x: number; y: number; z: number; height: number },
  radius: number,
): void {
  // Horizontal distance between capsule centers
  const dx = p.pos.x - other.x;
  const dz = p.pos.z - other.z;
  const distXZ = Math.sqrt(dx * dx + dz * dz);
  const minDist = radius * 2; // two radii

  // Check vertical overlap
  const feetY = p.pos.y - p.eyeHeight;
  const topY = feetY + p.eyeHeight;
  const yOverlap = topY > other.y && feetY < other.y + other.height;
  if (!yOverlap) return;

  // No collision if far enough
  if (distXZ >= minDist || distXZ < 0.0001) return;

  // Push the moving player out
  const penetration = minDist - distXZ;
  const pushX = (dx / distXZ) * penetration;
  const pushZ = (dz / distXZ) * penetration;
  p.pos.x += pushX;
  p.pos.z += pushZ;
}

/**
 * Single fixed-timestep simulation step for one player.
 * Mutates the player state in place for performance.
 * Returns whether the player is grounded after this step.
 */
export function playerStep(
  p: PlayerSim,
  input: InputFrame,
  dt: number,
  worldBounds: { minY: number; maxY: number; minX: number; maxX: number; minZ: number; maxZ: number },
  obstacles: AABB[] = [],
  /** Other players as static colliders (§4.5 — solid, no push) */
  otherPlayers?: Array<{ x: number; y: number; z: number; height: number }>,
): boolean {
  // --- Update yaw/pitch from input ---
  p.yaw = input.yaw;
  p.pitch = input.pitch;

  // --- Crouch state ---
  const wantsCrouch = !!(input.buttons & 2); // CROUCH bit
  p.crouching = wantsCrouch;
  p.eyeHeight = p.crouching ? PLAYER_CROUCH_HEIGHT : PLAYER_EYE_HEIGHT;

  // --- Compute move direction in world space from yaw ---
  const cosYaw = Math.cos(-p.yaw);
  const sinYaw = Math.sin(-p.yaw);
  _dir.x = input.moveX * cosYaw - input.moveZ * sinYaw;
  _dir.z = input.moveX * sinYaw + input.moveZ * cosYaw;
  const len = Math.sqrt(_dir.x * _dir.x + _dir.z * _dir.z);
  if (len > 0.001) {
    _dir.x /= len;
    _dir.z /= len;
  }

  // --- Acceleration ---
  const speed = p.crouching ? CROUCH_SPEED : MOVE_SPEED;
  const accel = p.grounded ? GROUND_ACCEL : AIR_ACCEL;
  const friction = p.grounded ? GROUND_FRICTION : 0;
  const targetX = _dir.x * speed;
  const targetZ = _dir.z * speed;
  const accelDt = accel * dt;
  if (targetX > p.vel.x + accelDt) {
    p.vel.x = targetX;
  } else if (targetX < p.vel.x - accelDt) {
    p.vel.x = targetX;
  } else {
    p.vel.x += (targetX - p.vel.x) * Math.min(1, accelDt / Math.abs(targetX - p.vel.x + 0.001));
  }
  if (targetZ > p.vel.z + accelDt) {
    p.vel.z = targetZ;
  } else if (targetZ < p.vel.z - accelDt) {
    p.vel.z = targetZ;
  } else {
    p.vel.z += (targetZ - p.vel.z) * Math.min(1, accelDt / Math.abs(targetZ - p.vel.z + 0.001));
  }

  // --- Friction (ground only) ---
  if (p.grounded && friction > 0) {
    const frictionImpulse = friction * dt;
    if (p.vel.x > 0) p.vel.x = Math.max(0, p.vel.x - frictionImpulse);
    else if (p.vel.x < 0) p.vel.x = Math.min(0, p.vel.x + frictionImpulse);
    if (p.vel.z > 0) p.vel.z = Math.max(0, p.vel.z - frictionImpulse);
    else if (p.vel.z < 0) p.vel.z = Math.min(0, p.vel.z + frictionImpulse);
  }

  // --- Clamp horizontal speed ---
  const hSpeed = Math.sqrt(p.vel.x * p.vel.x + p.vel.z * p.vel.z);
  if (hSpeed > speed) {
    p.vel.x = (p.vel.x / hSpeed) * speed;
    p.vel.z = (p.vel.z / hSpeed) * speed;
  }

  // --- Gravity ---
  if (!p.grounded) {
    p.vel.y -= GRAVITY * dt;
  }

  // --- Jump ---
  if (!!(input.buttons & 1) && p.grounded) { // JUMP bit
    p.vel.y = JUMP_VELOCITY;
    p.grounded = false;
  }

  // --- Integrate position ---
  p.pos.x += p.vel.x * dt;
  p.pos.y += p.vel.y * dt;
  p.pos.z += p.vel.z * dt;

  // --- Floor collision ---
  const feetY = p.pos.y - p.eyeHeight;
  if (feetY < 0) {
    p.pos.y = p.eyeHeight;
    p.vel.y = 0;
    p.grounded = true;
  }

  // --- Arena bounds ---
  p.pos.x = clamp(p.pos.x, worldBounds.minX + PLAYER_RADIUS, worldBounds.maxX - PLAYER_RADIUS);
  p.pos.z = clamp(p.pos.z, worldBounds.minZ + PLAYER_RADIUS, worldBounds.maxZ - PLAYER_RADIUS);

  // --- Obstacle collision (capsule-vs-AABB, iterative resolve) ---
  for (let iter = 0; iter < 3; iter++) {
    for (let i = 0; i < obstacles.length; i++) {
      resolveCapsuleAABB(p, obstacles[i], PLAYER_RADIUS, dt);
    }
  }

  // --- Player-vs-player collision (§4.5 — solid, no push) ---
  if (otherPlayers) {
    for (const other of otherPlayers) {
      resolveCapsuleVsCapsule(p, other, PLAYER_RADIUS);
    }
  }

  // Return true if player is still in bounds (false = OOB death)
  return true;
}

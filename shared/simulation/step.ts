// =============================================================================
// Arena FPS — Deterministic simulation step (shared between client & server)
// Pure function: same inputs => same outputs. No wall-clock, no DOM.
// =============================================================================
import {
  GRAVITY, JUMP_VELOCITY, MOVE_SPEED, CROUCH_SPEED,
  GROUND_ACCEL, GROUND_FRICTION, AIR_ACCEL,
  PLAYER_EYE_HEIGHT, PLAYER_CROUCH_HEIGHT, PLAYER_RADIUS,
  MAX_SLOPE_WALKABLE_DEG,
} from '../constants';
import type { InputFrame } from '../types';
import { clamp } from '../math';

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

// Scratch vectors to avoid allocation
const _dir = { x: 0, y: 0, z: 0 };
const _inputDir = { x: 0, y: 0, z: 0 };

/**
 * Single fixed-timestep simulation step for one player.
 * Mutates the player state in place for performance.
 * Returns whether the player is grounded after this step.
 */
export function playerStep(
  p: PlayerSim,
  input: InputFrame,
  dt: number,
  worldBounds: { minY: number; maxY: number; minX: number; maxX: number; minZ: number; maxZ: number }
): void {
  // --- Update yaw/pitch from input ---
  p.yaw = input.yaw;
  p.pitch = input.pitch;

  // --- Crouch state ---
  const wantsCrouch = !!(input.buttons & 2); // CROUCH bit
  p.crouching = wantsCrouch;
  p.eyeHeight = p.crouching ? PLAYER_CROUCH_HEIGHT : PLAYER_EYE_HEIGHT;

  // --- Compute move direction in world space from yaw ---
  const cosYaw = Math.cos(p.yaw);
  const sinYaw = Math.sin(p.yaw);

  // Forward = -Z in three.js, Right = +X
  _dir.x = input.moveX * cosYaw - input.moveZ * sinYaw;
  _dir.z = input.moveX * sinYaw + input.moveZ * cosYaw;

  // Normalize diagonal input
  const len = Math.sqrt(_dir.x * _dir.x + _dir.z * _dir.z);
  if (len > 0.001) {
    _dir.x /= len;
    _dir.z /= len;
  }

  // --- Acceleration ---
  const speed = p.crouching ? CROUCH_SPEED : MOVE_SPEED;
  const accel = p.grounded ? GROUND_ACCEL : AIR_ACCEL;
  const friction = p.grounded ? GROUND_FRICTION : 0;

  // Apply acceleration toward input direction
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
    if (p.vel.x > 0) {
      p.vel.x = Math.max(0, p.vel.x - frictionImpulse);
    } else if (p.vel.x < 0) {
      p.vel.x = Math.min(0, p.vel.x + frictionImpulse);
    }
    if (p.vel.z > 0) {
      p.vel.z = Math.max(0, p.vel.z - frictionImpulse);
    } else if (p.vel.z < 0) {
      p.vel.z = Math.min(0, p.vel.z + frictionImpulse);
    }
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

  // --- Floor collision (simple: ground at y=0 for now) ---
  const feetY = p.pos.y - p.eyeHeight;
  if (feetY < 0) {
    p.pos.y = p.eyeHeight;
    p.vel.y = 0;
    p.grounded = true;
  }

  // --- Arena bounds ---
  p.pos.x = clamp(p.pos.x, worldBounds.minX + PLAYER_RADIUS, worldBounds.maxX - PLAYER_RADIUS);
  p.pos.z = clamp(p.pos.z, worldBounds.minZ + PLAYER_RADIUS, worldBounds.maxZ - PLAYER_RADIUS);
}

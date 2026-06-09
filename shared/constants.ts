// =============================================================================
// Arena FPS — Single source of truth for all tunable constants
// All gameplay values imported from here. Never inline a magic number.
// =============================================================================

// --- Player & health ---
export const PLAYER_MAX_HP = 100;
export const PLAYER_EYE_HEIGHT = 1.6;
export const PLAYER_CROUCH_HEIGHT = 0.9;
export const PLAYER_RADIUS = 0.4;
export const HITBOX_BODY_RADIUS = 0.4;  // same as PLAYER_RADIUS
export const HITBOX_HEAD_RADIUS = 0.25;
export const HITBOX_HEAD_OFFSET = 0.15; // metres above eyeY
export const PLAYER_STAND_HEIGHT = 1.8;
export const RESPAWN_DELAY_S = 5;
export const SPAWN_PROTECTION_S = 0;

// --- Movement (tune after gameplay is functional) ---
export const MOVE_SPEED = 7.0;
export const CROUCH_SPEED = 3.5;
export const GROUND_ACCEL = 120;
export const GROUND_FRICTION = 20;
export const AIR_ACCEL = 40;
export const JUMP_VELOCITY = 6.0;
export const GRAVITY = 20;
export const MAX_SLOPE_WALKABLE_DEG = 50;

// --- Weapon (pistol) ---
export const MAG_SIZE = 15;
export const RESERVE_AMMO = Infinity;
export const DAMAGE_BODY = 34;
export const DAMAGE_HEAD = 100; // instant-kill headshot
export const FIRE_MODE = 'semi' as const;
export const FIRE_RATE_RPM = 360; // ~6/s cap
export const BOT_FIRE_RATE_RPM = 300; // 5 shots/s for bots
export const RELOAD_TIME_S = 1.6;
export const HITSCAN_MAX_RANGE = 200;
export const SPREAD_RAD = 0; // system present, pinpoint for now

// --- Match ---
export const MAX_PLAYERS = 8;
export const KILL_GOAL = 30;
export const POST_MATCH_DURATION_S = 15;
export const START_COUNTDOWN_S = 3;
export const LOBBY_CODE_LENGTH = 5;
export const MAX_ROOMS = 50;
export const NAME_MIN = 3;
export const NAME_MAX = 20;
export const SPAWN_POINTS = 8;

// Spawn selection weights
export const W_DIST = 1.0;
export const W_VISIBLE = 1000;
export const W_RECENT = 50;
export const RECENT_SPAWN_WINDOW = 2;

// Authored spawn points (8 positions around the 40x40 arena)
import type { SpawnPoint } from '../shared/types';
export const SPAWN_POSITIONS: SpawnPoint[] = [
  { pos: { x: -15, y: 1.6, z: -15 }, yaw: 0.79 },    // SW corner
  { pos: { x: 15, y: 1.6, z: -15 }, yaw: 2.36 },     // SE corner
  { pos: { x: -15, y: 1.6, z: 15 }, yaw: -2.36 },    // NW corner
  { pos: { x: 15, y: 1.6, z: 15 }, yaw: -0.79 },     // NE corner
  { pos: { x: 0, y: 1.6, z: -17 }, yaw: 0 },         // South mid
  { pos: { x: 0, y: 1.6, z: 17 }, yaw: Math.PI },    // North mid
  { pos: { x: -17, y: 1.6, z: 0 }, yaw: -Math.PI/2 }, // West mid
  { pos: { x: 17, y: 1.6, z: 0 }, yaw: Math.PI/2 },  // East mid
];

// --- Networking ---
export const SERVER_TICK_HZ = 30; // must also work at 60
export const TICK_DT = 1 / SERVER_TICK_HZ;
export const SNAPSHOT_HZ = SERVER_TICK_HZ;
export const INTERP_DELAY_MS = 100;
export const INTERP_DELAY_TICKS = Math.round((INTERP_DELAY_MS / 1000) * SERVER_TICK_HZ);
export const LAGCOMP_HISTORY_MS = 1000;
export const LAGCOMP_HISTORY_TICKS = Math.round((LAGCOMP_HISTORY_MS / 1000) * SERVER_TICK_HZ);
export const INPUT_REDUNDANCY = 3;
export const INPUT_BUFFER_MAX = 128;
export const MAX_INPUTS_PER_TICK = 5;
export const SMOOTH_TAU_MS = 100;
export const HEARTBEAT_INTERVAL_S = 25;
export const HEARTBEAT_MISS_LIMIT = 3;

// --- Audio ---
export const AUDIO_MAX_DISTANCE = 60;
export const AUDIO_REF_DISTANCE = 3;
export const AUDIO_ROLLOFF_FACTOR = 1;
export const AUDIO_FOOTSTEP_INTERVAL_TICKS = 3; // footsteps every 3 server ticks (~0.1s)
export const AUDIO_SHOOT_VOLUME = 0.4;
export const AUDIO_RELOAD_VOLUME = 0.2;
export const AUDIO_FOOTSTEP_VOLUME = 0.15;
export const AUDIO_JUMP_VOLUME = 0.1;
export const AUDIO_LAND_VOLUME = 0.2;

// --- HUD ---
export const KILL_FEED_MAX = 8;
export const KILL_FEED_DURATION_S = 5;
export const HIT_MARKER_DURATION_S = 0.15;
export const DAMAGE_INDICATOR_DURATION_S = 0.3;
export const FPS_COUNTER_MAX_FPS = 240;

// --- Arena layout (shared between client & server) ---
export const ARENA_HALF = 20;

import type { AABB } from './types';
export const OBSTACLES: AABB[] = [
  // Central cover: { x: 0, z: 0, w: 3, h: 2, d: 3 }
  { min: { x: -1.5, y: 0, z: -1.5 }, max: { x: 1.5, y: 2, z: 1.5 } },
  // { x: 6, z: 6, w: 2, h: 2.5, d: 2 }
  { min: { x: 5, y: 0, z: 5 }, max: { x: 7, y: 2.5, z: 7 } },
  // { x: -6, z: 6, w: 2, h: 2.5, d: 2 }
  { min: { x: -7, y: 0, z: 5 }, max: { x: -5, y: 2.5, z: 7 } },
  // { x: 6, z: -6, w: 2, h: 2.5, d: 2 }
  { min: { x: 5, y: 0, z: -7 }, max: { x: 7, y: 2.5, z: -5 } },
  // { x: -6, z: -6, w: 2, h: 2.5, d: 2 }
  { min: { x: -7, y: 0, z: -7 }, max: { x: -5, y: 2.5, z: -5 } },
  // Corner cover: { x: 12, z: 12, w: 3, h: 1.5, d: 1.5 }
  { min: { x: 10.5, y: 0, z: 11.25 }, max: { x: 13.5, y: 1.5, z: 12.75 } },
  // { x: -12, z: 12, w: 3, h: 1.5, d: 1.5 }
  { min: { x: -13.5, y: 0, z: 11.25 }, max: { x: -10.5, y: 1.5, z: 12.75 } },
  // { x: 12, z: -12, w: 3, h: 1.5, d: 1.5 }
  { min: { x: 10.5, y: 0, z: -12.75 }, max: { x: 13.5, y: 1.5, z: -11.25 } },
  // { x: -12, z: -12, w: 3, h: 1.5, d: 1.5 }
  { min: { x: -13.5, y: 0, z: -12.75 }, max: { x: -10.5, y: 1.5, z: -11.25 } },
  // Mid-edge: { x: 10, z: 0, w: 1.5, h: 2, d: 4 }
  { min: { x: 9.25, y: 0, z: -2 }, max: { x: 10.75, y: 2, z: 2 } },
  // { x: -10, z: 0, w: 1.5, h: 2, d: 4 }
  { min: { x: -10.75, y: 0, z: -2 }, max: { x: -9.25, y: 2, z: 2 } },
  // { x: 0, z: 11, w: 4, h: 2, d: 1.5 }
  { min: { x: -2, y: 0, z: 10.25 }, max: { x: 2, y: 2, z: 11.75 } },
  // { x: 0, z: -11, w: 4, h: 2, d: 1.5 }
  { min: { x: -2, y: 0, z: -11.75 }, max: { x: 2, y: 2, z: -10.25 } },
];

// =============================================================================
// Arena FPS — Single source of truth for all tunable constants
// All gameplay values imported from here. Never inline a magic number.
// =============================================================================

// --- Player & health ---
export const PLAYER_MAX_HP = 100;
export const PLAYER_EYE_HEIGHT = 1.6;
export const PLAYER_CROUCH_HEIGHT = 0.9;
export const PLAYER_RADIUS = 0.4;
export const PLAYER_STAND_HEIGHT = 1.8;
export const RESPAWN_DELAY_S = 5;
export const SPAWN_PROTECTION_S = 0;

// --- Movement (tune after gameplay is functional) ---
export const MOVE_SPEED = 7.0;
export const CROUCH_SPEED = 3.5;
export const GROUND_ACCEL = 60;
export const GROUND_FRICTION = 50;
export const AIR_ACCEL = 12;
export const JUMP_VELOCITY = 6.0;
export const GRAVITY = 20;
export const MAX_SLOPE_WALKABLE_DEG = 50;

// --- Weapon (pistol) ---
export const MAG_SIZE = 15;
export const RESERVE_AMMO = Infinity;
export const DAMAGE_BODY = 22;
export const DAMAGE_HEAD = 66; // 3× headshot multiplier
export const FIRE_MODE = 'semi' as const;
export const FIRE_RATE_RPM = 360; // ~6/s cap
export const RELOAD_TIME_S = 1.6;
export const HITSCAN_MAX_RANGE = 200;
export const SPREAD_RAD = 0; // system present, pinpoint for now

// --- Match ---
export const MAX_PLAYERS = 8;
export const KILL_GOAL = 30;
export const POST_MATCH_DURATION_S = 15;
export const START_COUNTDOWN_S = 3;
export const LOBBY_CODE_LENGTH = 5;
export const NAME_MIN = 3;
export const NAME_MAX = 20;
export const SPAWN_POINTS = 8;

// Spawn selection weights
export const W_DIST = 1.0;
export const W_VISIBLE = 1000;
export const W_RECENT = 50;
export const RECENT_SPAWN_WINDOW = 2;

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
export const SMOOTH_TAU_MS = 100;
export const HEARTBEAT_INTERVAL_S = 25;
export const HEARTBEAT_MISS_LIMIT = 3;

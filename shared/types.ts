// =============================================================================
// Arena FPS — Shared types between client and server
// =============================================================================

// --- Input ---

/** Bitmask for input buttons */
export const ButtonFlags = {
  JUMP:    1 << 0,
  CROUCH:  1 << 1,
  FIRE:    1 << 2,
  RELOAD:  1 << 3,
} as const;

export interface InputFrame {
  seq: number;          // monotonic per client
  viewTick: number;     // fractional server tick the client was rendering remotes at
  moveX: number;        // -1..1 strafe
  moveZ: number;        // -1..1 fwd/back
  yaw: number;          // radians
  pitch: number;        // radians
  buttons: number;      // bitmask from ButtonFlags
}

// --- Player state (authoritative snapshot) ---

export interface PlayerState {
  id: number;
  name: string;
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  yaw: number;          // radians
  pitch: number;        // radians
  hp: number;
  ammo: number;
  alive: boolean;
  crouch: boolean;
  flags: number;        // bitmask for additional state (reloading, etc.)
  kills: number;
  deaths: number;
}

// --- Snapshot events ---

export type SnapshotEvent =
  | { type: 'Hit'; by: number; target: number; dmg: number; head: boolean }
  | { type: 'Kill'; killer: number; victim: number }
  | { type: 'Spawn'; id: number; pos: { x: number; y: number; z: number } }
  | { type: 'ReloadStart'; id: number }
  | { type: 'ReloadEnd'; id: number }
  | { type: 'Shot'; id: number; origin: { x: number; y: number; z: number }; dir: { x: number; y: number; z: number } }
  | { type: 'Jump'; id: number }
  | { type: 'Land'; id: number }
  | { type: 'Footstep'; id: number };

export interface Snapshot {
  serverTick: number;
  ackInputSeq: number;
  players: PlayerState[];
  events: SnapshotEvent[];
}

// --- Lobby / Room ---

export type RoomState = 'LOBBY' | 'STARTING' | 'IN_PROGRESS' | 'POST_MATCH' | 'DISBAND';

export interface RoomPlayer {
  id: number;
  name: string;
  ready: boolean;
  score: number;
  left: boolean;
}

export interface Room {
  code: string;
  state: RoomState;
  hostId: number;
  players: RoomPlayer[];
}

// --- Settings ---

export type CrosshairType = 'dot' | 'cross' | 'crossdot' | 'circle';
export type GraphicsQuality = 'high' | 'low';

export interface Settings {
  sensitivity: number;
  fov: number;
  crosshairColour: string;
  crosshairSize: number;
  crosshairType: CrosshairType;
  graphicsQuality: GraphicsQuality;
  playerName: string;
}

// --- Input Source ---

export interface InputSource {
  /** Poll current input frame. Returns null if no input. */
  poll(): InputFrame | null;
  /** Release resources / remove event listeners. */
  dispose(): void;
}

// --- World / Collision ---

export interface AABB {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface SpawnPoint {
  pos: { x: number; y: number; z: number };
  yaw: number;
}

export interface RampPlane {
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
}

export interface WorldDef {
  obstacles: AABB[];
  ramps: RampPlane[];
  spawnPoints: SpawnPoint[];
  bounds: AABB;
}

import { WebSocket } from 'ws';
import { GameWorld, allocatePlayerId } from './gameWorld.js';

// --- Re-exported from constants ---
export { MAX_PLAYERS, KILL_GOAL, POST_MATCH_DURATION_S, START_COUNTDOWN_S, LOBBY_CODE_LENGTH, NAME_MIN, NAME_MAX, HEARTBEAT_INTERVAL_S, HEARTBEAT_MISS_LIMIT } from '../../shared/constants.js';
import { MAX_PLAYERS, LOBBY_CODE_LENGTH, HEARTBEAT_INTERVAL_S, HEARTBEAT_MISS_LIMIT, MAX_ROOMS } from '../../shared/constants.js';

// --- Types ---

export interface PlayerInfo {
  name: string;
  ready: boolean;
  isHost: boolean;
  serverId: number;  // numeric player id, allocated at join
  left?: boolean;    // true if player disconnected mid-match
}

export interface Room {
  code: string;
  host: WebSocket | null;
  players: Map<WebSocket, PlayerInfo>;
  phase: 'lobby' | 'readying' | 'countdown' | 'playing' | 'post_match';
  startedAt: number;
  countdownStartTick?: number; // M5: tick-based countdown
  postMatchStartTick?: number; // M5: tick-based post-match
  gameWorld: GameWorld | null;
}

export interface LobbyMessage {
  type: string;
  [key: string]: any;
}

// --- Code generation ---

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

export function generateLobbyCode(): string {
  let code = '';
  for (let i = 0; i < LOBBY_CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

export function validateLobbyCode(code: string): boolean {
  return typeof code === 'string' &&
    code.length === LOBBY_CODE_LENGTH &&
    /^[A-Z2-9]+$/.test(code.toUpperCase());
}

// --- Room manager ---

export class LobbyManager {
  private rooms = new Map<string, Room>();

  /** Iterate over all rooms. */
  get roomEntries(): IterableIterator<[string, Room]> {
    return this.rooms.entries();
  }

  /**
   * Create a new room. Returns the lobby code.
   */
  createRoom(ws: WebSocket, name: string): string {
    // M1: Enforce room limit
    if (this.rooms.size >= MAX_ROOMS) {
      // Handled by returning empty string; caller sends error
      return '';
    }
    const code = this.generateUniqueCode();
    const room: Room = {
      code,
      host: ws,
      players: new Map(),
      phase: 'lobby',
      startedAt: 0,
      gameWorld: null,
    };
    room.players.set(ws, { name, ready: false, isHost: true, serverId: allocatePlayerId() });
    this.rooms.set(code, room);
    return code;
  }

  /**
   * Join an existing room. Returns error string or null on success.
   */
  joinRoom(ws: WebSocket, name: string, code: string): { error?: string } | null {
    const room = this.rooms.get(code);
    if (!room) return { error: 'Lobby not found' };
    if (room.phase === 'post_match') {
      return { error: 'Match ended' };
    }
    if (room.phase === 'countdown') {
      return { error: 'Match starting' };
    }
    if (room.players.size >= MAX_PLAYERS) return { error: 'Lobby full' };
    if (room.players.has(ws)) return { error: 'Already in room' };

    const serverId = allocatePlayerId();
    room.players.set(ws, { name, ready: false, isHost: false, serverId });

    // If joining mid-match, spawn into gameWorld immediately
    if (room.phase === 'playing' && room.gameWorld) {
      room.gameWorld.addPlayer(ws, name, serverId);
    }

    this.broadcastRoster(code);
    return null;
  }

  /**
   * Leave a room. Returns the room code or null.
   */
  leaveRoom(ws: WebSocket): { code?: string; room?: Room } {
    for (const [code, room] of this.rooms) {
      if (room.players.has(ws)) {
        const info = room.players.get(ws)!;
        const wasHost = room.players.get(ws)?.isHost;

        // Host left: pick new host or disband
        if (wasHost) {
          // During playing phase, host disconnect → disband
          if (room.phase === 'playing') {
            // Remove all players from gameWorld before disbanding
            if (room.gameWorld) {
              for (const [playerWs] of room.players) {
                const playerInfo = room.players.get(playerWs)!;
                room.gameWorld.removePlayer(playerInfo.serverId);
              }
            }
            this.broadcast(code, { type: 'disband', reason: 'Host disconnected' });
            this.rooms.delete(code);
            return { code, room };
          }
          if (room.players.size === 0) {
            this.rooms.delete(code);
            return { code, room };
          }
          // Transfer host to first remaining player
          const newHost = room.players.keys().next().value as WebSocket;
          room.host = newHost;
          for (const [, p] of room.players) p.isHost = false;
          const newHostPlayer = room.players.get(newHost);
          if (newHostPlayer) newHostPlayer.isHost = true;
          // Notify all remaining players of host transfer
          this.broadcast(code, { type: 'host_transfer', newHost: newHostPlayer?.name ?? 'unknown' });
        }

        // Mid-match leave: tag the leaver with left: true before removing
        if (room.phase === 'playing') {
          info.left = true;
          // Broadcast roster_update showing the leaver tagged as left
          this.broadcastRoster(code);
          // Remove from gameWorld
          if (room.gameWorld) {
            room.gameWorld.removePlayer(info.serverId);
          }
        }

        room.players.delete(ws);

        return { code, room };
      }
    }
    return {};
  }

  /**
   * Toggle ready state. Only works in lobby phase.
   */
  toggleReady(ws: WebSocket): { error?: string; ready: boolean } {
    const room = this.getRoomForPlayer(ws);
    if (!room) return { error: 'Not in a room', ready: false };
    const player = room.players.get(ws);
    if (!player) return { error: 'Not found', ready: false };

    // Host cannot ready
    if (player.isHost) return { error: 'Host cannot ready up', ready: false };

    player.ready = !player.ready;

    // Check if all non-host players are ready → host can now press Start
    const nonHostPlayers = [...room.players.values()].filter(p => !p.isHost);
    const allReady = nonHostPlayers.length > 0 && nonHostPlayers.every(p => p.ready);
    if (allReady && room.phase === 'lobby') {
      room.phase = 'readying';
      this.broadcast(room.code, {
        type: 'all_ready',
        message: 'All players ready — host can start',
      });
    } else if (!allReady && room.phase === 'readying') {
      room.phase = 'lobby';
    }

    this.broadcastRoster(room.code);
    return { ready: player.ready };
  }

  /**
   * Get player info for a WebSocket.
   */
  getPlayer(ws: WebSocket): { room: Room; player: PlayerInfo } | null {
    const room = this.getRoomForPlayer(ws);
    if (!room) return null;
    const player = room.players.get(ws);
    if (!player) return null;
    return { room, player };
  }

  /**
   * Get room code for a player.
   */
  getRoomCode(ws: WebSocket): string | null {
    for (const [code, room] of this.rooms) {
      if (room.players.has(ws)) return code;
    }
    return null;
  }

  /**
   * Get all room info for a player (for UI display).
   */
  getRoomState(ws: WebSocket): { code: string; roster: Array<{ name: string; ready: boolean; isHost: boolean }>; phase: string; playerCount: number; maxPlayers: number } | null {
    const room = this.getRoomForPlayer(ws);
    if (!room) return null;
    return {
      code: room.code,
      roster: [...room.players.values()],
      phase: room.phase,
      playerCount: room.players.size,
      maxPlayers: MAX_PLAYERS,
    };
  }

  /**
   * Count active rooms.
   */
  roomCount(): number {
    return this.rooms.size;
  }

  /**
   * Get total connected players.
   */
  totalPlayers(): number {
    let count = 0;
    for (const room of this.rooms.values()) count += room.players.size;
    return count;
  }

  private generateUniqueCode(): string {
    let code: string;
    let attempts = 0;
    do {
      code = generateLobbyCode();
      attempts++;
      if (attempts > 100) throw new Error('Failed to generate unique code');
    } while (this.rooms.has(code));
    return code;
  }

  private getRoomForPlayer(ws: WebSocket): Room | null {
    for (const room of this.rooms.values()) {
      if (room.players.has(ws)) return room;
    }
    return null;
  }

  broadcast(code: string, msg: LobbyMessage): void {
    const room = this.rooms.get(code);
    if (!room) return;
    const data = JSON.stringify(msg);
    for (const ws of room.players.keys()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  broadcastRoster(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    this.broadcast(code, {
      type: 'roster_update',
      roster: [...room.players.values()],
      phase: room.phase,
      playerCount: room.players.size,
      maxPlayers: MAX_PLAYERS,
    });
  }

  /**
   * Start the match for a room. Creates the GameWorld and adds all players.
   */
  startMatch(code: string): boolean {
    const room = this.rooms.get(code);
    if (!room || room.phase === 'playing') return false;

    room.phase = 'countdown';
    // No bots for 2+ player networked matches; 1 player gets 5 bots for practice
    const botCount = room.players.size >= 2 ? 0 : 5;
    room.gameWorld = new GameWorld(botCount);
    room.startedAt = Date.now();
    // M5: Store the tick at which countdown began
    room.countdownStartTick = room.gameWorld.serverTick;

    // Add all players to game world — UNIFY serverId with GameWorld id
    for (const [ws, info] of room.players) {
      room.gameWorld!.addPlayer(ws, info.name, info.serverId);
    }

    this.broadcast(code, {
      type: 'match_start',
      phase: 'countdown',
      countdown: 3,
    });

    return true;
  }
}

const START_COUNTDOWN_S = 3;

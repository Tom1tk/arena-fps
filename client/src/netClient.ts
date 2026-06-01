import {
  HEARTBEAT_INTERVAL_S,
  MAX_PLAYERS,
  NAME_MIN,
  NAME_MAX,
  LOBBY_CODE_LENGTH,
} from '../../shared/constants';

// --- Types ---

export interface RosterEntry {
  name: string;
  ready: boolean;
  isHost: boolean;
}

export interface LobbyState {
  phase: 'disconnected' | 'connected' | 'lobby' | 'readying' | 'countdown' | 'playing' | 'post_match';
  code: string | null;
  name: string | null;
  isHost: boolean;
  roster: RosterEntry[];
  countdown: number;
  error: string | null;
}

export type LobbyMessage = Record<string, any>;

// --- NetClient ---

export class NetClient {
  private ws: WebSocket | null = null;
  private state: LobbyState = {
    phase: 'disconnected',
    code: null,
    name: null,
    isHost: false,
    roster: [],
    countdown: 0,
    error: null,
  };
  private listeners: Set<() => void> = new Set();
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  get phase(): string { return this.state.phase; }
  get code(): string | null { return this.state.code; }
  get name(): string | null { return this.state.name; }
  get isHost(): boolean { return this.state.isHost; }
  get roster(): RosterEntry[] { return this.state.roster; }
  get countdown(): number { return this.state.countdown; }
  get error(): string | null { return this.state.error; }
  get connected(): boolean { return this.ws !== null && this.ws.readyState === WebSocket.OPEN; }

  /** Subscribe to state changes. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Connect to the server. */
  connect(url: string): void {
    this.clearTimers();
    this.state.error = null;

    const wsUrl = `${url.replace(/https?:/, 'ws:')}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[Net] Connected');
      this.startHeartbeat();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as LobbyMessage;
        this.handleMessage(msg);
      } catch (err) {
        console.error('[Net] Parse error:', err);
      }
    };

    this.ws.onclose = () => {
      console.log('[Net] Disconnected');
      this.clearTimers();
      this.state.phase = 'disconnected';
      this.notify();
    };

    this.ws.onerror = () => {
      this.state.error = 'Connection failed';
      this.notify();
    };
  }

  /** Create a room (host). */
  createRoom(name: string): void {
    this.send({ type: 'create', name });
  }

  /** Join a room by code. */
  joinRoom(code: string, name: string): void {
    this.send({ type: 'join', code: code.toUpperCase(), name });
  }

  /** Leave the current room. */
  leave(): void {
    this.send({ type: 'leave' });
  }

  /** Toggle ready state. */
  ready(): void {
    this.send({ type: 'ready' });
  }

  /** Host starts the match. */
  start(): void {
    this.send({ type: 'start' });
  }

  /** Disconnect from server. */
  disconnect(): void {
    this.clearTimers();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.state.phase = 'disconnected';
    this.state.code = null;
    this.state.name = null;
    this.state.isHost = false;
    this.state.roster = [];
    this.notify();
  }

  /** Get current state snapshot. */
  getState(): LobbyState {
    return { ...this.state };
  }

  // --- Private ---

  private send(msg: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.state.error = 'Not connected to server';
      this.notify();
    }
  }

  private handleMessage(msg: LobbyMessage): void {
    switch (msg.type) {
      case 'welcome':
        // Connection established — show create/join options
        this.state.phase = 'connected';
        this.state.error = null;
        this.notify();
        break;

      case 'created':
        this.state.code = msg.code;
        this.state.name = msg.name;
        this.state.isHost = true;
        this.state.phase = 'lobby';
        this.state.error = null;
        break;

      case 'joined':
        this.state.code = msg.code;
        this.state.name = msg.name;
        this.state.isHost = false;
        this.state.phase = 'lobby';
        this.state.error = null;
        break;

      case 'left':
        this.state.phase = 'connected';
        this.state.code = null;
        this.state.roster = [];
        this.state.isHost = false;
        this.notify();
        break;

      case 'roster_update':
        this.state.roster = msg.roster;
        this.state.phase = msg.phase || 'lobby';
        this.state.code = msg.code || this.state.code;
        // Update our own isHost
        const me = this.state.roster.find(r => r.name === this.state.name);
        if (me) this.state.isHost = me.isHost;
        this.state.error = null;
        break;

      case 'all_ready':
        // All non-host players ready, host can start
        this.state.phase = 'readying';
        this.state.error = null;
        this.notify();
        break;

      case 'match_start':
        this.state.phase = 'countdown';
        this.state.countdown = msg.countdown || 3;
        this.state.error = null;
        this.notify();
        // Start local countdown timer
        this.startCountdown(this.state.countdown ?? 3);
        break;

      case 'ready_state':
        // Update our own ready state
        const me2 = this.state.roster.find(r => r.name === this.state.name);
        if (me2) me2.ready = msg.ready;
        this.notify();
        break;

      case 'host_transfer':
        // We're no longer host
        if (this.state.isHost) {
          this.state.isHost = false;
        }
        // Update roster from next roster_update
        this.notify();
        break;

      case 'error':
        this.state.error = msg.message;
        break;

      default:
        console.log(`[Net] Unknown message: ${msg.type}`);
    }
    this.notify();
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  private startHeartbeat(): void {
    this.hbTimer = setInterval(() => {
      this.send({ type: 'heartbeat' });
    }, HEARTBEAT_INTERVAL_S * 1000);
  }

  private startCountdown(seconds: number): void {
    // Clear any existing countdown
    if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
    this.countdownTimer = setInterval(() => {
      this.state.countdown -= 1;
      if (this.state.countdown <= 0) {
        if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
        this.state.countdown = 0;
        this.state.phase = 'playing';
        this.notify();
      } else {
        this.notify();
      }
    }, 1000);
  }

  private clearTimers(): void {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
  }
}

import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import type { GraphicsQuality } from '../../shared/types';
import {
  TICK_DT, PLAYER_MAX_HP, MAG_SIZE, PLAYER_RADIUS, FIRE_RATE_RPM,
  DAMAGE_BODY, DAMAGE_HEAD, HITSCAN_MAX_RANGE, SPREAD_RAD, RELOAD_TIME_S,
  KILL_GOAL, POST_MATCH_DURATION_S, RESPAWN_DELAY_S, SPAWN_POSITIONS,
} from '../../shared/constants';
import { MAX_PLAYERS } from '../../shared/constants';
import { playerStep, type PlayerSim } from '../../shared/simulation/step';
import { clamp } from '../../shared/math';
import { ButtonFlags } from '../../shared/types';
import { createArena } from './arena';
import { FPSCounter } from './fpsCounter';
import { SettingsStore } from './settingsStore';
import { KeyboardMouseSource } from './inputSource';
import { createDummyTargets, type DummyTarget, raycastHitscan, BOT_DAMAGE } from './hitscan';
import { ViewModel } from './viewmodel';
import { playShoot, playReload, playKill } from './audio';
import { selectSpawnPoint } from '../../shared/spawn-selection';
import { NetGame } from './netGame';
import { RemotePlayerManager } from './remotePlayers';
import type { InputFrame, SpawnPoint } from '../../shared/types';

// --- Arena bounds for collision ---
const ARENA_HALF = 20;
const WORLD_BOUNDS = {
  minY: -10, maxY: 100,
  minX: -ARENA_HALF, maxX: ARENA_HALF,
  minZ: -ARENA_HALF, maxZ: ARENA_HALF,
};

// --- Obstacle AABBs (must match arena.ts obstacle positions) ---
import type { AABB } from '../../shared/simulation/step';
const OBSTACLES: AABB[] = [
  // Central cover: { x: 0, z: 0, w: 3, h: 2, d: 3 }
  { minX: -1.5, maxX: 1.5, minY: 0, maxY: 2, minZ: -1.5, maxZ: 1.5 },
  // { x: 6, z: 6, w: 2, h: 2.5, d: 2 }
  { minX: 5, maxX: 7, minY: 0, maxY: 2.5, minZ: 5, maxZ: 7 },
  // { x: -6, z: 6, w: 2, h: 2.5, d: 2 }
  { minX: -7, maxX: -5, minY: 0, maxY: 2.5, minZ: 5, maxZ: 7 },
  // { x: 6, z: -6, w: 2, h: 2.5, d: 2 }
  { minX: 5, maxX: 7, minY: 0, maxY: 2.5, minZ: -7, maxZ: -5 },
  // { x: -6, z: -6, w: 2, h: 2.5, d: 2 }
  { minX: -7, maxX: -5, minY: 0, maxY: 2.5, minZ: -7, maxZ: -5 },
  // Corner cover: { x: 12, z: 12, w: 3, h: 1.5, d: 1.5 }
  { minX: 10.5, maxX: 13.5, minY: 0, maxY: 1.5, minZ: 11.25, maxZ: 12.75 },
  // { x: -12, z: 12, w: 3, h: 1.5, d: 1.5 }
  { minX: -13.5, maxX: -10.5, minY: 0, maxY: 1.5, minZ: 11.25, maxZ: 12.75 },
  // { x: 12, z: -12, w: 3, h: 1.5, d: 1.5 }
  { minX: 10.5, maxX: 13.5, minY: 0, maxY: 1.5, minZ: -12.75, maxZ: -11.25 },
  // { x: -12, z: -12, w: 3, h: 1.5, d: 1.5 }
  { minX: -13.5, maxX: -10.5, minY: 0, maxY: 1.5, minZ: -12.75, maxZ: -11.25 },
  // Mid-edge: { x: 10, z: 0, w: 1.5, h: 2, d: 4 }
  { minX: 9.25, maxX: 10.75, minY: 0, maxY: 2, minZ: -2, maxZ: 2 },
  // { x: -10, z: 0, w: 1.5, h: 2, d: 4 }
  { minX: -10.75, maxX: -9.25, minY: 0, maxY: 2, minZ: -2, maxZ: 2 },
  // { x: 0, z: 10, w: 4, h: 2, d: 1.5 }
  { minX: -2, maxX: 2, minY: 0, maxY: 2, minZ: 9.25, maxZ: 10.75 },
  // { x: 0, z: -10, w: 4, h: 2, d: 1.5 }
  { minX: -2, maxX: 2, minY: 0, maxY: 2, minZ: -10.75, maxZ: -9.25 },
];

// --- DOM refs ---
const fpsEl = document.getElementById('fps-counter')!;
const debugEl = document.getElementById('debug-line')!;
const toggleBtn = document.getElementById('graphics-toggle')!;
const titleOverlay = document.getElementById('title-overlay')!;
const pauseOverlay = document.getElementById('pause-overlay')!;
const resumeBtn = document.getElementById('resume-btn')!;
const leaveBtn = document.getElementById('leave-btn')!;
const tabScoreboard = document.getElementById('tab-scoreboard')!;
const hitMarker = document.getElementById('hit-marker')!;
const hpFill = document.getElementById('hp-fill')!;
const ammoDisplay = document.getElementById('ammo-display')!;
const crosshairEl = document.getElementById('crosshair')!;
const killFeedEl = document.getElementById('kill-feed')!;
const scoreboardEl = document.getElementById('scoreboard')!;
const deathOverlay = document.getElementById('death-overlay')!;
const deathInfo = document.getElementById('death-info')!;
const deathCountdown = document.getElementById('death-countdown')!;
const postMatchOverlay = document.getElementById('post-match-overlay')!;
const postMatchStats = document.getElementById('post-match-stats')!;
const postMatchCountdown = document.getElementById('post-match-countdown')!;
const damageIndicator = document.getElementById('damage-indicator')!;

// --- Settings ---
const settings = SettingsStore.getInstance();

// --- Menu Navigation State ---
// Three sub-menus: menu-buttons (default), menu-settings-panel, lobby-panel
const menuButtons = document.getElementById('menu-buttons')!;
const menuSettingsPanel = document.getElementById('menu-settings-panel')!;
const lobbyPanel = document.getElementById('lobby-panel')!;

function showMenu(menu: string): void {
  menuButtons.style.display = menu === 'main' ? 'flex' : 'none';
  menuSettingsPanel.classList.toggle('visible', menu === 'settings');
  lobbyPanel.classList.toggle('visible', menu === 'lobby');
}

function hideAllSubMenus(): void {
  menuSettingsPanel.classList.remove('visible');
  lobbyPanel.classList.remove('visible');
  menuButtons.style.display = 'flex';
}

// --- M5: NetClient (lobby networking) ---
import { NetClient } from './netClient';
const netClient = new NetClient();

// Lobby UI DOM refs
const lobbyCodeDisplay = document.getElementById('lobby-code-display')!;
const lobbyRosterBody = document.getElementById('lobby-roster-body')!;
const lobbyStatus = document.getElementById('lobby-status')!;
const lobbyError = document.getElementById('lobby-error')!;
const lobbyCreateBtn = document.getElementById('lobby-create')!;
const lobbyReadyBtn = document.getElementById('lobby-ready')!;
const lobbyStartBtn = document.getElementById('lobby-start')!;
const lobbyLeaveBtn = document.getElementById('lobby-leave')!;
const lobbyDisconnectBtn = document.getElementById('lobby-disconnect')!;
const lobbyJoinCodeInput = document.getElementById('lobby-join-code')! as HTMLInputElement;
const lobbyJoinBtn = document.getElementById('lobby-join')!;
const lobbyJoinRow = document.getElementById('lobby-join-row')!;

// --- Menu Button Handlers ---

// Play Online → connect to server, show lobby
const btnPlayOnline = document.getElementById('btn-play-online')!;
btnPlayOnline.addEventListener('click', () => {
  if (!validateName()) return;
  const name = playerNameEl.value.trim();
  localStorage.setItem('arena-fps-name', name);

  // Connect to WebSocket server
  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const serverUrl = `${wsProto}//${window.location.host}`;
  netClient.connect(serverUrl);

  showMenu('lobby');
  lobbyStatus.textContent = 'Connecting...';
  lobbyCreateBtn.style.display = 'inline-block';
  lobbyDisconnectBtn.style.display = 'none';
  lobbyLeaveBtn.style.display = 'none';
  lobbyReadyBtn.style.display = 'none';
  lobbyStartBtn.style.display = 'none';
  lobbyJoinRow.style.display = 'flex';
  lobbyError.textContent = '';
  lobbyRosterBody.innerHTML = '';
  lobbyCodeDisplay.textContent = '';
});

// Practice → start single-player vs bots
const btnPractice = document.getElementById('btn-practice')!;
btnPractice.addEventListener('click', () => {
  if (!validateName()) return;
  const name = playerNameEl.value.trim();
  localStorage.setItem('arena-fps-name', name);

  titleOverlay.style.display = 'none';
  netClient.disconnect();
  initGame();
});

// Settings → show settings submenu
const btnSettings = document.getElementById('btn-settings')!;
btnSettings.addEventListener('click', () => {
  syncMenuControls();
  showMenu('settings');
});

// Back from settings
const btnBackFromSettings = document.getElementById('btn-back-from-settings')!;
btnBackFromSettings.addEventListener('click', () => {
  showMenu('main');
});

// Back from lobby → return to main menu
const btnBackFromLobby = document.getElementById('btn-back-from-lobby')!;
btnBackFromLobby.addEventListener('click', () => {
  netClient.disconnect();
  showMenu('main');
});

// Lobby button handlers
lobbyCreateBtn.addEventListener('click', () => {
  const name = localStorage.getItem('arena-fps-name') || playerNameEl.value.trim();
  netClient.createRoom(name);
  lobbyStatus.textContent = 'Creating lobby...';
});

lobbyJoinBtn.addEventListener('click', () => {
  const code = lobbyJoinCodeInput.value.trim().toUpperCase();
  const name = localStorage.getItem('arena-fps-name') || playerNameEl.value.trim();
  if (code.length !== 5) {
    lobbyError.textContent = 'Invalid code (5 characters)';
    return;
  }
  netClient.joinRoom(code, name);
  lobbyStatus.textContent = 'Joining...';
});

lobbyReadyBtn.addEventListener('click', () => {
  netClient.ready();
});

lobbyStartBtn.addEventListener('click', () => {
  netClient.start();
});

lobbyLeaveBtn.addEventListener('click', () => {
  netClient.leave();
});

lobbyDisconnectBtn.addEventListener('click', () => {
  netClient.disconnect();
  showMenu('main');
});

// Sync lobby UI on state change
netClient.onChange(() => {
  const state = netClient.getState();

  // Code display
  lobbyCodeDisplay.textContent = state.code || '';

  // Roster
  let rosterHTML = '';
  for (const p of state.roster) {
    const readyIcon = p.ready ? '<span class="ready-icon">✓</span>' : '<span class="not-ready-icon">○</span>';
    const role = p.isHost ? 'Host' : '';
    rosterHTML += `<tr><td>${p.name}</td><td>${readyIcon}</td><td>${role}</td></tr>`;
  }
  lobbyRosterBody.innerHTML = rosterHTML;

  // Status
  if (state.phase === 'disconnected') {
    lobbyStatus.textContent = 'Disconnected';
    showMenu('main');
  } else if (state.phase === 'connected') {
    lobbyStatus.textContent = 'Connected — create or join a lobby';
    lobbyCreateBtn.style.display = 'inline-block';
    lobbyDisconnectBtn.style.display = 'inline-block';
    lobbyLeaveBtn.style.display = 'none';
    lobbyReadyBtn.style.display = 'none';
    lobbyStartBtn.style.display = 'none';
    lobbyJoinRow.style.display = 'flex';
  } else if (state.phase === 'lobby') {
    lobbyStatus.textContent = `Waiting for players (${state.roster.length}/${MAX_PLAYERS})`;
    lobbyCreateBtn.style.display = 'none';
    lobbyDisconnectBtn.style.display = 'inline-block';
    lobbyLeaveBtn.style.display = 'inline-block';
    lobbyJoinRow.style.display = 'none';
    lobbyReadyBtn.style.display = state.isHost ? 'none' : 'inline-block';
    lobbyStartBtn.style.display = state.isHost ? 'inline-block' : 'none';
  } else if (state.phase === 'readying') {
    lobbyStatus.textContent = 'All non-host ready — host can start';
    lobbyReadyBtn.style.display = state.isHost ? 'none' : 'inline-block';
    lobbyStartBtn.style.display = state.isHost ? 'inline-block' : 'none';
  } else if (state.phase === 'countdown') {
    lobbyStatus.textContent = `Match starting in ${state.countdown}s...`;
    lobbyCreateBtn.style.display = 'none';
    lobbyReadyBtn.style.display = 'none';
    lobbyStartBtn.style.display = 'none';
    lobbyLeaveBtn.style.display = 'none';
    lobbyDisconnectBtn.style.display = 'none';
  } else if (state.phase === 'playing') {
    lobbyStatus.textContent = 'Match in progress';
    if (!started) {
      lobbyPanel.classList.remove('visible');
      titleOverlay.style.display = 'none';
      initGame(true);
    }
  }

  // Error
  lobbyError.textContent = state.error || '';
});

// --- Player name ---
const playerNameEl = document.getElementById('player-name')! as HTMLInputElement;
const nameErrorEl = document.getElementById('name-error')!;

// Validate name and enable/disable online button
function validateName(): boolean {
  const name = playerNameEl.value.trim();
  if (name.length < 3) {
    nameErrorEl.textContent = 'At least 3 characters';
    btnPlayOnline.style.opacity = '0.4';
    btnPlayOnline.style.pointerEvents = 'none';
    btnPractice.style.opacity = '0.4';
    btnPractice.style.pointerEvents = 'none';
    return false;
  }
  nameErrorEl.textContent = '';
  btnPlayOnline.style.opacity = '1';
  btnPlayOnline.style.pointerEvents = 'auto';
  btnPractice.style.opacity = '1';
  btnPractice.style.pointerEvents = 'auto';
  return true;
}

playerNameEl.addEventListener('input', validateName);
playerNameEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (validateName()) {
      // If on main menu, click Play Online
      if (menuButtons.style.display !== 'none') {
        btnPlayOnline.click();
      }
    }
  }
});

// Load saved name
const savedName = localStorage.getItem('arena-fps-name');
if (savedName) {
  playerNameEl.value = savedName;
  validateName();
}

// --- Menu settings controls ---
const menuSensitivity = document.getElementById('menu-sensitivity')! as HTMLInputElement;
const menuSensitivityVal = document.getElementById('menu-sensitivity-val')!;
const menuFov = document.getElementById('menu-fov')! as HTMLInputElement;
const menuFovVal = document.getElementById('menu-fov-val')!;
const menuCrosshairType = document.getElementById('menu-crosshair-type')! as HTMLSelectElement;
const menuCrosshairColour = document.getElementById('menu-crosshair-colour')! as HTMLInputElement;
const menuCrosshairSize = document.getElementById('menu-crosshair-size')! as HTMLInputElement;
const menuGraphics = document.getElementById('menu-graphics')! as HTMLSelectElement;

// Sync menu controls with settings
function syncMenuControls(): void {
  const s = settings.get();
  (menuSensitivity as HTMLInputElement).value = String(s.sensitivity);
  menuSensitivityVal.textContent = String(s.sensitivity);
  (menuFov as HTMLInputElement).value = String(s.fov);
  menuFovVal.textContent = String(s.fov);
  (menuCrosshairType as HTMLSelectElement).value = s.crosshairType;
  (menuCrosshairColour as HTMLInputElement).value = s.crosshairColour;
  (menuCrosshairSize as HTMLInputElement).value = String(s.crosshairSize);
  (menuGraphics as HTMLSelectElement).value = s.graphicsQuality;
}

// Menu control change handlers (apply live)
menuSensitivity.addEventListener('input', () => {
  settings.set({ sensitivity: parseFloat(menuSensitivity.value) });
  menuSensitivityVal.textContent = menuSensitivity.value;
  if (inputSource) inputSource.setSensitivity(settings.get().sensitivity);
});
menuFov.addEventListener('input', () => {
  const fov = parseFloat(menuFov.value);
  settings.set({ fov });
  menuFovVal.textContent = menuFov.value;
  camera.fov = fov;
  camera.updateProjectionMatrix();
});
menuCrosshairType.addEventListener('change', () => {
  settings.set({ crosshairType: menuCrosshairType.value as any });
  updateCrosshair();
});
menuCrosshairColour.addEventListener('input', () => {
  settings.set({ crosshairColour: menuCrosshairColour.value });
  updateCrosshair();
});
menuCrosshairSize.addEventListener('input', () => {
  settings.set({ crosshairSize: parseFloat(menuCrosshairSize.value) });
  updateCrosshair();
});
menuGraphics.addEventListener('change', () => {
  applyQuality(menuGraphics.value as any);
});

// Sync on load
syncMenuControls();
updateCrosshair();

// --- Renderer ---
let renderer: THREE.WebGLRenderer | WebGPURenderer;
let isWebGPU = false;

async function initRenderer(): Promise<void> {
  const quality = settings.get().graphicsQuality;
  try {
    const gpuRenderer = new WebGPURenderer({ antialias: quality === 'high' });
    await gpuRenderer.init();
    renderer = gpuRenderer;
    try { isWebGPU = (gpuRenderer as any).backend?.isWebGPUBackend === true; } catch { isWebGPU = true; }
    console.log(`[Renderer] Backend: ${isWebGPU ? 'WebGPU' : 'WebGL2'}`);
  } catch {
    renderer = new THREE.WebGLRenderer({ antialias: quality === 'high', powerPreference: 'high-performance' });
    isWebGPU = false;
    console.log('[Renderer] Backend: WebGL2 (WebGPU unavailable)');
  }
  const dpr = Math.min(window.devicePixelRatio, quality === 'low' ? 1 : 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.insertBefore(renderer.domElement, document.body.firstChild);
}

// --- Scene & Camera ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);
scene.fog = new THREE.Fog(0x1a1a2e, 60, 120);

const camera = new THREE.PerspectiveCamera(
  settings.get().fov,
  window.innerWidth / window.innerHeight,
  0.1,
  500
);

// --- Arena ---
const arena = createArena(settings.get().graphicsQuality);
scene.add(arena.group);

// --- FPS counter ---
const fpsCounter = new FPSCounter(fpsEl, debugEl);

// --- Input ---
let inputSource: KeyboardMouseSource | null = null;

// --- Player simulation state ---
const player: PlayerSim = {
  pos: { x: 0, y: PLAYER_MAX_HP > 0 ? 1.6 : 1.6, z: 10 },
  vel: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  grounded: false,
  crouching: false,
  eyeHeight: 1.6,
};

// --- Game state ---
let hp = PLAYER_MAX_HP;
let ammo = MAG_SIZE;
let reloading = false;
let reloadTimer = 0;
let started = false;
let paused = false;
let tabOpen = false;
let kills = 0;
let playerDeaths = 0;

// --- Networked game mode ---
let networkedMode = false; // true when playing via NetClient
let netGame: NetGame | null = null;
let remotePlayers: RemotePlayerManager | null = null;
// Input sequence counter for server
let inputSeq = 0;

// --- M3: Match state ---
type MatchPhase = 'playing' | 'post_match';
let matchPhase: MatchPhase = 'playing';
let postMatchTimer = 0;
let isDead = false;
let playerRespawnTimer = 0;
let killerName = '';
let headshotKill = false;
let recentSpawns: Array<{ pos: { x: number; y: number; z: number }; time: number }> = [];

// Kill feed
interface KillFeedEntry {
  killer: string;
  victim: string;
  headshot: boolean;
  time: number;
}
let killFeed: KillFeedEntry[] = [];
const KILL_FEED_MAX = 8;
let killFeedTimer = 0; // how long entries stay visible (s)

// Semi-auto fire: edge-triggered per click, with fire-rate cap
let fireCooldown = 0; // seconds until next shot allowed
const FIRE_COOLDOWN_S = 60 / FIRE_RATE_RPM; // ~0.167s per shot at 360 RPM

// Fixed timestep accumulator
let simAccum = 0;

// --- Render interpolation state (no per-frame allocation) ---
const prevPos = { x: 0, y: 1.6, z: 10 };  // snapshot before each tick
const renderPos = { x: 0, y: 1.6, z: 10 }; // lerped position for camera

// Recoil: separate visual offset applied only to camera, decays each frame.
// Keeps playerStep as single authority over base aim (important at M6+).
let recoilPitch = 0;
const RECOIL_KICK = 0.02;
const RECOIL_DECAY_RATE = 8; // per second — how fast recoil snaps back

function lerpPos(out: { x: number; y: number; z: number }, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, t: number): void {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
}

// --- M2: Hitscan + Dummy targets + ViewModel ---
let dummyTargets: DummyTarget[] = [];
let viewmodel: ViewModel | null = null;
let obstacleMeshes: THREE.Object3D[] = [];
// Reusable direction vector for raycast
const _shootDir = new THREE.Vector3();
// Cached last sim input (to avoid double-polling which resets edge detection)
let lastSimInput: InputFrame | null = null;

// --- Graphics toggle ---
function applyQuality(quality: GraphicsQuality): void {
  settings.set({ graphicsQuality: quality });
  const dpr = Math.min(window.devicePixelRatio, quality === 'low' ? 1 : 2);
  renderer.setPixelRatio(dpr);
  const dirLight = scene.getObjectByName('dirLight') as THREE.DirectionalLight;
  if (dirLight) dirLight.visible = quality === 'high';
  camera.far = quality === 'low' ? 100 : 500;
  camera.updateProjectionMatrix();
  toggleBtn.textContent = `Graphics: ${quality === 'high' ? 'High' : 'Low'}`;
  arena.updateQuality(quality);
}

toggleBtn.addEventListener('click', () => {
  const current = settings.get().graphicsQuality;
  applyQuality(current === 'high' ? 'low' : 'high');
});

// --- Resize ---
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

// --- Pause (Esc) ---
document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    if (tabOpen) {
      tabScoreboard.style.display = 'none';
      tabOpen = false;
      if (inputSource) {
        const el = document.querySelector('canvas') as HTMLCanvasElement;
        if (document.pointerLockElement !== el) el.requestPointerLock();
      }
      return;
    }
    if (!started) return;
    paused = !paused;
    if (paused) {
      pauseOverlay.style.display = 'flex';
      document.exitPointerLock();
    } else {
      pauseOverlay.style.display = 'none';
      (document.querySelector('canvas') as HTMLCanvasElement)?.requestPointerLock();
    }
  }
  // Tab scoreboard
  if (e.code === 'Tab' && started && !paused) {
    e.preventDefault();
    tabOpen = !tabOpen;
    if (tabOpen) {
      tabScoreboard.style.display = 'flex';
      updateTabScoreboard();
      document.exitPointerLock();
    } else {
      tabScoreboard.style.display = 'none';
      (document.querySelector('canvas') as HTMLCanvasElement)?.requestPointerLock();
    }
  }
});

resumeBtn.addEventListener('click', () => {
  paused = false;
  pauseOverlay.style.display = 'none';
  settingsOverlay.style.display = 'none';
  (document.querySelector('canvas') as HTMLCanvasElement)?.requestPointerLock();
});

// Settings button in pause overlay
const settingsBtn = document.getElementById('settings-btn')!;
settingsBtn.addEventListener('click', () => {
  pauseOverlay.style.display = 'none';
  settingsOverlay.style.display = 'flex';
  // Sync in-game settings controls
  const s = settings.get();
  (sgSensitivity as HTMLInputElement).value = String(s.sensitivity);
  sgSensitivityVal.textContent = String(s.sensitivity);
  (sgFov as HTMLInputElement).value = String(s.fov);
  sgFovVal.textContent = String(s.fov);
  (sgCrosshairType as HTMLSelectElement).value = s.crosshairType;
  (sgCrosshairColour as HTMLInputElement).value = s.crosshairColour;
  (sgCrosshairSize as HTMLInputElement).value = String(s.crosshairSize);
  (sgGraphics as HTMLSelectElement).value = s.graphicsQuality;
});

// In-game settings controls
const settingsOverlay = document.getElementById('settings-overlay')!;
const settingsCloseBtn = document.getElementById('settings-close-btn')!;
const sgSensitivity = document.getElementById('sg-sensitivity')! as HTMLInputElement;
const sgSensitivityVal = document.getElementById('sg-sensitivity-val')!;
const sgFov = document.getElementById('sg-fov')! as HTMLInputElement;
const sgFovVal = document.getElementById('sg-fov-val')!;
const sgCrosshairType = document.getElementById('sg-crosshair-type')! as HTMLSelectElement;
const sgCrosshairColour = document.getElementById('sg-crosshair-colour')! as HTMLInputElement;
const sgCrosshairSize = document.getElementById('sg-crosshair-size')! as HTMLInputElement;
const sgGraphics = document.getElementById('sg-graphics')! as HTMLSelectElement;

// In-game setting change handlers
sgSensitivity.addEventListener('input', () => {
  settings.set({ sensitivity: parseFloat(sgSensitivity.value) });
  sgSensitivityVal.textContent = sgSensitivity.value;
  if (inputSource) inputSource.setSensitivity(settings.get().sensitivity);
});
sgFov.addEventListener('input', () => {
  const fov = parseFloat(sgFov.value);
  settings.set({ fov });
  sgFovVal.textContent = sgFov.value;
  camera.fov = fov;
  camera.updateProjectionMatrix();
});
sgCrosshairType.addEventListener('change', () => {
  settings.set({ crosshairType: sgCrosshairType.value as any });
  updateCrosshair();
});
sgCrosshairColour.addEventListener('input', () => {
  settings.set({ crosshairColour: sgCrosshairColour.value });
  updateCrosshair();
});
sgCrosshairSize.addEventListener('input', () => {
  settings.set({ crosshairSize: parseFloat(sgCrosshairSize.value) });
  updateCrosshair();
});
sgGraphics.addEventListener('change', () => {
  applyQuality(sgGraphics.value as any);
});

settingsCloseBtn.addEventListener('click', () => {
  settingsOverlay.style.display = 'none';
});

leaveBtn.addEventListener('click', () => {
  started = false;
  paused = false;
  pauseOverlay.style.display = 'none';
  settingsOverlay.style.display = 'none';
  titleOverlay.style.display = 'flex';
  syncMenuControls();
  if (document.pointerLockElement) document.exitPointerLock();
});

function getPlayerName(): string {
  return localStorage.getItem('arena-fps-name') || 'Player';
}

function updateTabScoreboard(): void {
  const tbody = document.getElementById('tab-sb-body')!;
  const name = getPlayerName();
  tbody.innerHTML = `<tr><td>1</td><td>${name}</td><td>${kills}</td><td>${playerDeaths}</td></tr>`;
}

function updateTabScoreboardM3(): void {
  const tbody = document.getElementById('tab-sb-body')!;
  const name = getPlayerName();
  let rows = `<tr><td>1</td><td>${name}</td><td>${kills}</td><td>${playerDeaths}</td></tr>`;
  // Add bot entries sorted by kills
  const bots = dummyTargets.map(t => ({ name: t.name, k: t.kills, d: t.deaths }));
  for (const b of bots) {
    rows += `<tr><td>-</td><td>${b.name}</td><td>${b.k}</td><td>${b.d}</td></tr>`;
  }
  tbody.innerHTML = rows;
}

// --- Crosshair update from settings ---
function updateCrosshair(): void {
  const s = settings.get();
  const ch = crosshairEl;
  ch.style.width = `${s.crosshairSize}px`;
  ch.style.height = `${s.crosshairSize}px`;
  const h = ch.querySelector('.h') as HTMLElement;
  const v = ch.querySelector('.v') as HTMLElement;
  if (h) { h.style.background = s.crosshairColour; h.style.height = '2px'; }
  if (v) { v.style.background = s.crosshairColour; v.style.width = '2px'; }

  switch (s.crosshairType) {
    case 'dot':
      h.style.display = 'none'; v.style.display = 'none';
      ch.style.borderRadius = '50%'; ch.style.border = `2px solid ${s.crosshairColour}`;
      break;
    case 'cross':
      h.style.display = 'block'; v.style.display = 'block';
      ch.style.border = 'none'; ch.style.borderRadius = '0';
      break;
    case 'crossdot':
      h.style.display = 'block'; v.style.display = 'block';
      ch.style.border = `1px solid ${s.crosshairColour}`; ch.style.borderRadius = '50%';
      break;
    case 'circle':
      h.style.display = 'none'; v.style.display = 'none';
      ch.style.border = `2px solid ${s.crosshairColour}`; ch.style.borderRadius = '50%';
      break;
  }
}

// --- HUD update ---
function updateHUD(): void {
  hpFill.style.width = `${(hp / PLAYER_MAX_HP) * 100}%`;
  hpFill.style.background = hp > 60 ? '#0c0' : hp > 30 ? '#cc0' : '#c00';
  ammoDisplay.textContent = reloading ? 'Reloading...' : `${ammo} / ∞`;
}

// --- Show hit marker ---
let hitMarkerTimer = 0;
function showHitMarker(): void {
  hitMarker.classList.add('show');
  hitMarkerTimer = 0.15;
}

// --- M3: Kill feed ---
function addKillFeedEntry(killer: string, victim: string, headshot: boolean): void {
  killFeed.push({ killer, victim, headshot, time: performance.now() / 1000 });
  if (killFeed.length > KILL_FEED_MAX) killFeed.shift();
  killFeedTimer = 5; // entries fade after 5s
}

function updateKillFeedUI(): void {
  const now = performance.now() / 1000;
  const lines = killFeed
    .filter(e => now - e.time < killFeedTimer)
    .map(e => `<div style="color:${e.killer === 'You' ? '#8f8' : '#faa'}">${e.headshot ? '✦ ' : ''}${e.killer} → ${e.victim}</div>`).join('');
  killFeedEl.innerHTML = lines;
}

// --- M3: Match state ---
function startPostMatch(): void {
  matchPhase = 'post_match';
  postMatchTimer = POST_MATCH_DURATION_S;
}

function resetMatch(): void {
  matchPhase = 'playing';
  postMatchTimer = 0;
  kills = 0;
  playerDeaths = 0;
  hp = PLAYER_MAX_HP;
  ammo = MAG_SIZE;
  reloading = false;
  isDead = false;
  playerRespawnTimer = 0;
  killFeed = [];
  recentSpawns = [];
  // Reset all bots
  for (const t of dummyTargets) {
    t.hp = PLAYER_MAX_HP;
    t.alive = true;
    t.deaths = 0;
    t.kills = 0;
    t.resetVisuals();
    // Respawn bots at new positions
    const spawn = SPAWN_POSITIONS[Math.floor(Math.random() * SPAWN_POSITIONS.length)];
    t.setPosition(spawn.pos.x, spawn.pos.z);
  }
  // Smart spawn player
  spawnPlayer(performance.now() / 1000);
}

function spawnPlayer(now: number): void {
  const allPlayers: Array<{ pos: { x: number; y: number; z: number }; yaw: number }> = [];
  for (const t of dummyTargets) {
    if (t.alive) {
      allPlayers.push({
        pos: { x: t.group.position.x, y: t.group.position.y, z: t.group.position.z },
        yaw: 0,
      });
    }
  }
  const spawn = selectSpawnPoint(allPlayers, recentSpawns, now);
  player.pos.x = spawn.pos.x;
  player.pos.y = spawn.pos.y;
  player.pos.z = spawn.pos.z;
  if (inputSource) {
    inputSource.setAngles(spawn.yaw, 0);
  }
  prevPos.x = player.pos.x;
  prevPos.y = player.pos.y;
  prevPos.z = player.pos.z;
  renderPos.x = player.pos.x;
  renderPos.y = player.pos.y;
  renderPos.z = player.pos.z;
  hp = PLAYER_MAX_HP;
  ammo = MAG_SIZE;
  reloading = false;
  isDead = false;
  recentSpawns.push({ pos: { ...player.pos }, time: now });
}

// --- M3: Player death ---
function onPlayerDeath(killer: string, hs: boolean): void {
  isDead = true;
  playerRespawnTimer = RESPAWN_DELAY_S;
  killerName = killer;
  headshotKill = hs;
  playerDeaths++;
  addKillFeedEntry(killer, 'You', hs);
  // Show death overlay
  deathOverlay.style.display = 'flex';
  deathInfo.textContent = `${killer}${hs ? ' [HS]' : ''} eliminated you`;
}

function respawnPlayer(now: number): void {
  spawnPlayer(now);
  deathOverlay.style.display = 'none';
  postMatchOverlay.style.display = 'none';
}

// --- M3: Damage indicator ---
let damageFlashTimer = 0;
function showDamageIndicator(): void {
  damageIndicator.style.borderColor = 'rgba(255,0,0,0.6)';
  damageFlashTimer = 0.15;
}

function updateOverlays(dt: number): void {
  // Death overlay countdown
  if (isDead) {
    deathOverlay.style.display = 'flex';
    deathCountdown.textContent = `Respawning in ${Math.ceil(playerRespawnTimer)}s...`;
  } else {
    deathOverlay.style.display = 'none';
  }

  // Post-match overlay
  if (matchPhase === 'post_match') {
    postMatchOverlay.style.display = 'flex';
    postMatchStats.innerHTML = `Kills: ${kills} | Deaths: ${playerDeaths}<br>K/D: ${(kills / Math.max(1, playerDeaths)).toFixed(1)}`;
    postMatchCountdown.textContent = `New match in ${Math.ceil(postMatchTimer)}s...`;
  } else {
    postMatchOverlay.style.display = 'none';
  }

  // Damage indicator decay
  if (damageFlashTimer > 0) {
    damageFlashTimer -= dt;
    if (damageFlashTimer <= 0) {
      damageIndicator.style.borderColor = 'rgba(255,0,0,0)';
    }
  }
}

function initGame(networked: boolean = false): void {
  started = true;
  paused = false;
  networkedMode = networked;

  // Init input source
  const theCanvas = document.querySelector('canvas')!;
  inputSource = new KeyboardMouseSource(theCanvas);
  inputSource.setSensitivity(settings.get().sensitivity);
  inputSource.setAngles(0, 0);

  // Reset player
  if (!networked) {
    player.pos = { x: 0, y: 1.6, z: 10 };
    player.vel = { x: 0, y: 0, z: 0 };
    player.yaw = 0;
    player.pitch = 0;
    player.grounded = false;
  }
  hp = PLAYER_MAX_HP;
  ammo = MAG_SIZE;
  kills = 0;
  playerDeaths = 0;
  isDead = false;
  matchPhase = 'playing';
  postMatchTimer = 0;
  recentSpawns = [];
  killFeed = [];
  inputSeq = 0;
  fireCooldown = 0;
  simAccum = 0;
  recoilPitch = 0;

  // Collect obstacle meshes for raycast occlusion
  obstacleMeshes = [];
  arena.group.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.name !== 'ramp') {
      obstacleMeshes.push(obj);
    }
  });

  // Init viewmodel
  if (viewmodel) viewmodel.dispose();
  viewmodel = new ViewModel(scene, camera);

  if (networkedMode) {
    // Networked mode: server authoritative
    netGame = new NetGame(netClient);
    remotePlayers = new RemotePlayerManager(scene);
    // Remove local dummy targets
    for (const t of dummyTargets) {
      scene.remove(t.group);
      t.dispose();
    }
    dummyTargets = [];
    // Camera starts at origin, server will set position
    camera.position.set(0, 1.6, 10);
    console.log('[Game] Started in NETWORKED mode');
  } else {
    // Practice mode: local simulation
    if (netGame) netGame = null;
    if (remotePlayers) {
      remotePlayers.dispose();
      remotePlayers = null;
    }
    dummyTargets = createDummyTargets(5, ARENA_HALF);
    for (const t of dummyTargets) {
      scene.add(t.group);
    }
    // Spawn player at smart position
    spawnPlayer(performance.now() / 1000);
    console.log('[Game] Started in PRACTICE mode');
  }

  // Lock pointer
  setTimeout(() => (document.querySelector('canvas') as HTMLCanvasElement)?.requestPointerLock(), 100);
}

// --- Render loop ---
let lastTime = performance.now();

function renderLoop(now: number): void {
  requestAnimationFrame(renderLoop);

  const frameDt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  fpsCounter.update();

  // --- Hit marker decay ---
  if (hitMarkerTimer > 0) {
    hitMarkerTimer -= frameDt;
    if (hitMarkerTimer <= 0) hitMarker.classList.remove('show');
  }

  // --- Paused: still render but don't simulate ---
  if (!started || paused || tabOpen) {
    renderer.render(scene, camera);
    return;
  }

  // --- NETWORKED MODE: send input + render from server snapshots ---
  if (networkedMode && netGame && inputSource) {
    // Send input to server
    const input = inputSource.poll();
    const yaw = inputSource.getYaw();
    const pitch = inputSource.getPitch();

    // Build button bits from input
    const buttons = input.buttons;

    inputSeq++;
    netGame.sendInput(inputSeq, {
      moveX: input.moveX,
      moveZ: input.moveZ,
      yaw,
      pitch,
      buttons,
    });

    // Update from server snapshot
    netGame.update();
    const me = netGame.getMe();
    if (me) {
      // Position from server, rotation from client (smooth)
      camera.position.set(me.pos.x, me.pos.y, me.pos.z);
      camera.rotation.order = 'YXZ';
      camera.rotation.y = yaw;
      camera.rotation.x = pitch;

      // Update HUD from server state
      hp = me.hp;
      ammo = me.ammo;
      isDead = !me.alive;

      // Handle death overlay
      if (!me.alive) {
        deathOverlay.style.display = 'flex';
      } else {
        deathOverlay.style.display = 'none';
      }
    }

    // Update remote players
    if (remotePlayers) {
      remotePlayers.update(netGame.getAll(), camera);
    }

    // Process server events for kill feed
    for (const evt of netGame.pendingEvents) {
      if (evt.type === 'Kill') {
        const killer = netGame.get((evt as any).killer);
        const victim = netGame.get((evt as any).victim);
        if (killer && victim) {
          addKillFeedEntry(killer.name, victim.name, false);
        }
      }
      if (evt.type === 'Hit') {
        showHitMarker();
      }
    }
  } else {
  simAccum += frameDt;
  while (simAccum >= TICK_DT) {
    // Don't simulate movement/shooting when dead — only countdown
    if (!isDead) {
    // Snapshot position before stepping (for render interpolation)
    prevPos.x = player.pos.x;
    prevPos.y = player.pos.y;
    prevPos.z = player.pos.z;

    if (inputSource) {
      const input = inputSource.poll();
      lastSimInput = input;

      // Semi-auto fire: edge-triggered on press, fire-rate capped
      fireCooldown -= TICK_DT;
      if (fireCooldown < 0) fireCooldown = 0;
      if (inputSource.getFirePressed() && !reloading && ammo > 0 && fireCooldown <= 0) {
        ammo--;
        fireCooldown = FIRE_COOLDOWN_S;
        // Recoil: apply to visual offset only, not player.pitch
        recoilPitch += RECOIL_KICK;

        // --- M2: Hitscan ---
        if (inputSource) {
          // Compute shoot direction from camera yaw/pitch
          const yaw = inputSource.getYaw();
          const pitch = inputSource.getPitch();
          _shootDir.set(
            -Math.sin(yaw) * Math.cos(pitch),
            Math.sin(pitch),
            -Math.cos(yaw) * Math.cos(pitch)
          );

          const hit = raycastHitscan(
            camera.position,
            _shootDir,
            dummyTargets,
            obstacleMeshes,
            HITSCAN_MAX_RANGE,
            SPREAD_RAD,
          );

          if (hit.target) {
            const damage = hit.isHead ? DAMAGE_HEAD : DAMAGE_BODY;
            hit.target.hp -= damage;

            // Show hit marker on confirmed hit
            showHitMarker();

            // Play shoot sound
            playShoot();

            // Viewmodel recoil
            viewmodel?.fire();

            // Check kill
            if (hit.target.hp <= 0) {
              hit.target.die();
              kills++;
              hit.target.kills = 0; // bots don't get kills in FFA
              addKillFeedEntry('You', hit.target.name, hit.isHead);
              playKill();

              // Check match end
              if (kills >= KILL_GOAL && matchPhase === 'playing') {
                startPostMatch();
              }
            }
          } else {
            // Miss — still play shoot sound
            playShoot();
            viewmodel?.fire();
          }
        }
      }

      // Reload (edge-triggered)
      if (inputSource.getReloadPressed() && !reloading && ammo < MAG_SIZE) {
        reloading = true;
        reloadTimer = RELOAD_TIME_S;
        playReload();
        viewmodel?.setReloading(true);
      }

      if (reloading) {
        reloadTimer -= TICK_DT;
        if (reloadTimer <= 0) {
          reloading = false;
          ammo = MAG_SIZE;
          viewmodel?.setReloading(false);
        }
      }

      // Jump
      if ((input.buttons & ButtonFlags.JUMP) !== 0 && player.grounded) {
        // Jump event
      }

      // --- Step simulation ---
      playerStep(player, input, TICK_DT, WORLD_BOUNDS, OBSTACLES);

      // --- Land detection ---
      if (!player.grounded) {
        // In air
      }
    }
  } else {
    // Dead — countdown respawn
    playerRespawnTimer -= TICK_DT;
  }
    simAccum -= TICK_DT;
  }

  // --- Render interpolation ---
  const lerpT = clamp(simAccum / TICK_DT, 0, 1);
  lerpPos(renderPos, prevPos, player.pos, lerpT);

  // --- Camera ---
  if (inputSource) {
    // Source yaw/pitch from inputSource per-frame
    const yaw = inputSource.getYaw();
    const pitch = inputSource.getPitch();
    player.yaw = yaw;
    player.pitch = pitch;
  }

  camera.position.set(renderPos.x, renderPos.y + PLAYER_RADIUS * 0.5, renderPos.z);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = player.yaw;
  camera.rotation.x = player.pitch - recoilPitch;

  // Decay recoil
  if (recoilPitch > 0) {
    recoilPitch = Math.max(0, recoilPitch - RECOIL_DECAY_RATE * frameDt);
  }
  }

  // --- Viewmodel ---
  if (viewmodel && inputSource) {
    viewmodel.update(frameDt, inputSource.getFirePressed());
  }

  // --- Update overlays ---
  updateOverlays(frameDt);

  // --- HUD update (throttled) ---
  updateHUD();

  // --- Kill feed ---
  updateKillFeedUI();

  // --- Post-match timer ---
  if (matchPhase === 'post_match') {
    postMatchTimer -= frameDt;
    if (postMatchTimer <= 0) {
      resetMatch();
    }
  }

  // --- Render ---
  renderer.render(scene, camera);
}

// --- Boot ---
(async () => {
  await initRenderer();
  applyQuality(settings.get().graphicsQuality);
  updateCrosshair();
  updateHUD();
  requestAnimationFrame(renderLoop);
})();

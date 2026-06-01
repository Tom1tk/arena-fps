import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import type { GraphicsQuality } from '../../shared/types';
import { TICK_DT, PLAYER_MAX_HP, MAG_SIZE, PLAYER_RADIUS } from '../../shared/constants';
import { playerStep, type PlayerSim } from '../../shared/simulation/step';
import { clamp } from '../../shared/math';
import { createArena } from './arena';
import { FPSCounter } from './fpsCounter';
import { SettingsStore } from './settingsStore';
import { KeyboardMouseSource } from './inputSource';

// --- Arena bounds for collision ---
const ARENA_HALF = 20;
const WORLD_BOUNDS = {
  minY: -10, maxY: 100,
  minX: -ARENA_HALF, maxX: ARENA_HALF,
  minZ: -ARENA_HALF, maxZ: ARENA_HALF,
};

// --- DOM refs ---
const fpsEl = document.getElementById('fps-counter')!;
const debugEl = document.getElementById('debug-line')!;
const toggleBtn = document.getElementById('graphics-toggle')!;
const titleOverlay = document.getElementById('title-overlay')!;
const startBtn = document.getElementById('start-btn')!;
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

// --- Settings ---
const settings = SettingsStore.getInstance();

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

// Fixed timestep accumulator
let simAccum = 0;

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
  (document.querySelector('canvas') as HTMLCanvasElement)?.requestPointerLock();
});

leaveBtn.addEventListener('click', () => {
  started = false;
  paused = false;
  pauseOverlay.style.display = 'none';
  titleOverlay.style.display = 'flex';
  if (document.pointerLockElement) document.exitPointerLock();
});

function updateTabScoreboard(): void {
  const tbody = document.getElementById('tab-sb-body')!;
  tbody.innerHTML = `<tr><td>1</td><td>You</td><td>${kills}</td><td>0</td></tr>`;
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

// --- Start ---
startBtn.addEventListener('click', () => {
  titleOverlay.style.display = 'none';
  started = true;
  paused = false;

  // Init input source
  const theCanvas = document.querySelector('canvas')!;
  inputSource = new KeyboardMouseSource(theCanvas);
  inputSource.setSensitivity(settings.get().sensitivity);
  inputSource.setAngles(0, 0);

  // Reset player
  player.pos = { x: 0, y: 1.6, z: 10 };
  player.vel = { x: 0, y: 0, z: 0 };
  player.yaw = 0;
  player.pitch = 0;
  player.grounded = false;
  hp = PLAYER_MAX_HP;
  ammo = MAG_SIZE;
  kills = 0;

  // Click canvas to lock pointer
  setTimeout(() => theCanvas.requestPointerLock(), 100);
});

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

  // --- Fixed timestep simulation ---
  simAccum += frameDt;
  while (simAccum >= TICK_DT) {
    if (inputSource) {
      const input = inputSource.poll();

      // Fire handling
      if (input.buttons & 4 && !reloading && ammo > 0) {
        ammo--;
        showHitMarker();
        // Recoil pitch
        player.pitch += 0.02;
      }

      // Reload
      if (input.buttons & 8 && !reloading && ammo < MAG_SIZE) {
        reloading = true;
        reloadTimer = 1.6;
      }

      if (reloading) {
        reloadTimer -= TICK_DT;
        if (reloadTimer <= 0) {
          reloading = false;
          ammo = MAG_SIZE;
        }
      }

      playerStep(player, input, TICK_DT, WORLD_BOUNDS);
    }
    simAccum -= TICK_DT;
  }

  // --- Update camera from player sim ---
  camera.position.set(player.pos.x, player.pos.y, player.pos.z);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = -player.yaw;
  camera.rotation.x = -player.pitch;

  // --- Update HUD ---
  updateHUD();
  updateCrosshair();

  // --- Debug line ---
  const ping = '—';
  debugEl.textContent = `${isWebGPU ? 'WebGPU' : 'WebGL2'} | ping: ${ping}ms | tick: 30Hz`;

  // --- Scoreboard ---
  scoreboardEl.textContent = `K: ${kills}`;

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

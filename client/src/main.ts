import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import type { GraphicsQuality } from '../../shared/types';
import {
  TICK_DT, PLAYER_MAX_HP, MAG_SIZE, PLAYER_RADIUS, FIRE_RATE_RPM,
  DAMAGE_BODY, DAMAGE_HEAD, HITSCAN_MAX_RANGE, SPREAD_RAD, RELOAD_TIME_S,
} from '../../shared/constants';
import { playerStep, type PlayerSim } from '../../shared/simulation/step';
import { clamp } from '../../shared/math';
import { createArena } from './arena';
import { FPSCounter } from './fpsCounter';
import { SettingsStore } from './settingsStore';
import { KeyboardMouseSource } from './inputSource';
import { createDummyTargets, type DummyTarget, raycastHitscan } from './hitscan';
import { ViewModel } from './viewmodel';
import { playShoot, playReload, playKill } from './audio';
import type { InputFrame } from '../../shared/types';

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
  recoilPitch = 0;

  // --- M2: Create dummy targets ---
  dummyTargets = createDummyTargets(5, ARENA_HALF);
  for (const t of dummyTargets) {
    scene.add(t.group);
  }

  // --- M2: Collect obstacle meshes for raycast occlusion ---
  obstacleMeshes = [];
  arena.group.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.name !== 'ramp') {
      obstacleMeshes.push(obj);
    }
  });

  // --- M2: Create viewmodel ---
  if (viewmodel) viewmodel.dispose();
  viewmodel = new ViewModel(scene, camera);

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
            hit.target.takeDamage(damage);

            // Show hit marker on confirmed hit
            showHitMarker();

            // Play shoot sound
            playShoot();

            // Viewmodel recoil
            viewmodel?.fire();

            // Check kill
            if (hit.target.hp <= 0) {
              kills++;
              playKill();
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

      playerStep(player, input, TICK_DT, WORLD_BOUNDS, OBSTACLES);
    }
    simAccum -= TICK_DT;
  }

  // --- Decay recoil toward zero each frame (visual only) ---
  recoilPitch *= Math.max(0, 1 - RECOIL_DECAY_RATE * frameDt);

  // --- Interpolate render position ---
  const alpha = simAccum / TICK_DT; // 0..1 fraction within current tick
  lerpPos(renderPos, prevPos, player.pos, alpha);

  // --- Update camera from interpolated position + per-frame aim ---
  camera.position.set(renderPos.x, renderPos.y, renderPos.z);
  camera.rotation.order = 'YXZ';
  // Source yaw/pitch directly from input source (per-frame, no tick-coupling)
  if (inputSource) {
    camera.rotation.y = inputSource.getYaw();
    // Clamp recoil so total pitch stays within ±89°
    const basePitch = inputSource.getPitch();
    const maxRecoil = Math.PI / 2 - 0.01 - basePitch;
    const clampedRecoil = recoilPitch > 0 ? Math.min(recoilPitch, maxRecoil) : recoilPitch;
    camera.rotation.x = basePitch + clampedRecoil;
  }

  // --- M2: Update viewmodel ---
  // Use cached movement state from the sim input (avoid double-polling which resets edge detection)
  const cachedInput = lastSimInput;
  const isMoving = cachedInput ? (cachedInput.moveX !== 0 || cachedInput.moveZ !== 0) : false;
  viewmodel?.update(frameDt, isMoving);

  // --- M2: Update dummy targets (respawn timers) ---
  for (const t of dummyTargets) {
    t.update(frameDt);
  }

  // --- Render (timed) ---
  const renderStart = performance.now();
  renderer.render(scene, camera);
  const renderMs = performance.now() - renderStart;

  // --- Debug info (throttled via FPSCounter) ---
  fpsCounter.setDebugInfo(`${isWebGPU ? 'WebGPU' : 'WebGL2'} | render: ${renderMs.toFixed(1)}ms | tick: 30Hz`);

  // --- Update HUD (throttled: only when values actually change) ---
  const hpPct = Math.round((hp / PLAYER_MAX_HP) * 100);
  if (hpFill.dataset.lastHp !== String(hpPct)) {
    hpFill.style.width = `${hpPct}%`;
    hpFill.style.background = hp > 60 ? '#0c0' : hp > 30 ? '#cc0' : '#c00';
    hpFill.dataset.lastHp = String(hpPct);
  }
  const ammoText = reloading ? 'Reloading...' : `${ammo} / ∞`;
  if (ammoDisplay.textContent !== ammoText) {
    ammoDisplay.textContent = ammoText;
  }
  if (scoreboardEl.textContent !== `K: ${kills}`) {
    scoreboardEl.textContent = `K: ${kills}`;
  }
}

// --- Boot ---
(async () => {
  await initRenderer();
  applyQuality(settings.get().graphicsQuality);
  updateCrosshair();
  updateHUD();
  requestAnimationFrame(renderLoop);
})();

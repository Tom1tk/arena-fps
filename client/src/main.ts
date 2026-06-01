import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import type { GraphicsQuality } from '../../shared/types';
import { createArena } from './arena';
import { FPSCounter } from './fpsCounter';
import { SettingsStore } from './settingsStore';

// --- DOM refs ---
const fpsEl = document.getElementById('fps-counter')!;
const debugEl = document.getElementById('debug-line')!;
const toggleBtn = document.getElementById('graphics-toggle')!;
const titleOverlay = document.getElementById('title-overlay')!;
const startBtn = document.getElementById('start-btn')!;

// --- Settings ---
const settings = SettingsStore.getInstance();

// --- Renderer init ---
let renderer: THREE.WebGLRenderer | WebGPURenderer;
let isWebGPU = false;

/** Check whether the WebGPURenderer is actually using the WebGPU backend */
function checkBackend(r: WebGPURenderer): boolean {
  try {
    return (r as any).backend?.isWebGPUBackend === true;
  } catch {
    return false;
  }
}

async function initRenderer(): Promise<void> {
  const quality = settings.get().graphicsQuality;

  // Try WebGPU first
  try {
    const gpuRenderer = new WebGPURenderer({ antialias: quality === 'high' });
    await gpuRenderer.init();
    renderer = gpuRenderer;
    isWebGPU = checkBackend(gpuRenderer);
    console.log(`[Renderer] Backend: ${isWebGPU ? 'WebGPU' : 'WebGL2'}`);
  } catch {
    // Fall back to WebGL2
    renderer = new THREE.WebGLRenderer({ antialias: quality === 'high', powerPreference: 'high-performance' });
    isWebGPU = false;
    console.log('[Renderer] Backend: WebGL2 (WebGPU unavailable)');
  }

  // DPR clamp
  const dpr = Math.min(window.devicePixelRatio, quality === 'low' ? 1 : 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.insertBefore(renderer.domElement, document.body.firstChild);
}

// --- Scene & Camera ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);

const camera = new THREE.PerspectiveCamera(
  settings.get().fov,
  window.innerWidth / window.innerHeight,
  0.1,
  500
);
camera.position.set(0, 3, 10);

// --- Arena ---
const arena = createArena(settings.get().graphicsQuality);
scene.add(arena.group);

// --- FPS counter ---
const fpsCounter = new FPSCounter(fpsEl, debugEl);

// --- Graphics toggle ---
function applyQuality(quality: GraphicsQuality): void {
  settings.set({ graphicsQuality: quality });
  const dpr = Math.min(window.devicePixelRatio, quality === 'low' ? 1 : 2);
  renderer.setPixelRatio(dpr);

  // Toggle directional light
  const dirLight = scene.getObjectByName('dirLight') as THREE.DirectionalLight;
  if (dirLight) {
    dirLight.visible = quality === 'high';
  }

  // Update far plane
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

// --- Simple orbit controls (WASD-free for M0 scaffold) ---
let orbitAngle = 0;
const orbitRadius = 25;
const orbitHeight = 15;

// --- Start ---
let started = false;
startBtn.addEventListener('click', () => {
  titleOverlay.style.display = 'none';
  started = true;
});

// --- Render loop ---
function renderLoop(): void {
  if (!started) {
    requestAnimationFrame(renderLoop);
    renderer.render(scene, camera);
    return;
  }

  fpsCounter.update();

  // Simple orbit for demo
  orbitAngle += 0.003;
  camera.position.x = Math.cos(orbitAngle) * orbitRadius;
  camera.position.z = Math.sin(orbitAngle) * orbitRadius;
  camera.position.y = orbitHeight;
  camera.lookAt(0, 1, 0);

  // Debug line
  const ping = '—'; // placeholder until networking
  debugEl.textContent = `${isWebGPU ? 'WebGPU' : 'WebGL2'} | ping: ${ping}ms | tick: —`;

  renderer.render(scene, camera);
  requestAnimationFrame(renderLoop);
}

// --- Boot ---
(async () => {
  await initRenderer();
  applyQuality(settings.get().graphicsQuality);
  renderLoop();
})();

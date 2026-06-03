/**
 * M8 — Directional/positional audio system
 *
 * Uses THREE.AudioListener + THREE.PositionalAudio for remote sounds.
 * Local sounds (shoot, reload, hit, headshot) remain mono via raw Web Audio API.
 * All sounds are synthesized — no external audio files needed.
 *
 * Sound pooling: 8 reusable PositionalAudio nodes per sound type.
 */

import * as THREE from 'three';
import { AUDIO_MAX_DISTANCE, AUDIO_REF_DISTANCE, AUDIO_ROLLOFF_FACTOR } from '../../shared/constants';

// ─── Audio context ───────────────────────────────────────────────────────────

const AUDIO_CTX_KEY = '__arena_fps_audio_ctx__';

function getAudioContext(): AudioContext {
  if (!(window as any)[AUDIO_CTX_KEY]) {
    (window as any)[AUDIO_CTX_KEY] = new AudioContext();
  }
  return (window as any)[AUDIO_CTX_KEY] as AudioContext;
}

/** Resume audio context on first user gesture */
export function resumeAudioContext(): void {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();
}

// Attach resume listeners early (idempotent — they're no-ops after resume)
document.addEventListener('click', resumeAudioContext, { once: true });
document.addEventListener('keydown', resumeAudioContext, { once: true });

// ─── AudioListener (attached to camera) ───────────────────────────────────────

let audioListener: THREE.AudioListener | null = null;

/**
 * Creates a single THREE.AudioListener and attaches it to the camera.
 * Call once during initialization.
 */
export function setupAudioListener(camera: THREE.Camera): THREE.AudioListener {
  if (!audioListener) {
    audioListener = new THREE.AudioListener();
  }
  camera.add(audioListener);
  return audioListener;
}

/** Get the shared AudioListener instance (after setup) */
export function getAudioListener(): THREE.AudioListener | null {
  return audioListener;
}

// ─── Positional audio helpers ────────────────────────────────────────────────

/** Type of positional sound we pool */
type SoundPoolType = 'shoot' | 'footstep' | 'reload' | 'jump' | 'land';

const POOL_SIZE = 8; // reusable nodes per type

interface PositionalNode {
  audio: THREE.PositionalAudio;
  inUse: boolean;
}

/** Pool of pre-created PositionalAudio nodes, keyed by sound type */
const soundPools: Record<SoundPoolType, PositionalNode[]> = {
  shoot: [],
  footstep: [],
  reload: [],
  jump: [],
  land: [],
};

/**
 * Initialize a sound pool for a given type.
 * Must be called after setupAudioListener so the AudioListener exists.
 */
function initPool(type: SoundPoolType): void {
  const listener = getAudioListener();
  if (!listener) return;

  const pool = soundPools[type];
  if (pool.length > 0) return; // already initialized

  for (let i = 0; i < POOL_SIZE; i++) {
    const posAudio = new THREE.PositionalAudio(listener as unknown as THREE.AudioListener);
    posAudio.setRefDistance(AUDIO_REF_DISTANCE);
    posAudio.setMaxDistance(AUDIO_MAX_DISTANCE);
    posAudio.setRolloffFactor(AUDIO_ROLLOFF_FACTOR);
    posAudio.setDistanceModel('inverse');

    pool.push({ audio: posAudio, inUse: false });
  }
}

/**
 * Borrow a free node from the pool, or reuse the oldest in-use one.
 */
function borrowNode(type: SoundPoolType): THREE.PositionalAudio | null {
  initPool(type);
  const pool = soundPools[type];

  // find a free node
  for (const node of pool) {
    if (!node.inUse) {
      node.inUse = true;
      return node.audio;
    }
  }
  // all in-use — steal the first one (oldest)
  const stolen = pool[0];
  stolen.inUse = true;
  return stolen.audio;
}

/**
 * Return a node to the pool after it finishes playing.
 */
function releaseNode(type: SoundPoolType, audio: THREE.PositionalAudio): void {
  const pool = soundPools[type];
  for (const node of pool) {
    if (node.audio === audio) {
      node.inUse = false;
      break;
    }
  }
}

// --- A temporary scene group for positioning PositionalAudio nodes ---
// PositionalAudio inherits position from its parent object in the scene graph.
// We add them to a hidden group in the scene, position them, and remove after playing.
const audioSceneGroup: THREE.Group = new THREE.Group();
// scene will be passed at setup time
let audioScene: THREE.Scene | null = null;

/**
 * Call after scene is created to register it for audio positioning.
 */
export function setupAudioScene(scene: THREE.Scene): void {
  audioScene = scene;
  scene.add(audioSceneGroup);
}

/**
 * Play a synthesized sound through a PositionalAudio node at the given world position.
 */
function playPositional(
  type: SoundPoolType,
  position: { x: number; y: number; z: number },
  volume: number,
  onSound: (ctx: AudioContext | OfflineAudioContext, dest: AudioNode, time: number) => void,
): void {
  const audio = borrowNode(type);
  if (!audio) return;

  // Position via the 3D scene graph
  audio.position.set(position.x, position.y, position.z);
  audio.setVolume(volume);

  // Synthesize into a buffer and set it on the PositionalAudio
  const ctx = audio.context;
  const duration = type === 'reload' ? 0.5 : 0.2;
  const sampleCount = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
  const channel = buffer.getChannelData(0);

  // Use a temporary gain to shape the sound into our buffer
  const offline = new OfflineAudioContext(1, sampleCount, ctx.sampleRate);
  const dest = offline.destination;
  onSound(offline, dest, 0);
  offline.startRendering().then(rendered => {
    const renderedData = rendered.getChannelData(0);
    for (let i = 0; i < channel.length && i < renderedData.length; i++) {
      channel[i] = renderedData[i];
    }
    audio.setBuffer(buffer);
    audio.play();
  });

  // Auto-release after sound duration
  setTimeout(() => {
    try { audio.stop(); } catch {}
    releaseNode(type, audio);
  }, duration * 1000 + 50);
}

// ─── Noise buffer cache (shared across calls) ────────────────────────────────

const noiseBufferCache = new Map<number, AudioBuffer>();

function getNoiseBuffer(ctx: AudioContext | OfflineAudioContext, duration: number): AudioBuffer {
  const key = Math.round(duration * 1000); // round to nearest ms as cache key
  if (noiseBufferCache.has(key)) {
    return noiseBufferCache.get(key)!;
  }
  const sampleCount = ctx.sampleRate * duration;
  const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  noiseBufferCache.set(key, buffer);
  return buffer;
}

// ─── Sound synthesis primitives ──────────────────────────────────────────────

/**
 * Gunshot synthesis: filtered noise burst with exponential decay.
 */
function synthesizeGunshot(ctx: AudioContext | OfflineAudioContext, output: AudioNode, time: number, volume: number = 0.4): void {
  const bufferSize = ctx.sampleRate * 0.08;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.15));
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.08);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(3000, time);
  filter.frequency.exponentialRampToValueAtTime(300, time + 0.08);

  source.connect(filter).connect(gain).connect(output);
  source.start(time);
}

/**
 * Click synthesis: short square oscillator burst.
 */
function synthesizeClick(ctx: AudioContext | OfflineAudioContext, output: AudioNode, time: number, freq: number, vol: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(freq, time);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

  osc.connect(gain).connect(output);
  osc.start(time);
  osc.stop(time + 0.05);
}

/**
 * Footstep synthesis: short, low-frequency noise burst.
 */
function synthesizeFootstep(ctx: AudioContext | OfflineAudioContext, output: AudioNode, time: number, volume: number = 0.15): void {
  const bufferSize = ctx.sampleRate * 0.05;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.2));
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1000;

  source.connect(filter).connect(gain).connect(output);
  source.start(time);
}

/**
 * Jump synthesis: short rising tone.
 */
function synthesizeJump(ctx: AudioContext | OfflineAudioContext, output: AudioNode, time: number, volume: number = 0.1): void {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(300, time);
  osc.frequency.exponentialRampToValueAtTime(600, time + 0.1);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);

  osc.connect(gain).connect(output);
  osc.start(time);
  osc.stop(time + 0.12);
}

/**
 * Land synthesis: low-frequency thud.
 */
function synthesizeLand(ctx: AudioContext | OfflineAudioContext, output: AudioNode, time: number, volume: number = 0.2): void {
  // Low oscillator thud
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(80, time);
  osc.frequency.exponentialRampToValueAtTime(30, time + 0.15);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.15);

  osc.connect(gain).connect(output);
  osc.start(time);
  osc.stop(time + 0.15);

  // Add noise burst for impact texture
  const bufferSize = ctx.sampleRate * 0.06;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.1));
  }
  const noiseSource = ctx.createBufferSource();
  noiseSource.buffer = buffer;

  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(volume * 0.5, time);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, time + 0.06);

  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'lowpass';
  noiseFilter.frequency.value = 400;

  noiseSource.connect(noiseFilter).connect(noiseGain).connect(output);
  noiseSource.start(time);
}

// ─── Public API — Local (mono) sounds ────────────────────────────────────────

/**
 * Play a synthesized gunshot sound (local player, mono).
 */
export function playShootLocal(): void {
  const ctx = getAudioContext();
  synthesizeGunshot(ctx, ctx.destination, ctx.currentTime, 0.3);
}

/**
 * Play a synthesized reload sound (local player, mono).
 */
export function playReloadLocal(): void {
  const ctx = getAudioContext();
  synthesizeClick(ctx, ctx.destination, ctx.currentTime, 800, 0.15);
  synthesizeClick(ctx, ctx.destination, ctx.currentTime + 0.25, 1200, 0.15);
}

/**
 * Play footstep sound (local player, mono).
 */
export function playFootstep(): void {
  const ctx = getAudioContext();
  synthesizeFootstep(ctx, ctx.destination, ctx.currentTime, 0.08);
}

/**
 * Play hit feedback — sharp click (local only).
 */
export function playHit(): void {
  const ctx = getAudioContext();
  // Short, sharp high-frequency click
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(2400, ctx.currentTime);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.25, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);

  osc.connect(gain).connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.06);
}

/**
 * Play headshot feedback — higher pitch, brighter (local only).
 */
export function playHeadshot(): void {
  const ctx = getAudioContext();
  // Double-tone: sharp high + mid
  const osc1 = ctx.createOscillator();
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(3200, ctx.currentTime);

  const osc2 = ctx.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(1600, ctx.currentTime);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.2, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);

  osc1.connect(gain);
  osc2.connect(gain);
  gain.connect(ctx.destination);

  osc1.start(ctx.currentTime);
  osc2.start(ctx.currentTime);
  osc1.stop(ctx.currentTime + 0.12);
  osc2.stop(ctx.currentTime + 0.12);
}

/**
 * Play kill sound (short ascending tone).
 */
export function playKill(): void {
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.1);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.2, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);

  osc.connect(gain).connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.2);
}

// ─── Public API — Remote (positional) sounds ─────────────────────────────────

/**
 * Play a gunshot sound at a remote player position (positional audio).
 */
export function playShootRemote(position: { x: number; y: number; z: number }): void {
  if (!audioListener) return;
  playPositional('shoot', position, 0.4, (ctx, output, time) => {
    synthesizeGunshot(ctx, output, time, 1.0);
  });
}

/**
 * Play a reload sound at a remote player position (positional audio).
 */
export function playReloadRemote(position: { x: number; y: number; z: number }): void {
  if (!audioListener) return;
  playPositional('reload', position, 0.2, (ctx, output, time) => {
    synthesizeClick(ctx, output, time, 800, 0.15);
    synthesizeClick(ctx, output, time + 0.25, 1200, 0.15);
  });
}

/**
 * Play a footstep sound at a remote player position (positional audio).
 */
export function playFootstepRemote(position: { x: number; y: number; z: number }): void {
  playPositional('footstep', position, 0.15, (ctx, output, time) => {
    synthesizeFootstep(ctx, output, time, 1.0);
  });
}

/**
 * Play a jump sound at a remote player position (positional audio).
 */
export function playJumpRemote(position: { x: number; y: number; z: number }): void {
  playPositional('jump', position, 0.1, (ctx, output, time) => {
    synthesizeJump(ctx, output, time, 1.0);
  });
}

/**
 * Play a land/thud sound at a remote player position (positional audio).
 */
export function playLandRemote(position: { x: number; y: number; z: number }): void {
  playPositional('land', position, 0.2, (ctx, output, time) => {
    synthesizeLand(ctx, output, time, 1.0);
  });
}

// ─── Backward compatibility aliases ──────────────────────────────────────────

/** Alias for backward compatibility — resolves to local mono version */
export const playShoot = playShootLocal;
export const playReload = playReloadLocal;

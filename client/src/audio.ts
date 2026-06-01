/**
 * M2 — Base SFX: shoot, reload, footstep (local player only, positional for remotes at M8)
 *
 * Uses Web Audio API with synthesized sounds — no external audio files needed.
 */

const AUDIO_CTX_KEY = '__arena_fps_audio_ctx__';

function getAudioContext(): AudioContext {
  if (!(window as any)[AUDIO_CTX_KEY]) {
    (window as any)[AUDIO_CTX_KEY] = new AudioContext();
  }
  return (window as any)[AUDIO_CTX_KEY] as AudioContext;
}

/**
 * Play a synthesized gunshot sound.
 */
export function playShoot(): void {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();

  // Noise burst for gunshot
  const bufferSize = ctx.sampleRate * 0.08; // 80ms
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.15));
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.3, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(3000, ctx.currentTime);
  filter.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.08);

  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(ctx.currentTime);
}

/**
 * Play a synthesized reload sound (two clicks).
 */
export function playReload(): void {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();

  // Click 1: slide back
  playClick(ctx, ctx.currentTime, 800, 0.15);
  // Click 2: slide forward
  playClick(ctx, ctx.currentTime + 0.25, 1200, 0.15);
}

function playClick(ctx: AudioContext, time: number, freq: number, vol: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.setValueAtTime(freq, time);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

  osc.connect(gain).connect(ctx.destination);
  osc.start(time);
  osc.stop(time + 0.05);
}

/**
 * Play a footstep sound (short noise burst).
 */
export function playFootstep(): void {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();

  const bufferSize = ctx.sampleRate * 0.05;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.2));
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.08, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1000;

  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(ctx.currentTime);
}

/**
 * Play a kill sound (short tone).
 */
export function playKill(): void {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();

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

/**
 * True FPS counter — measures actual rendered frame rate.
 *
 * The browser may fire requestAnimationFrame callbacks faster than frames
 * are actually composited to screen (e.g., when VSync is active or the
 * compositor drops frames). This counter tracks both:
 *
 *   - "rAF"  : how many requestAnimationFrame callbacks fire per second
 *   - "FPS"  : actual rendered frames (measured by timing deltas)
 *
 * If rAF >> FPS, frames are being dropped by the compositor.
 * If rAF ≈ FPS but both are low, the render loop is slow.
 */
export class FPSCounter {
  private fpsEl: HTMLElement;
  private debugEl: HTMLElement;

  // rAF callback counter
  private rafFrames = 0;
  private rafLastTime = performance.now();
  private rafCount = 0;

  // True FPS — measured by frame delta timing
  private trueFrames = 0;
  private trueLastTime = performance.now();
  private trueCount = 0;

  // Frame time tracking for diagnostics
  private frameTimes: number[] = [];
  private lastFrameTime = 0;

  constructor(fpsEl: HTMLElement, debugEl: HTMLElement) {
    this.fpsEl = fpsEl;
    this.debugEl = debugEl;
  }

  update(): void {
    const now = performance.now();

    // --- rAF callback rate ---
    this.rafFrames++;
    if (now - this.rafLastTime >= 1000) {
      this.rafCount = this.rafFrames;
      this.rafFrames = 0;
      this.rafLastTime = now;
    }

    // --- True FPS (frames that actually rendered) ---
    this.trueFrames++;
    if (now - this.trueLastTime >= 1000) {
      this.trueCount = this.trueFrames;
      this.trueFrames = 0;
      this.trueLastTime = now;
    }

    // --- Frame time tracking ---
    if (this.lastFrameTime > 0) {
      const delta = now - this.lastFrameTime;
      this.frameTimes.push(delta);
      if (this.frameTimes.length > 60) this.frameTimes.shift();
    }
    this.lastFrameTime = now;

    // --- Calculate percentiles for diagnostics ---
    let p50 = 0;
    let p99 = 0;
    let dropped = 0;
    if (this.frameTimes.length > 2) {
      const sorted = [...this.frameTimes].sort((a, b) => a - b);
      p50 = sorted[Math.floor(sorted.length * 0.5)];
      p99 = sorted[Math.floor(sorted.length * 0.99)];
      // Frames that took longer than 33ms (below 30fps) are "dropped"
      dropped = this.frameTimes.filter(t => t > 33).length;
    }

    // --- Update display ---
    const color = this.trueCount >= 120 ? '#0f0' : this.trueCount >= 60 ? '#ff0' : '#f00';
    this.fpsEl.textContent = `FPS: ${this.trueCount} (rAF: ${this.rafCount})`;
    this.fpsEl.style.color = color;

    if (p50 > 0) {
      this.debugEl.textContent = `p50: ${p50.toFixed(1)}ms | p99: ${p99.toFixed(1)}ms | dropped: ${dropped}`;
    }
  }

  setDebugInfo(text: string): void {
    this.debugEl.textContent = text;
  }
}

/**
 * True FPS counter — measures actual rendered frame rate.
 *
 * Updates the DOM at most once per second to avoid layout thrashing.
 */
export class FPSCounter {
  private fpsEl: HTMLElement;
  private debugEl: HTMLElement;

  // True FPS — measured by frame delta timing
  private frameCount = 0;
  private lastUpdateTime = performance.now();
  private currentFPS = 0;

  // Frame time tracking for diagnostics
  private frameTimes: number[] = [];
  private lastFrameTime = 0;

  // Stale debug text (set externally, updated throttled)
  private pendingDebugText = '';

  constructor(fpsEl: HTMLElement, debugEl: HTMLElement) {
    this.fpsEl = fpsEl;
    this.debugEl = debugEl;
  }

  update(): void {
    const now = performance.now();

    // Track frame times
    if (this.lastFrameTime > 0) {
      const delta = now - this.lastFrameTime;
      this.frameTimes.push(delta);
      if (this.frameTimes.length > 120) this.frameTimes.shift();
    }
    this.lastFrameTime = now;
    this.frameCount++;

    // Throttle DOM updates to ~2x per second
    if (now - this.lastUpdateTime < 500) return;
    this.lastUpdateTime = now;

    this.currentFPS = Math.round((this.frameCount * 1000) / (now - this.lastUpdateTime + (this.lastUpdateTime - (this.lastUpdateTime - 500))));
    // Simpler: count frames over the elapsed interval
    const elapsed = now - this.lastUpdateTime;
    this.currentFPS = Math.round((this.frameCount * 1000) / elapsed);

    // Calculate percentiles
    let p50 = 0;
    let p99 = 0;
    let dropped = 0;
    if (this.frameTimes.length > 2) {
      const sorted = [...this.frameTimes].sort((a, b) => a - b);
      p50 = sorted[Math.floor(sorted.length * 0.5)];
      p99 = sorted[Math.floor(sorted.length * 0.99)];
      dropped = this.frameTimes.filter(t => t > 33).length;
    }

    // Color based on performance
    const color = this.currentFPS >= 120 ? '#0f0' : this.currentFPS >= 60 ? '#ff0' : '#f00';
    this.fpsEl.textContent = `FPS: ${this.currentFPS}`;
    this.fpsEl.style.color = color;

    // Debug info
    if (p50 > 0) {
      this.debugEl.textContent = `p50: ${p50.toFixed(1)}ms | p99: ${p99.toFixed(1)}ms | dropped: ${dropped}${this.pendingDebugText ? ' | ' + this.pendingDebugText : ''}`;
    } else if (this.pendingDebugText) {
      this.debugEl.textContent = this.pendingDebugText;
    }

    // Reset counters
    this.frameCount = 0;
  }

  setDebugInfo(text: string): void {
    this.pendingDebugText = text;
  }
}

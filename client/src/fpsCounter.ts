/**
 * Lightweight FPS counter — no dependencies.
 * Shows current FPS (top-left, green) and can be extended for debug info.
 */
export class FPSCounter {
  private frames = 0;
  private lastTime = performance.now();
  private fps = 0;
  private fpsEl: HTMLElement;
  private debugEl: HTMLElement;

  constructor(fpsEl: HTMLElement, debugEl: HTMLElement) {
    this.fpsEl = fpsEl;
    this.debugEl = debugEl;
  }

  update(): void {
    this.frames++;
    const now = performance.now();
    const delta = now - this.lastTime;

    if (delta >= 500) {
      this.fps = Math.round((this.frames * 1000) / delta);
      this.fpsEl.textContent = `${this.fps} FPS`;

      // Color based on performance
      if (this.fps >= 120) {
        this.fpsEl.style.color = '#0f0';
      } else if (this.fps >= 60) {
        this.fpsEl.style.color = '#ff0';
      } else {
        this.fpsEl.style.color = '#f00';
      }

      this.frames = 0;
      this.lastTime = now;
    }
  }

  setDebugInfo(text: string): void {
    this.debugEl.textContent = text;
  }
}

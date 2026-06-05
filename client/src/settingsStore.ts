import type { CrosshairType, GraphicsQuality, Settings } from '../../shared/types';

/** Default settings — applied when localStorage is empty or invalid. */
const DEFAULTS: Settings = {
  sensitivity: 3.0,
  fov: 90,
  crosshairColour: '#00ff00',
  crosshairSize: 16,
  crosshairType: 'cross',
  graphicsQuality: 'high',
  playerName: '',
};

const STORAGE_KEY = 'arena-fps-settings';

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

export class SettingsStore {
  private static instance: SettingsStore;
  private data: Settings;

  private constructor() {
    this.data = this.load();
  }

  static getInstance(): SettingsStore {
    if (!SettingsStore.instance) {
      SettingsStore.instance = new SettingsStore();
    }
    return SettingsStore.instance;
  }

  private load(): Settings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULTS };
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return {
        ...DEFAULTS,
        ...parsed,
        sensitivity: clamp(parsed.sensitivity ?? DEFAULTS.sensitivity, 0.1, 20),
        fov: clamp(parsed.fov ?? DEFAULTS.fov, 70, 110),
        crosshairSize: clamp(parsed.crosshairSize ?? DEFAULTS.crosshairSize, 4, 64),
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  get(): Settings {
    return { ...this.data };
  }

  set(partial: Partial<Settings>): void {
    this.data = { ...this.data, ...partial };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // localStorage full or unavailable — ignore
    }
  }
}

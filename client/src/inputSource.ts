import type { InputFrame, InputSource } from '../../shared/types';
import { clamp, degToRad } from '../../shared/math';

const BUTTON_JUMP = 1;
const BUTTON_CROUCH = 2;
const BUTTON_FIRE = 4;
const BUTTON_RELOAD = 8;

/**
 * Keyboard + Mouse input source.
 * Produces InputFrame samples from raw DOM events.
 * Only this class touches keydown/mousedown/mousemove.
 */
export class KeyboardMouseSource implements InputSource {
  private sensitivity = 0.002;
  private canvas: HTMLCanvasElement;

  // Raw button state
  private keys = new Set<string>();
  private mouseButtons = 0;

  // Camera angles (persistent across frames)
  private yaw = 0;
  private pitch = 0;

  // Input sequence counter
  private seq = 0;

  // Pointer lock
  private pointerLocked = false;

  // Buttons pressed this frame (for one-shot actions like fire)
  private firePressed = false;
  private reloadPressed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    // Keyboard
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);

    // Mouse buttons
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);

    // Mouse movement → pointer lock
    canvas.addEventListener('click', this.onClick);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  setSensitivity(s: number): void {
    this.sensitivity = s * 0.001;
  }

  setAngles(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = pitch;
  }

  getYaw(): number { return this.yaw; }
  getPitch(): number { return this.pitch; }

  private onClick = () => {
    if (!this.pointerLocked) {
      this.canvas.requestPointerLock();
    }
  };

  private onPointerLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
  };

  private onKeyDown = (e: KeyboardEvent) => {
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 0) this.mouseButtons |= 1;
    if (e.button === 1 || e.button === 2) this.mouseButtons |= 2;
  };

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.mouseButtons &= ~1;
    if (e.button === 1 || e.button === 2) this.mouseButtons &= ~2;
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.pointerLocked) return;

    this.yaw -= e.movementX * this.sensitivity;
    this.pitch -= e.movementY * this.sensitivity;
    this.pitch = clamp(this.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  };

  poll(): InputFrame {
    // Movement
    let moveX = 0;
    let moveZ = 0;

    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) moveX -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) moveX += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) moveZ -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) moveZ += 1;

    // Buttons bitmask
    let buttons = 0;
    if (this.keys.has('Space')) buttons |= BUTTON_JUMP;
    if (this.keys.has('ControlLeft') || this.keys.has('ControlRight')) buttons |= BUTTON_CROUCH;
    if (this.mouseButtons & 1) buttons |= BUTTON_FIRE;
    if (this.keys.has('KeyR')) buttons |= BUTTON_RELOAD;

    this.seq++;

    return {
      seq: this.seq,
      viewTick: 0, // not used until networking (M6)
      moveX: clamp(moveX, -1, 1),
      moveZ: clamp(moveZ, -1, 1),
      yaw: this.yaw,
      pitch: this.pitch,
      buttons,
    };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('click', this.onClick);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    if (this.pointerLocked) {
      document.exitPointerLock();
    }
  }
}

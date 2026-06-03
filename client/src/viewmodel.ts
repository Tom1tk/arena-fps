/**
 * M2 — Procedural first-person viewmodel (pistol)
 *
 * Low-poly pistol mesh with idle/walk bob, recoil kick, and reload animation.
 * No rigged glTF needed — pure geometry.
 */

import * as THREE from 'three';

const RECOIL_KICK = 0.12; // radians of rotation kick
const RECOIL_TRANSLATE = 0.05; // meters back
const RECOIL_RECOVERY = 6; // per second
const BOB_SPEED = 5; // Hz while walking
const BOB_AMPLITUDE = 0.015; // meters
const RELOAD_ROTATION = -Math.PI * 0.4; // how far the gun drops during reload
const RELOAD_RECOVERY = 2.5; // per second

/**
 * Procedural pistol viewmodel attached to the camera.
 */
export class ViewModel {
  private group: THREE.Group;
  private gunMesh: THREE.Group;

  // Animation state
  private recoilAngle = 0;
  private recoilOffset = 0;
  private reloadAngle = 0;
  private isReloading = false;
  // Weapon sway from camera head turns (distinct from walk bob)
  private swayX = 0;
  private swayY = 0;
  private prevYaw = 0;
  private prevPitch = 0;

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    this.group = new THREE.Group();
    this.group.position.set(0.25, -0.2, -0.5);
    this.group.rotation.set(0, -0.05, 0);

    // Gun body
    const bodyGeo = new THREE.BoxGeometry(0.06, 0.12, 0.35);
    const bodyMat = new THREE.MeshBasicMaterial({ color: 0x333333 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.set(0, 0, 0);

    // Barrel
    const barrelGeo = new THREE.BoxGeometry(0.04, 0.04, 0.2);
    const barrelMat = new THREE.MeshBasicMaterial({ color: 0x222222 });
    const barrel = new THREE.Mesh(barrelGeo, barrelMat);
    barrel.position.set(0, 0.06, -0.25);

    // Grip
    const gripGeo = new THREE.BoxGeometry(0.05, 0.12, 0.06);
    const gripMat = new THREE.MeshBasicMaterial({ color: 0x444444 });
    const grip = new THREE.Mesh(gripGeo, gripMat);
    grip.position.set(0, -0.1, 0.1);
    grip.rotation.x = 0.3;

    // Handle detail
    const handleGeo = new THREE.BoxGeometry(0.04, 0.08, 0.04);
    const handleMat = new THREE.MeshBasicMaterial({ color: 0x555555 });
    const handle = new THREE.Mesh(handleGeo, handleMat);
    handle.position.set(0, -0.14, 0.12);
    handle.rotation.x = 0.3;

    this.gunMesh = new THREE.Group();
    this.gunMesh.add(body, barrel, grip, handle);

    this.group.add(this.gunMesh);
    camera.add(this.group);
    scene.add(camera);
  }

  /**
   * Get the group for external access (e.g., for positioning).
   */
  getGroup(): THREE.Group {
    return this.group;
  }

  /**
   * Apply recoil kick. Call when firing.
   */
  fire(): void {
    this.recoilAngle += RECOIL_KICK;
    this.recoilOffset += RECOIL_TRANSLATE;
  }

  /**
   * Set reload state.
   */
  setReloading(reloading: boolean): void {
    this.isReloading = reloading;
  }

  /**
   * Update animation state each frame.
   * @param dt Frame delta time
   * @param isMoving Whether the player is currently moving
   * @param yaw Current camera yaw (radians) for head-turn sway
   * @param pitch Current camera pitch (radians) for head-turn sway
   */
  update(dt: number, isMoving: boolean, yaw: number = 0, pitch: number = 0): void {
    // Recoil recovery
    this.recoilAngle *= Math.max(0, 1 - RECOIL_RECOVERY * dt);
    this.recoilOffset *= Math.max(0, 1 - RECOIL_RECOVERY * dt);

    // Reload animation
    if (this.isReloading) {
      this.reloadAngle += (RELOAD_ROTATION - this.reloadAngle) * RELOAD_RECOVERY * dt;
    } else {
      this.reloadAngle *= Math.max(0, 1 - RELOAD_RECOVERY * dt);
    }

    // Walk bob
    let bobX = 0;
    let bobY = 0;
    if (isMoving) {
      const t = performance.now() / 1000;
      bobX = Math.sin(t * BOB_SPEED) * BOB_AMPLITUDE;
      bobY = Math.abs(Math.sin(t * BOB_SPEED)) * BOB_AMPLITUDE;
    }

    // Weapon sway from head turns
    const yawDelta = yaw - this.prevYaw;
    const pitchDelta = pitch - this.prevPitch;
    this.swayX += yawDelta * 0.03;
    this.swayY -= pitchDelta * 0.03;
    this.swayX *= Math.max(0, 1 - 4 * dt);
    this.swayY *= Math.max(0, 1 - 4 * dt);
    this.prevYaw = yaw;
    this.prevPitch = pitch;

    // Apply all transforms
    this.group.position.x = 0.25 + bobX + this.swayX;
    this.group.position.y = -0.2 + bobY + this.swayY;
    this.group.rotation.x = -this.recoilAngle + this.reloadAngle;
    this.group.position.z = -0.5 + this.recoilOffset;
  }

  dispose(): void {
    this.gunMesh.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (obj.material instanceof THREE.Material) {
          obj.material.dispose();
        }
      }
    });
  }
}

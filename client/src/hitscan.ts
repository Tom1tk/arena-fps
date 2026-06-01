/**
 * M2 — Hitscan system + dummy targets (local sandbox)
 *
 * Dummy targets are replaced by networked players at M6.
 */

import * as THREE from 'three';
import {
  DAMAGE_BODY,
  DAMAGE_HEAD,
  HITSCAN_MAX_RANGE,
  PLAYER_MAX_HP,
  RESPAWN_DELAY_S,
} from '../../shared/constants';

// --- Types ---

export interface HitResult {
  target: DummyTarget | null;
  point: THREE.Vector3;
  isHead: boolean;
  distance: number;
  blocked: boolean;
}

// Reusable scratch objects (no per-frame allocation)
const _raycaster = new THREE.Raycaster();
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _spreadDir = new THREE.Vector3();

// --- Dummy Target ---

export class DummyTarget {
  group: THREE.Group;
  bodyMesh: THREE.Mesh;
  headMesh: THREE.Mesh;
  hpLabel: THREE.Sprite;
  hp = PLAYER_MAX_HP;
  alive = true;
  respawnTimer = 0;

  private _bodyMat: THREE.MeshBasicMaterial;
  private _headMat: THREE.MeshBasicMaterial;
  private _labelMat: THREE.SpriteMaterial;

  constructor() {
    // Body: box approximating a capsule (0.5m wide, 1.3m tall)
    const bodyGeo = new THREE.BoxGeometry(0.5, 1.3, 0.3);
    this._bodyMat = new THREE.MeshBasicMaterial({ color: 0xdd6633, transparent: true, opacity: 0.7 });
    this.bodyMesh = new THREE.Mesh(bodyGeo, this._bodyMat);
    this.bodyMesh.position.y = 0.95; // body center at ~0.95m

    // Head: small box on top
    const headGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
    this._headMat = new THREE.MeshBasicMaterial({ color: 0xcc4422, transparent: true, opacity: 0.7 });
    this.headMesh = new THREE.Mesh(headGeo, this._headMat);
    this.headMesh.position.y = 1.7; // head center at ~1.7m

    // HP label sprite
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 32;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${PLAYER_MAX_HP} HP`, 64, 22);
    const tex = new THREE.CanvasTexture(canvas);
    this._labelMat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.9 });
    this.hpLabel = new THREE.Sprite(this._labelMat);
    this.hpLabel.scale.set(1, 0.25, 1);
    this.hpLabel.position.y = 2.1;

    this.group = new THREE.Group();
    this.group.add(this.bodyMesh, this.headMesh, this.hpLabel);
  }

  setPosition(x: number, z: number): void {
    this.group.position.set(x, 0, z);
  }

  update(dt: number): void {
    if (!this.alive) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) {
        this.alive = true;
        this.hp = PLAYER_MAX_HP;
        this._bodyMat.color.setHex(0xdd6633);
        this._headMat.color.setHex(0xcc4422);
        this._bodyMat.opacity = 0.7;
        this._headMat.opacity = 0.7;
        this._labelMat.opacity = 0.9;
      }
    }
    this._updateLabel();
  }

  takeDamage(amount: number): void {
    if (!this.alive) return;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.respawnTimer = RESPAWN_DELAY_S;
      // Visual: turn gray/transparent on death
      this._bodyMat.color.setHex(0x555555);
      this._headMat.color.setHex(0x444444);
      this._bodyMat.opacity = 0.3;
      this._headMat.opacity = 0.3;
      this._labelMat.opacity = 0.3;
    }
  }

  private _updateLabel(): void {
    const canvas = (this._labelMat.map as THREE.CanvasTexture).image as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = this.alive ? '#fff' : '#888';
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'center';
    const text = this.alive ? `${this.hp} HP` : `${Math.ceil(this.respawnTimer)}s`;
    ctx.fillText(text, 64, 22);
    (this._labelMat.map as THREE.CanvasTexture).needsUpdate = true;
  }

  dispose(): void {
    this._bodyMat.dispose();
    this._headMat.dispose();
    this._labelMat.dispose();
    (this._labelMat.map as THREE.CanvasTexture).dispose();
    this.bodyMesh.geometry.dispose();
    this.headMesh.geometry.dispose();
  }
}

// --- Raycast hitscan ---

/**
 * Fire a hitscan ray and resolve the closest target hit.
 *
 * @param origin Camera eye position
 * @param direction Normalized camera forward vector (with optional spread applied)
 * @param targets Array of DummyTarget to check
 * @param obstacleMeshes Array of obstacle meshes in the scene for occlusion
 * @param maxRange Maximum ray distance (HITSCAN_MAX_RANGE)
 * @param spreadRad Spread angle in radians (0 = pinpoint)
 * @returns HitResult with target, hit point, head/body, distance, blocked flag
 */
export function raycastHitscan(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  targets: DummyTarget[],
  obstacleMeshes: THREE.Object3D[],
  maxRange: number = HITSCAN_MAX_RANGE,
  spreadRad: number = 0,
): HitResult {
  // Apply spread
  _spreadDir.copy(direction);
  if (spreadRad > 0) {
    // Random point in unit circle, convert to angular offset
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random(); // uniform in circle
    const offsetX = Math.cos(angle) * radius;
    const offsetZ = Math.sin(angle) * radius;
    _spreadDir.x += offsetX * spreadRad;
    _spreadDir.y += (Math.random() * 2 - 1) * radius * spreadRad;
    _spreadDir.z += offsetZ * spreadRad;
    _spreadDir.normalize();
  }

  _raycaster.set(origin, _spreadDir);
  _raycaster.far = maxRange;

  // Collect all hitable meshes + obstacle meshes
  const aliveTargets = targets.filter(t => t.alive);
  const targetMeshes: THREE.Mesh[] = [];
  for (const t of aliveTargets) {
    targetMeshes.push(t.bodyMesh, t.headMesh);
  }

  // Raycast against everything
  const allMeshes = [...targetMeshes, ...obstacleMeshes.filter((m): m is THREE.Mesh => m instanceof THREE.Mesh)];
  const intersects = _raycaster.intersectObjects(allMeshes, false);

  if (intersects.length === 0) {
    // Missed everything — endpoint of ray
    _rayOrigin.copy(origin).addScaledVector(_spreadDir, maxRange);
    return { target: null, point: _rayOrigin, isHead: false, distance: maxRange, blocked: false };
  }

  const hit = intersects[0];
  const hitObj = hit.object;

  // Determine if this is a target or obstacle
  const targetHit = aliveTargets.find(t => t.headMesh === hitObj || t.bodyMesh === hitObj);

  if (targetHit) {
    const isHead = hitObj === targetHit.headMesh;
    return {
      target: targetHit,
      point: hit.point,
      isHead,
      distance: hit.distance,
      blocked: false,
    };
  }

  // Hit an obstacle — blocked
  return {
    target: null,
    point: hit.point,
    isHead: false,
    distance: hit.distance,
    blocked: true,
  };
}

// --- Spawn dummy targets within arena bounds ---

export function createDummyTargets(
  count: number,
  arenaHalf: number,
): DummyTarget[] {
  const targets: DummyTarget[] = [];
  const minDist = 3; // minimum distance between targets
  const margin = 3; // keep away from walls

  for (let i = 0; i < count; i++) {
    const target = new DummyTarget();
    let placed = false;
    let attempts = 0;
    while (!placed && attempts < 100) {
      attempts++;
      const x = (Math.random() - 0.5) * 2 * (arenaHalf - margin);
      const z = (Math.random() - 0.5) * 2 * (arenaHalf - margin);
      // Check distance from existing targets
      let tooClose = false;
      for (const t of targets) {
        const dx = t.group.position.x - x;
        const dz = t.group.position.z - z;
        if (Math.sqrt(dx * dx + dz * dz) < minDist) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) {
        target.setPosition(x, z);
        placed = true;
      }
    }
    targets.push(target);
  }

  return targets;
}

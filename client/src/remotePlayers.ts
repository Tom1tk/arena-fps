/**
 * Arena FPS — Remote player rendering
 *
 * Creates and maintains 3D meshes for other players/bots in the scene.
 */
import * as THREE from 'three';
import type { EntityState } from './netGame';

const HP_BAR_COLOR_ALIVE = 0x00ff00;
const HP_BAR_COLOR_DEAD = 0xff0000;

/** Single remote player visual representation */
export class RemotePlayerMesh {
  group: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  hpBar: THREE.Mesh;
  nameTag: THREE.Sprite;

  constructor(name: string, scene: THREE.Scene) {
    this.group = new THREE.Group();
    this.group.name = `remote-${name}`;

    // Body (capsule-like) — positioned at feet, body extends upward
    const bodyGeo = new THREE.CapsuleGeometry(0.35, 0.8, 4, 8);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4a90d9 });
    this.body = new THREE.Mesh(bodyGeo, bodyMat);
    this.body.position.y = 0.8; // capsule center at ~0.8m (feet at 0, head at ~1.6)
    this.group.add(this.body);

    // Head
    const headGeo = new THREE.SphereGeometry(0.2, 8, 6);
    const headMat = new THREE.MeshLambertMaterial({ color: 0xffcc88 });
    this.head = new THREE.Mesh(headGeo, headMat);
    this.head.position.y = 1.55; // top of head at ~1.75m
    this.group.add(this.head);

    // HP bar
    const hpGeo = new THREE.PlaneGeometry(1, 0.08);
    const hpMat = new THREE.MeshBasicMaterial({ color: HP_BAR_COLOR_ALIVE, side: THREE.DoubleSide });
    this.hpBar = new THREE.Mesh(hpGeo, hpMat);
    this.hpBar.position.y = 2.05;
    this.group.add(this.hpBar);

    // Name sprite
    this.nameTag = this.createNameSprite(name);
    this.nameTag.position.y = 2.3;
    this.group.add(this.nameTag);

    scene.add(this.group);
  }

  private createNameSprite(name: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.width = 512;
    canvas.height = 64;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 36px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(name, 256, 42);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    const sprite = new THREE.Sprite(mat);
    // Scale to match canvas aspect ratio (width 1 unit = ~1m)
    sprite.scale.set(2, 2 / 8, 1); // 512/64 = 8:1 aspect
    return sprite;
  }

  update(entity: EntityState, camera: THREE.Camera): void {
    // Position at FEET (entity.pos.y is eye height ~1.6, so feet are at pos.y - 1.6)
    const feetY = Math.max(0, entity.pos.y - 1.6);
    this.group.position.set(entity.pos.x, feetY, entity.pos.z);
    this.group.rotation.y = entity.yaw;

    // Face HP bar and name toward camera
    this.hpBar.lookAt(camera.position);
    this.nameTag.lookAt(camera.position);

    // HP bar color and width
    const hpRatio = Math.max(0, entity.hp / 100);
    this.hpBar.scale.x = hpRatio * (this.hpBar.scale.x || 1);
    (this.hpBar.material as THREE.MeshBasicMaterial).color.setHex(
      entity.alive ? HP_BAR_COLOR_ALIVE : HP_BAR_COLOR_DEAD
    );

    // Visibility
    this.group.visible = entity.alive;
  }

  dispose(scene: THREE.Scene): void {
    this.body.geometry.dispose();
    (this.body.material as THREE.Material).dispose();
    this.head.geometry.dispose();
    (this.head.material as THREE.Material).dispose();
    this.hpBar.geometry.dispose();
    (this.hpBar.material as THREE.Material).dispose();
    if (this.nameTag.material.map) (this.nameTag.material.map as THREE.Texture).dispose();
    (this.nameTag.material as THREE.Material).dispose();
    scene.remove(this.group);
  }
}

/** Manager for all remote player meshes */
export class RemotePlayerManager {
  private meshes = new Map<number, RemotePlayerMesh>();

  constructor(private scene: THREE.Scene) {}

  /** Update meshes from entity state */
  update(entities: EntityState[], camera: THREE.Camera): void {
    const newIds = new Set<number>();
    for (const e of entities) {
      if (e.isMe) continue; // skip local player
      newIds.add(e.id);
      let mesh = this.meshes.get(e.id);
      if (!mesh) {
        mesh = new RemotePlayerMesh(e.name, this.scene);
        this.meshes.set(e.id, mesh);
      }
      mesh.update(e, camera);
    }
    // Remove disposed meshes
    for (const [id] of this.meshes) {
      if (!newIds.has(id)) {
        this.meshes.get(id)!.dispose(this.scene);
        this.meshes.delete(id);
      }
    }
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) {
      mesh.dispose(this.scene);
    }
    this.meshes.clear();
  }
}

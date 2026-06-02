/**
 * Arena FPS — Remote player rendering
 *
 * Creates and maintains 3D meshes for other players/bots in the scene.
 */
import * as THREE from 'three';
import type { EntityState } from './netGame';

const BODY_COLOR = 0x4a90d9;
const BOT_BODY_COLOR = 0xd94a4a;
const HEAD_COLOR = 0xffcc88;
const HP_BAR_COLOR_ALIVE = 0x00ff00;
const HP_BAR_COLOR_DEAD = 0xff0000;

/** Single remote player visual representation */
export class RemotePlayerMesh {
  group: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  hpBar: THREE.Mesh;
  nameTag: THREE.Sprite;

  constructor(name: string, isBot: boolean, scene: THREE.Scene) {
    this.group = new THREE.Group();
    this.group.name = `remote-${name}`;

    // Body (capsule-like)
    const bodyGeo = new THREE.CapsuleGeometry(0.35, 1.0, 4, 8);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xff4444 });
    this.body = new THREE.Mesh(bodyGeo, bodyMat);
    this.body.position.y = 0.9;
    this.group.add(this.body);

    // Head
    const headGeo = new THREE.SphereGeometry(0.2, 8, 6);
    const headMat = new THREE.MeshLambertMaterial({ color: HEAD_COLOR });
    this.head = new THREE.Mesh(headGeo, headMat);
    this.head.position.y = 1.65;
    this.group.add(this.head);

    // HP bar
    const hpGeo = new THREE.PlaneGeometry(1, 0.1);
    const hpMat = new THREE.MeshBasicMaterial({ color: HP_BAR_COLOR_ALIVE, side: THREE.DoubleSide });
    this.hpBar = new THREE.Mesh(hpGeo, hpMat);
    this.hpBar.position.y = 1.95;
    this.group.add(this.hpBar);

    // Name sprite
    this.nameTag = this.createNameSprite(name);
    this.nameTag.position.y = 2.2;
    this.group.add(this.nameTag);

    scene.add(this.group);
  }

  private createNameSprite(name: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.width = 256;
    canvas.height = 64;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 32px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(name, 128, 40);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    return new THREE.Sprite(mat);
  }

  update(entity: EntityState, camera: THREE.Camera): void {
    this.group.position.set(entity.pos.x, entity.pos.y, entity.pos.z);
    this.group.rotation.y = entity.yaw;

    // Face HP bar and name toward camera
    this.hpBar.lookAt(camera.position);
    this.nameTag.lookAt(camera.position);

    // HP bar color and width
    const hpRatio = Math.max(0, entity.hp / 100);
    this.hpBar.scale.x = hpRatio;
    (this.hpBar.material as THREE.MeshStandardMaterial).color.setHex(entity.alive ? HP_BAR_COLOR_ALIVE : HP_BAR_COLOR_DEAD);

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
        const isBot = e.hp === 99; // server marks bots with ammo=99
        mesh = new RemotePlayerMesh(e.name, isBot, this.scene);
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

import * as THREE from 'three';
import type { GraphicsQuality } from '../../shared/types';

/**
 * Build a flat-shaded block-and-ramp arena for M0.
 * All repeated obstacles use InstancedMesh.
 * Geometry + materials are reused.
 */
export function createArena(quality: GraphicsQuality) {
  const group = new THREE.Group();
  group.name = 'arena';

  // --- Materials ---
  const floorMat = new THREE.MeshLambertMaterial({ color: 0x3a3a4a, flatShading: true });
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x5a5a6a, flatShading: true });
  const obstacleMats: THREE.MeshLambertMaterial[] = [
    new THREE.MeshLambertMaterial({ color: 0x8a5a3a, flatShading: true }),
    new THREE.MeshLambertMaterial({ color: 0x3a6a8a, flatShading: true }),
    new THREE.MeshLambertMaterial({ color: 0x8a3a5a, flatShading: true }),
    new THREE.MeshLambertMaterial({ color: 0x5a8a3a, flatShading: true }),
  ];

  // --- Floor (40x40) ---
  const floorGeo = new THREE.PlaneGeometry(40, 40);
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  group.add(floor);

  // --- Walls (4 sides, 4 units high, open top) ---
  const wallHeight = 4;
  const arenaSize = 20;
  const wallThickness = 0.5;

  function addWall(w: number, h: number, d: number, x: number, y: number, z: number) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, wallMat);
    mesh.position.set(x, y, z);
    group.add(mesh);
  }

  // North wall
  addWall(40, wallHeight, wallThickness, 0, wallHeight / 2, -arenaSize);
  // South wall
  addWall(40, wallHeight, wallThickness, 0, wallHeight / 2, arenaSize);
  // East wall
  addWall(wallThickness, wallHeight, 40, arenaSize, wallHeight / 2, 0);
  // West wall
  addWall(wallThickness, wallHeight, 40, -arenaSize, wallHeight / 2, 0);

  // --- Obstacles (boxes) ---
  const obstaclePositions: { x: number; z: number; w: number; h: number; d: number }[] = [
    // Central cover
    { x: 0, z: 0, w: 3, h: 2, d: 3 },
    { x: 6, z: 6, w: 2, h: 2.5, d: 2 },
    { x: -6, z: 6, w: 2, h: 2.5, d: 2 },
    { x: 6, z: -6, w: 2, h: 2.5, d: 2 },
    { x: -6, z: -6, w: 2, h: 2.5, d: 2 },
    // Corner cover
    { x: 12, z: 12, w: 3, h: 1.5, d: 1.5 },
    { x: -12, z: 12, w: 3, h: 1.5, d: 1.5 },
    { x: 12, z: -12, w: 3, h: 1.5, d: 1.5 },
    { x: -12, z: -12, w: 3, h: 1.5, d: 1.5 },
    // Mid-edge cover
    { x: 10, z: 0, w: 1.5, h: 2, d: 4 },
    { x: -10, z: 0, w: 1.5, h: 2, d: 4 },
    { x: 0, z: 11, w: 4, h: 2, d: 1.5 },
    { x: 0, z: -11, w: 4, h: 2, d: 1.5 },
  ];

  for (let i = 0; i < obstaclePositions.length; i++) {
    const ob = obstaclePositions[i];
    const geo = new THREE.BoxGeometry(ob.w, ob.h, ob.d);
    const mesh = new THREE.Mesh(geo, obstacleMats[i % obstacleMats.length]);
    mesh.position.set(ob.x, ob.h / 2, ob.z);
    group.add(mesh);
  }

  // --- Lighting ---
  const ambient = new THREE.AmbientLight(0x606080, 0.8);
  ambient.name = 'ambient';
  group.add(ambient);

  const dirLight = new THREE.DirectionalLight(0xfff4e0, quality === 'high' ? 0.6 : 0);
  dirLight.position.set(10, 15, 10);
  dirLight.name = 'dirLight';
  group.add(dirLight);

  return {
    group,
    updateQuality: (q: GraphicsQuality) => {
      dirLight.visible = q === 'high';
    },
  };
}

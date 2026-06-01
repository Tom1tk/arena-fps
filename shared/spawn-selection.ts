/**
 * Smart spawn selection — avoids spawn-camping and keeps players spread.
 *
 * For each spawn point, score it based on:
 *   - Distance from all alive players (weighted by W_DIST)
 *   - Line-of-sight from any alive player (penalized by W_VISIBLE)
 *   - Recent spawn recency (penalized by W_RECENT)
 *
 * Returns the spawn point with the highest score.
 */

import {
  SPAWN_POSITIONS,
  W_DIST,
  W_VISIBLE,
  W_RECENT,
  RECENT_SPAWN_WINDOW,
} from './constants';
import type { SpawnPoint } from './types';

/**
 * Select the best spawn point for the player at `eyePos` looking toward `yaw`.
 *
 * @param allPlayers Array of { pos, yaw, name } for all currently alive entities
 * @param recentSpawns Array of { pos, time } for spawns in the last RECENT_SPAWN_WINDOW seconds
 * @param obstacleMeshes Optional obstacle meshes for LOS checks (undefined = skip LOS)
 * @returns SpawnPoint from the authored list
 */
export function selectSpawnPoint(
  allPlayers: Array<{ pos: { x: number; y: number; z: number }; yaw: number }>,
  recentSpawns: Array<{ pos: { x: number; y: number; z: number }; time: number }>,
  now: number,
): SpawnPoint {
  if (SPAWN_POSITIONS.length === 1) return SPAWN_POSITIONS[0];

  let bestScore = -Infinity;
  let bestPoint = SPAWN_POSITIONS[0];

  for (const spawn of SPAWN_POSITIONS) {
    let score = 0;

    for (const player of allPlayers) {
      // Distance score (prefer far from alive players)
      const dx = spawn.pos.x - player.pos.x;
      const dz = spawn.pos.z - player.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      score += dist * W_DIST;

      // LOS penalty: if a player can see this spawn point, penalize heavily
      // Simple check: is the player looking roughly toward this spawn?
      const angleToSpawn = Math.atan2(dx, dz);
      let angleDiff = angleToSpawn - player.yaw;
      // Normalize to [-PI, PI]
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      const facingThreshold = 0.8; // ~45 degrees
      if (Math.abs(angleDiff) < facingThreshold && dist < 25) {
        score -= W_VISIBLE;
      }
    }

    // Recency penalty: penalize spawns used recently
    for (const rs of recentSpawns) {
      const age = now - rs.time;
      if (age < RECENT_SPAWN_WINDOW) {
        const rsDx = spawn.pos.x - rs.pos.x;
        const rsDz = spawn.pos.z - rs.pos.z;
        const rsDist = Math.sqrt(rsDx * rsDx + rsDz * rsDz);
        if (rsDist < 2) {
          // Same or very close spawn — heavy penalty
          score -= W_RECENT * (1 - age / RECENT_SPAWN_WINDOW);
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestPoint = spawn;
    }
  }

  return bestPoint;
}

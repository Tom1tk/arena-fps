/** Clamp value between min and max */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Linear interpolation */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Smooth step */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Dot product of two 3D vectors */
export function dot(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return ax * bx + ay * by + az * bz;
}

/** Distance squared between two points */
export function distSq(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): number {
  const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
  return dx * dx + dy * dy + dz * dz;
}

/** Degrees to radians */
export function degToRad(d: number): number {
  return d * Math.PI / 180;
}

/** Radians to degrees */
export function radToDeg(r: number): number {
  return r * 180 / Math.PI;
}

import type { Collider } from '../render/scene';

// Grid flow-field pathfinding. Obstacles are static per room, so we rasterize
// them once into a walkability grid; a BFS from the player's cell (recomputed
// a few times per second) gives every enemy a direction for free — perfect for
// hordes. Enemies with clear line of sight steer directly; the field is the
// fallback that routes them around cover.

const DIRS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export class FlowField {
  private w: number;
  private d: number;
  private cell: number;
  private originX: number;
  private originZ: number;
  private walkable!: Uint8Array;
  private dist!: Float32Array;
  private flowX!: Float32Array;
  private flowZ!: Float32Array;
  private queue: Int32Array;

  constructor(worldW: number, worldD: number, cell = 1) {
    this.cell = cell;
    this.w = Math.ceil(worldW / cell);
    this.d = Math.ceil(worldD / cell);
    this.originX = -worldW / 2;
    this.originZ = -worldD / 2;
    this.walkable = new Uint8Array(this.w * this.d);
    this.dist = new Float32Array(this.w * this.d);
    this.flowX = new Float32Array(this.w * this.d);
    this.flowZ = new Float32Array(this.w * this.d);
    this.queue = new Int32Array(this.w * this.d);
  }

  /** rasterize static obstacles (inflated by a typical enemy radius) */
  setObstacles(obstacles: Collider[], inflate = 0.45) {
    this.walkable.fill(1);
    for (const o of obstacles) {
      const r = o.r + inflate;
      const x0 = Math.max(0, Math.floor((o.x - r - this.originX) / this.cell));
      const x1 = Math.min(this.w - 1, Math.ceil((o.x + r - this.originX) / this.cell));
      const z0 = Math.max(0, Math.floor((o.z - r - this.originZ) / this.cell));
      const z1 = Math.min(this.d - 1, Math.ceil((o.z + r - this.originZ) / this.cell));
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const px = this.originX + (cx + 0.5) * this.cell;
          const pz = this.originZ + (cz + 0.5) * this.cell;
          if (Math.hypot(px - o.x, pz - o.z) < r) this.walkable[cz * this.w + cx] = 0;
        }
      }
    }
  }

  private idx(x: number, z: number): number {
    const cx = Math.min(this.w - 1, Math.max(0, Math.floor((x - this.originX) / this.cell)));
    const cz = Math.min(this.d - 1, Math.max(0, Math.floor((z - this.originZ) / this.cell)));
    return cz * this.w + cx;
  }

  /** BFS from the target; flow vectors point down the distance gradient */
  compute(targetX: number, targetZ: number) {
    this.dist.fill(Infinity);
    let head = 0;
    let tail = 0;
    let start = this.idx(targetX, targetZ);
    // if the target cell is unwalkable (player hugging cover), find a nearby walkable one
    if (!this.walkable[start]) {
      const sx = start % this.w;
      const sz = Math.floor(start / this.w);
      outer: for (let ring = 1; ring <= 3; ring++) {
        for (const [dx, dz] of DIRS) {
          const nx = sx + dx * ring;
          const nz = sz + dz * ring;
          if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.d) continue;
          if (this.walkable[nz * this.w + nx]) {
            start = nz * this.w + nx;
            break outer;
          }
        }
      }
    }
    this.dist[start] = 0;
    this.queue[tail++] = start;
    while (head < tail) {
      const cur = this.queue[head++];
      const cx = cur % this.w;
      const cz = Math.floor(cur / this.w);
      const cd = this.dist[cur];
      for (let i = 0; i < 8; i++) {
        const [dx, dz] = DIRS[i];
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.d) continue;
        const ni = nz * this.w + nx;
        if (!this.walkable[ni]) continue;
        // no diagonal corner-cutting
        if (dx !== 0 && dz !== 0) {
          if (!this.walkable[cz * this.w + nx] || !this.walkable[nz * this.w + cx]) continue;
        }
        const step = dx !== 0 && dz !== 0 ? 1.414 : 1;
        if (cd + step < this.dist[ni]) {
          this.dist[ni] = cd + step;
          this.queue[tail++] = ni;
        }
      }
    }
    // flow = direction toward the lowest-distance neighbor
    for (let cz = 0; cz < this.d; cz++) {
      for (let cx = 0; cx < this.w; cx++) {
        const i = cz * this.w + cx;
        if (!this.walkable[i] || !isFinite(this.dist[i])) {
          this.flowX[i] = 0;
          this.flowZ[i] = 0;
          continue;
        }
        let best = this.dist[i];
        let bx = 0;
        let bz = 0;
        for (const [dx, dz] of DIRS) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.d) continue;
          const ni = nz * this.w + nx;
          if (!this.walkable[ni]) continue;
          if (dx !== 0 && dz !== 0 && (!this.walkable[cz * this.w + nx] || !this.walkable[nz * this.w + cx])) continue;
          if (this.dist[ni] < best) {
            best = this.dist[ni];
            bx = dx;
            bz = dz;
          }
        }
        const len = Math.hypot(bx, bz) || 1;
        this.flowX[i] = bx / len;
        this.flowZ[i] = bz / len;
      }
    }
  }

  /** flow direction at a world position (null when no route exists) */
  dirAt(x: number, z: number): { x: number; z: number } | null {
    const i = this.idx(x, z);
    const fx = this.flowX[i];
    const fz = this.flowZ[i];
    if (fx === 0 && fz === 0) return null;
    return { x: fx, z: fz };
  }
}

/** segment-vs-obstacle-circles visibility test */
export function losClear(
  ax: number, az: number, bx: number, bz: number,
  obstacles: Collider[], clearance = 0.4,
): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  for (const o of obstacles) {
    const r = o.r + clearance;
    let t = 0;
    if (lenSq > 0.0001) {
      t = ((o.x - ax) * dx + (o.z - az) * dz) / lenSq;
      t = Math.max(0, Math.min(1, t));
    }
    const px = ax + dx * t;
    const pz = az + dz * t;
    if (Math.hypot(px - o.x, pz - o.z) < r) return false;
  }
  return true;
}

// Texture-synthesis noise toolkit. The standard recipe for natural-looking
// procedural materials:
//  - value noise with quintic fade, summed as FBM (fractal Brownian motion)
//  - domain warping: fbm(p + k·fbm(p)) — organic, non-repeating distortion
//  - Worley (cellular) noise: F2−F1 edge distance → natural crack networks
// All generators return Float32Array fields in [0,1], sampled tileably.

function hash2(seed: number, xi: number, yi: number): number {
  let h = seed ^ (xi * 374761393) ^ (yi * 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** tileable value noise at integer lattice `period` */
function valueNoise(seed: number, x: number, y: number, period: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = fade(xf);
  const v = fade(yf);
  const p = (ix: number, iy: number) => hash2(seed, ((ix % period) + period) % period, ((iy % period) + period) % period);
  const a = p(xi, yi);
  const b = p(xi + 1, yi);
  const c = p(xi, yi + 1);
  const d = p(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** tileable FBM field: `scale` = base lattice cells across the texture */
export function fbmField(size: number, scale: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let amp = 0.5;
      let freq = scale;
      let sum = 0;
      let norm = 0;
      for (let o = 0; o < octaves; o++) {
        sum += amp * valueNoise(seed + o * 101, (x / size) * freq, (y / size) * freq, freq);
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      out[y * size + x] = sum / norm;
    }
  }
  return out;
}

/** domain-warped FBM: fbm(p + k·fbm(p)) — the organic-mottling workhorse */
export function warpedFbmField(size: number, scale: number, octaves: number, seed: number, warp = 0.35): Float32Array {
  // the warp fields MUST use an integer lattice period — a fractional period
  // breaks valueNoise's wrap and every warped texture gets a border seam
  const warpScale = Math.max(2, Math.round(scale * 0.7));
  const wx = fbmField(size, warpScale, 3, seed + 7777);
  const wy = fbmField(size, warpScale, 3, seed + 8888);
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const ox = (wx[i] - 0.5) * warp * size;
      const oy = (wy[i] - 0.5) * warp * size;
      // resample base fbm at warped coordinates (wrap)
      const sx = (((x + ox) % size) + size) % size;
      const sy = (((y + oy) % size) + size) % size;
      let amp = 0.5;
      let freq = scale;
      let sum = 0;
      let norm = 0;
      for (let o = 0; o < octaves; o++) {
        sum += amp * valueNoise(seed + o * 101, (sx / size) * freq, (sy / size) * freq, freq);
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      out[i] = sum / norm;
    }
  }
  return out;
}

/**
 * tileable Worley edge field: 0 at cell borders rising toward cell centres.
 * Thresholding low values yields natural mud-crack / dried-earth networks.
 */
export function worleyEdgeField(size: number, cells: number, seed: number, jitter = 0.85): Float32Array {
  // feature points on a jittered grid
  const px = new Float32Array(cells * cells);
  const py = new Float32Array(cells * cells);
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      px[cy * cells + cx] = (cx + 0.5 + (hash2(seed, cx, cy) - 0.5) * jitter) / cells;
      py[cy * cells + cx] = (cy + 0.5 + (hash2(seed + 1, cx, cy) - 0.5) * jitter) / cells;
    }
  }
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x / size;
      const fy = y / size;
      const cx0 = Math.floor(fx * cells);
      const cy0 = Math.floor(fy * cells);
      let f1 = 9;
      let f2 = 9;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cxi = ((cx0 + ox) % cells + cells) % cells;
          const cyi = ((cy0 + oy) % cells + cells) % cells;
          let dx = px[cyi * cells + cxi] + ox * ((cx0 + ox) < 0 ? -0 : 0) - fx;
          let dy = py[cyi * cells + cxi] - fy;
          // wrap deltas for tiling
          if (dx > 0.5) dx -= 1;
          if (dx < -0.5) dx += 1;
          if (dy > 0.5) dy -= 1;
          if (dy < -0.5) dy += 1;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < f1) {
            f2 = f1;
            f1 = d;
          } else if (d < f2) {
            f2 = d;
          }
        }
      }
      out[y * size + x] = Math.min(1, (f2 - f1) * cells * 1.4);
    }
  }
  return out;
}

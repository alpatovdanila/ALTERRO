import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Shared geometry cache. Enemies, debris, and props are built from a small
// vocabulary of primitive dimensions — caching them means spawns/deaths stop
// allocating and freeing GPU buffers (the main source of mid-fight hitches).
// Dimensions are quantized so rng-sized props hit the cache too.
// Cached geometries are NEVER disposed.

const cache = new Map<string, THREE.BufferGeometry>();

const q = (v: number) => Math.round(v * 20) / 20;

export function boxGeo(w: number, h: number, d: number): THREE.BoxGeometry {
  const key = `b${q(w)},${q(h)},${q(d)}`;
  let g = cache.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(q(w), q(h), q(d));
    cache.set(key, g);
  }
  return g as THREE.BoxGeometry;
}

export function cylGeo(rt: number, rb: number, h: number, segs = 12): THREE.CylinderGeometry {
  const key = `c${q(rt)},${q(rb)},${q(h)},${segs}`;
  let g = cache.get(key);
  if (!g) {
    g = new THREE.CylinderGeometry(q(rt), q(rb), q(h), segs);
    cache.set(key, g);
  }
  return g as THREE.CylinderGeometry;
}

export function sphereGeo(r: number, w = 12, h = 10): THREE.SphereGeometry {
  const key = `s${q(r)},${w},${h}`;
  let g = cache.get(key);
  if (!g) {
    g = new THREE.SphereGeometry(q(r), w, h);
    cache.set(key, g);
  }
  return g as THREE.SphereGeometry;
}

export function torusGeo(r: number, tube: number, rs = 8, ts = 14): THREE.TorusGeometry {
  const key = `t${q(r)},${q(tube)},${rs},${ts}`;
  let g = cache.get(key);
  if (!g) {
    g = new THREE.TorusGeometry(q(r), q(tube), rs, ts);
    cache.set(key, g);
  }
  return g as THREE.TorusGeometry;
}

export function icoGeo(r: number): THREE.BufferGeometry {
  const key = `i${q(r)}`;
  let g = cache.get(key);
  if (!g) {
    // polyhedra come with per-face normals (flat shading). Weld the vertices
    // and recompute so rocks take smooth per-pixel light like everything else.
    g = mergeVertices(new THREE.IcosahedronGeometry(q(r), 1));
    g.computeVertexNormals();
    cache.set(key, g);
  }
  return g;
}

/**
 * craggy rock variants — icosahedra with seeded per-vertex displacement, so
 * boulders read as broken stone, not spheres. 6 cached shapes, smooth normals.
 */
const rockCache = new Map<number, THREE.BufferGeometry>();
export function rockGeo(variant: number): THREE.BufferGeometry {
  const v = ((variant % 6) + 6) % 6;
  let g = rockCache.get(v);
  if (!g) {
    // SMOOTH low-frequency lumps, not per-vertex jitter: displacement is a
    // continuous function of position, so the surface stays coherent and the
    // silhouette reads as weathered stone
    g = mergeVertices(new THREE.IcosahedronGeometry(1, 2));
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    let s = 1013 + v * 7919;
    const rand = () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
    const f = [2.1 + rand() * 1.4, 2.9 + rand() * 1.6, 4.1 + rand() * 1.8];
    const ph = [rand() * 6.28, rand() * 6.28, rand() * 6.28];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const n =
        Math.sin(x * f[0] + ph[0]) * Math.sin(z * f[0] * 0.8 + ph[1]) * 0.21 +
        Math.sin(y * f[1] + ph[2]) * Math.sin(x * f[1] * 0.7 + ph[0]) * 0.13 +
        Math.sin(z * f[2] + ph[1]) * Math.sin(y * f[2] * 0.9 + ph[2]) * 0.08;
      const k = 1 + n;
      pos.setXYZ(i, x * k, y * k * 0.78, z * k); // squat, ground-hugging
    }
    g.computeVertexNormals();
    rockCache.set(v, g);
  }
  return g;
}

export function circleGeo(r: number, segs = 12): THREE.CircleGeometry {
  const key = `o${q(r)},${segs}`;
  let g = cache.get(key);
  if (!g) {
    g = new THREE.CircleGeometry(q(r), segs);
    cache.set(key, g);
  }
  return g as THREE.CircleGeometry;
}

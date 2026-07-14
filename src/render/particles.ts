import * as THREE from 'three';
import { FX_LAYER } from './scene';

// Billboarded particle pools. The camera never rotates (fixed-angle 2.5D), so
// billboards are just planes locked to the camera quaternion — no per-frame
// re-orientation math. Two pools: additive (sparks / fire / electricity /
// embers) and alpha-blended (smoke, blood mist).

const ADD_MAX = 1024;
const SMOKE_MAX = 320;

interface P {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size0: number;
  size1: number;
  c0: THREE.Color;
  c1: THREE.Color;
  gravity: number;
  drag: number;
  /** electricity teleports randomly instead of flying */
  jitter: number;
  /** stretch along velocity (sparks) */
  stretch: boolean;
  spin: number;
  rot: number;
  /** atlas flipbook: first cell + frame count, advanced over the lifetime */
  frame0: number;
  frameCount: number;
}

function makeP(): P {
  return {
    active: false,
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    life: 0,
    maxLife: 1,
    size0: 0.1,
    size1: 0.1,
    c0: new THREE.Color(),
    c1: new THREE.Color(),
    gravity: 0,
    drag: 0,
    jitter: 0,
    stretch: false,
    spin: 0,
    rot: 0,
    frame0: 0,
    frameCount: 1,
  };
}

// ---------------------------------------------------------------- atlas
// All particle art comes from the sprite pack in public/particles — frame
// sequences packed into ONE 256×256 atlas (8×8 grid of 32px cells) at boot.
// Each particle carries a frame range and flips through it over its life.

const CELL = 32;
const GRID = 8;
const ATLAS = CELL * GRID;

interface Anim {
  start: number;
  count: number;
}

/** cell ranges, filled in load order below */
export const ANIMS: Record<string, Anim> = {};

const atlasCanvas = document.createElement('canvas');
atlasCanvas.width = ATLAS;
atlasCanvas.height = ATLAS;
const atlasTex = new THREE.CanvasTexture(atlasCanvas);
atlasTex.colorSpace = THREE.SRGBColorSpace;
atlasTex.magFilter = THREE.NearestFilter; // crisp pixel-art sprites
atlasTex.minFilter = THREE.NearestFilter;
atlasTex.generateMipmaps = false;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/** resolves when the sprite atlas is assembled (boot awaits this) */
export const particlesReady = (async () => {
  const ctx = atlasCanvas.getContext('2d')!;
  const seq = (base: string, n: number) =>
    Array.from({ length: n }, (_, i) => `particles/${base}_${i}.png`);
  const families: [string, string[]][] = [
    ['explosion', seq('explosion', 16)],
    ['smoke', seq('big_smoke', 12)],
    ['effect', seq('effect', 8)],
    ['generic', seq('generic', 8)],
    ['splash', seq('splash', 4)],
    ['firefly', ['particles/firefly.png']],
    ['crit', ['particles/critical_hit.png']],
  ];
  let cell = 0;
  const put = (img: CanvasImageSource, i: number) => {
    ctx.drawImage(img, (i % GRID) * CELL, Math.floor(i / GRID) * CELL, CELL, CELL);
  };
  for (const [name, urls] of families) {
    const imgs = await Promise.all(urls.map(loadImage));
    ANIMS[name] = { start: cell, count: imgs.length };
    for (const img of imgs) put(img, cell++);
  }
  // flame.png is a 32×192 vertical strip — slice its 6 frames
  const flame = await loadImage('particles/flame.png');
  const flameFrames = Math.floor(flame.height / 32);
  ANIMS.flame = { start: cell, count: flameFrames };
  for (let i = 0; i < flameFrames; i++) {
    ctx.drawImage(flame, 0, i * 32, 32, 32, (cell % GRID) * CELL, Math.floor(cell / GRID) * CELL, CELL, CELL);
    cell++;
  }
  atlasTex.needsUpdate = true;
})();

/** uvRect (x, y, w, h) for an atlas cell — canvas rows top-down, uv bottom-up */
function cellRect(index: number): [number, number, number, number] {
  const col = index % GRID;
  const row = Math.floor(index / GRID);
  return [col / GRID, 1 - (row + 1) / GRID, 1 / GRID, 1 / GRID];
}

const tmpMat = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const tmpC = new THREE.Color();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

class Pool {
  mesh: THREE.InstancedMesh;
  ps: P[] = [];
  cursor = 0;
  camQuat = new THREE.Quaternion();
  camRight = new THREE.Vector3(1, 0, 0);
  camUp = new THREE.Vector3(0, 1, 0);

  private uvAttr: THREE.InstancedBufferAttribute;

  constructor(scene: THREE.Scene, max: number, blending: THREE.Blending, opacity: number) {
    const mat = new THREE.MeshBasicMaterial({
      map: atlasTex,
      transparent: true,
      opacity,
      blending,
      depthWrite: false,
      // scene fog must NOT tint billboards — it darkens the quads into
      // visible rectangles ("dark edge" artifacts)
      fog: false,
    });
    // per-instance atlas rect: vMapUv is remapped into the particle's cell
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 uvRect;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvMapUv = vMapUv * uvRect.zw + uvRect.xy;');
    };
    const geo = new THREE.PlaneGeometry(1, 1);
    this.uvAttr = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.uvAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('uvRect', this.uvAttr);
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    // FX layer: drawn after the AO composite so GTAO can't darken sprite edges
    this.mesh.layers.set(FX_LAYER);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    scene.add(this.mesh);
    for (let i = 0; i < max; i++) {
      this.ps.push(makeP());
      this.write(i);
    }
  }

  setCamera(cam: THREE.Camera) {
    this.camQuat.copy(cam.quaternion);
    this.camRight.set(1, 0, 0).applyQuaternion(this.camQuat);
    this.camUp.set(0, 1, 0).applyQuaternion(this.camQuat);
  }

  write(i: number) {
    const p = this.ps[i];
    if (!p.active) {
      tmpMat.compose(p.pos, this.camQuat, tmpS.set(0, 0, 0));
      this.mesh.setMatrixAt(i, tmpMat);
      return;
    }
    const k = 1 - p.life / p.maxLife;
    // flipbook: advance through the frame range over the lifetime
    const frame = p.frame0 + Math.min(p.frameCount - 1, Math.floor(k * p.frameCount));
    const rect = cellRect(frame);
    this.uvAttr.setXYZW(i, rect[0], rect[1], rect[2], rect[3]);
    const size = p.size0 + (p.size1 - p.size0) * k;
    let sx = size;
    let rotQ = this.camQuat;
    if (p.stretch && p.vel.lengthSq() > 0.5) {
      const vr = p.vel.dot(this.camRight);
      const vu = p.vel.dot(this.camUp);
      const ang = Math.atan2(vu, vr);
      tmpQ2.setFromAxisAngle(Z_AXIS, ang);
      tmpQ.copy(this.camQuat).multiply(tmpQ2);
      rotQ = tmpQ;
      sx = size * (1.5 + Math.min(3, p.vel.length() * 0.25));
    } else if (p.spin !== 0) {
      tmpQ2.setFromAxisAngle(Z_AXIS, p.rot);
      tmpQ.copy(this.camQuat).multiply(tmpQ2);
      rotQ = tmpQ;
    }
    // keep the whole billboard above the floor — a sprite whose lower half
    // dips into the ground gets depth-clipped into a hard "cut" edge
    const y = Math.max(p.pos.y, size * 0.55 + 0.03);
    tmpMat.compose(tmpV.set(p.pos.x, y, p.pos.z), rotQ, tmpS.set(sx, size, 1));
    this.mesh.setMatrixAt(i, tmpMat);
    tmpC.copy(p.c0).lerp(p.c1, k);
    this.mesh.setColorAt(i, tmpC);
  }

  spawn(anim: string): P {
    const p = this.ps[this.cursor];
    this.cursor = (this.cursor + 1) % this.ps.length;
    p.active = true;
    p.jitter = 0;
    p.stretch = false;
    p.spin = 0;
    p.rot = 0;
    p.gravity = 0;
    p.drag = 0;
    const a = ANIMS[anim] ?? { start: 0, count: 1 };
    p.frame0 = a.start;
    p.frameCount = a.count;
    return p;
  }

  update(dt: number, rand: () => number) {
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i];
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        this.write(i);
        continue;
      }
      if (p.jitter > 0) {
        p.pos.x += (rand() - 0.5) * p.jitter;
        p.pos.y += (rand() - 0.5) * p.jitter * 0.6;
        p.pos.z += (rand() - 0.5) * p.jitter;
      }
      p.vel.y += p.gravity * dt;
      if (p.drag > 0) {
        const d = Math.exp(-p.drag * dt);
        p.vel.multiplyScalar(d);
      }
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < 0.03) {
        p.pos.y = 0.03;
        p.vel.y = Math.abs(p.vel.y) * 0.3;
      }
      p.rot += p.spin * dt;
      this.write(i);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.uvAttr.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

export class Particles {
  private add: Pool;
  private smoke: Pool;
  private rand: () => number;

  constructor(scene: THREE.Scene, rand: () => number) {
    this.rand = rand;
    // both pools draw from the shared sprite atlas — pack art only
    this.add = new Pool(scene, ADD_MAX, THREE.AdditiveBlending, 1);
    this.smoke = new Pool(scene, SMOKE_MAX, THREE.NormalBlending, 0.34);
  }

  setCamera(cam: THREE.Camera) {
    this.add.setCamera(cam);
    this.smoke.setCamera(cam);
  }

  /** hot metal sparks — muzzle flash, ricochets off steel */
  sparks(pos: THREE.Vector3, n: number, dir?: THREE.Vector3, spread = 1) {
    for (let i = 0; i < n; i++) {
      const p = this.add.spawn('firefly');
      p.pos.copy(pos);
      const a = this.rand() * Math.PI * 2;
      const up = 1 + this.rand() * 3;
      p.vel.set(Math.cos(a) * spread * (1 + this.rand() * 3), up, Math.sin(a) * spread * (1 + this.rand() * 3));
      if (dir) p.vel.addScaledVector(dir, 3 + this.rand() * 4);
      p.maxLife = p.life = 0.25 + this.rand() * 0.3;
      p.size0 = 0.06 + this.rand() * 0.05;
      p.size1 = 0.012;
      p.c0.setHSL(0.09, 0.9, 0.75);
      p.c1.setHSL(0.02, 0.9, 0.3);
      p.gravity = -22;
      p.stretch = true;
    }
  }

  /** slow gray smoke — muzzle wisps, exhaust stacks, aftermath */
  puff(pos: THREE.Vector3, n: number, opts: { size?: number; rise?: number; dark?: boolean; life?: number } = {}) {
    for (let i = 0; i < n; i++) {
      const p = this.smoke.spawn('smoke');
      p.pos.set(pos.x + (this.rand() - 0.5) * 0.2, pos.y, pos.z + (this.rand() - 0.5) * 0.2);
      p.vel.set((this.rand() - 0.5) * 0.6, (opts.rise ?? 1) * (0.7 + this.rand() * 0.7), (this.rand() - 0.5) * 0.6);
      p.maxLife = p.life = (opts.life ?? 1.2) * (0.7 + this.rand() * 0.6);
      const s = opts.size ?? 1;
      p.size0 = 0.3 * s;
      p.size1 = (1.3 + this.rand() * 0.8) * s;
      const l = opts.dark ? 0.08 : 0.22;
      p.c0.setHSL(0.07, 0.03, l + this.rand() * 0.05);
      p.c1.setHSL(0.07, 0.02, l * 0.6);
      p.drag = 1.2;
      p.spin = (this.rand() - 0.5) * 2;
    }
  }

  /** blood mist at the wound */
  mist(pos: THREE.Vector3, n: number) {
    for (let i = 0; i < n; i++) {
      const p = this.smoke.spawn('smoke');
      p.pos.copy(pos);
      const a = this.rand() * Math.PI * 2;
      p.vel.set(Math.cos(a) * (0.5 + this.rand()), 0.4 + this.rand() * 0.8, Math.sin(a) * (0.5 + this.rand()));
      p.maxLife = p.life = 0.5 + this.rand() * 0.4;
      p.size0 = 0.2;
      p.size1 = 0.6 + this.rand() * 0.3;
      p.c0.setHSL(0.99, 0.7, 0.16);
      p.c1.setHSL(0.99, 0.6, 0.05);
      p.drag = 2;
    }
  }

  /** licking flames — burning enemies, pyre ground, wreck fires.
   * THICK and crisp: half again as many tongues, denser bodies, a fast rise,
   * and a flicker jitter so the column boils instead of drifting */
  fire(pos: THREE.Vector3, n: number, size = 1) {
    const count = Math.ceil(n * 1.5);
    for (let i = 0; i < count; i++) {
      const p = this.add.spawn('flame'); // the pack's animated flame strip
      p.pos.set(pos.x + (this.rand() - 0.5) * 0.4 * size, pos.y, pos.z + (this.rand() - 0.5) * 0.4 * size);
      p.vel.set((this.rand() - 0.5) * 0.5, 1.9 + this.rand() * 1.5, (this.rand() - 0.5) * 0.5);
      p.maxLife = p.life = 0.32 + this.rand() * 0.32;
      p.size0 = (0.3 + this.rand() * 0.22) * size;
      p.size1 = 0.12 * size;
      p.c0.setHSL(0.09, 0.7, 0.72); // the sprite carries the fire colors
      p.c1.setHSL(0.02, 0.6, 0.3);
      p.drag = 1;
      p.jitter = 0.04; // the boil
    }
  }

  /** one-shot detonation flipbook — barrels, orbital strikes, big deaths */
  explosion(pos: THREE.Vector3, size = 1) {
    const p = this.add.spawn('explosion');
    p.pos.set(pos.x, Math.max(pos.y, 1.0 * size), pos.z);
    p.vel.set(0, 0.4, 0);
    p.maxLife = p.life = 0.55;
    p.size0 = 2.2 * size;
    p.size1 = 2.9 * size;
    p.c0.setRGB(1, 1, 1);
    p.c1.setRGB(1, 0.85, 0.7);
    p.spin = (this.rand() - 0.5) * 0.8;
  }

  /** crackling electricity — shocker channels, relic at full charge, zap hits */
  electric(pos: THREE.Vector3, n: number, color = 0x9adfff) {
    for (let i = 0; i < n; i++) {
      const p = this.add.spawn('effect');
      p.pos.set(pos.x + (this.rand() - 0.5) * 0.3, pos.y + (this.rand() - 0.5) * 0.3, pos.z + (this.rand() - 0.5) * 0.3);
      p.vel.set(0, 0, 0);
      p.maxLife = p.life = 0.1 + this.rand() * 0.15;
      p.size0 = 0.09 + this.rand() * 0.08;
      p.size1 = 0.02;
      p.c0.setHex(color);
      p.c1.setHex(0xffffff);
      p.jitter = 0.35;
    }
  }

  /**
   * embers from some far-off fire drifting lazily across the room at camera
   * height — loose cluster, slow, long-lived
   */
  streak(pos: THREE.Vector3, dir: THREE.Vector3, n = 8) {
    for (let i = 0; i < n; i++) {
      const p = this.add.spawn('firefly');
      p.pos.set(
        pos.x + (this.rand() - 0.5) * 2.6,
        pos.y + (this.rand() - 0.5) * 1.4,
        pos.z + (this.rand() - 0.5) * 2.2,
      );
      p.vel.copy(dir).multiplyScalar(2.0 + this.rand() * 1.6);
      p.vel.y += (this.rand() - 0.3) * 0.4; // gentle lift and fall
      p.maxLife = p.life = 2.8 + this.rand() * 2.2;
      p.size0 = 0.055 + this.rand() * 0.035;
      p.size1 = 0.015;
      p.c0.setHSL(0.08, 0.95, 0.62);
      p.c1.setHSL(0.02, 0.9, 0.2);
      p.gravity = -0.15;
      p.drag = 0.05;
      p.jitter = 0.02; // faint flutter
    }
  }

  /** drifting embers for mood */
  ember(pos: THREE.Vector3, n: number) {
    for (let i = 0; i < n; i++) {
      const p = this.add.spawn('firefly');
      p.pos.copy(pos);
      p.vel.set((this.rand() - 0.5) * 0.8, 0.8 + this.rand(), (this.rand() - 0.5) * 0.8);
      p.maxLife = p.life = 1 + this.rand() * 1.4;
      p.size0 = 0.045;
      p.size1 = 0.012;
      p.c0.setHSL(0.07, 1, 0.55);
      p.c1.setHSL(0.02, 1, 0.2);
      p.drag = 0.6;
    }
  }

  update(dt: number) {
    this.add.update(dt, this.rand);
    this.smoke.update(dt, this.rand);
  }
}

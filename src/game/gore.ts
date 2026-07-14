import * as THREE from 'three';
import { spriteTex } from '../render/textures';

// Violence with weight (DESIGN.md pillar 2, §6.2, §11).
// Gibs: one InstancedMesh + a lightweight impulse tick (gravity, bounce, settle).
// Blood: one InstancedMesh of floor decals that pool/spread over ~2s and persist
// for the whole room. Both are budget-capped; oldest decals get recycled.

const MAX_GIBS = 1024;
const MAX_DECALS = 1400;
const MAX_DEBRIS = 48;

// splat alpha = a smoke sprite from the pack, linearly upscaled: an irregular
// organic blob, endlessly varied by per-instance rotation/stretch
function splatterTexture(): THREE.Texture {
  return spriteTex('big_smoke_2');
}

interface Gib {
  active: boolean;
  settled: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  angVel: THREE.Vector3;
  scale: number;
  life: number;
  maxLife: number;
  meat: boolean;
  bounced: boolean;
}

interface Decal {
  active: boolean;
  x: number;
  z: number;
  /** height — used by wall decals */
  y: number;
  rotY: number;
  scale: number;
  targetScale: number;
  /** >1 stretches the decal along rotY — directional sprays */
  aspect: number;
  /** 0 = floor; 1..4 = arena wall; 5 = free vertical surface (prop flank) */
  wall: number;
  /** wall 5 only: yaw of the surface normal in the ground plane */
  nAng: number;
  /** oil renders in the glossy pool; blood/scorch dry matte */
  oil: boolean;
}

// base orientations mapping the flat decal (+Y normal) onto each wall's
// inward face; spin composes around the surface normal
const WALL_ALIGN = [
  new THREE.Quaternion(), // floor (identity — geometry is already flat)
  new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)),
  new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0)),
  new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)),
  new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1)),
];

/** severed body parts — real meshes torn off the rigs, tumbling with physics */
interface Debris {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
  t: number;
  settled: boolean;
  bounced: boolean;
}

const tmpMat = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpQuat2 = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpVec = new THREE.Vector3();
const tmpColor = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

export class Gore {
  private gibMesh: THREE.InstancedMesh;
  private gibs: Gib[] = [];
  private decalMesh: THREE.InstancedMesh;
  private oilMesh: THREE.InstancedMesh;
  private decals: Decal[] = [];
  private debris: Debris[] = [];
  private decalCursor = 0;
  private gibCursor = 0;
  private gibsDirty = true;
  private decalsDirty = true;
  private scene: THREE.Scene;
  private rand: () => number;

  constructor(scene: THREE.Scene, rand: () => number = Math.random) {
    this.scene = scene;
    this.rand = rand;
    // finer meat — smaller chunks, more of them (matte: gore isn't lacquered)
    const gibGeo = new THREE.BoxGeometry(0.085, 0.065, 0.075);
    const gibMat = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0.05 });
    this.gibMesh = new THREE.InstancedMesh(gibGeo, gibMat, MAX_GIBS);
    this.gibMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.gibMesh.castShadow = true;
    this.gibMesh.frustumCulled = false;
    scene.add(this.gibMesh);

    // organic splatter shape instead of a disc. Two pools: blood and scorch
    // dry MATTE like everything else on this ship; machine oil alone keeps a
    // greasy hydraulic sheen.
    const decalGeo = new THREE.PlaneGeometry(1.35, 1.35);
    decalGeo.rotateX(-Math.PI / 2);
    const splatAlpha = splatterTexture();
    // Lambert, not Standard: dried blood is pure matte — no GGX, no IBL, no
    // specular work on hundreds of full-screen-floor quads
    const decalMat = new THREE.MeshLambertMaterial({
      transparent: true,
      alphaMap: splatAlpha,
      opacity: 0.94,
      depthWrite: false, // painter's order decides layering, never z-fights
    });
    this.decalMesh = new THREE.InstancedMesh(decalGeo, decalMat, MAX_DECALS);
    const oilMat = new THREE.MeshStandardMaterial({
      roughness: 0.12, // slick film — catches the practicals
      metalness: 0.3,
      transparent: true,
      alphaMap: splatAlpha,
      opacity: 0.94,
      depthWrite: false,
    });
    this.oilMesh = new THREE.InstancedMesh(decalGeo, oilMat, MAX_DECALS);
    // oil is a hazard (it burns) — it must ALWAYS read on top of blood
    this.decalMesh.renderOrder = 1;
    this.oilMesh.renderOrder = 2;
    for (const m of [this.decalMesh, this.oilMesh]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.receiveShadow = true;
      m.frustumCulled = false;
      scene.add(m);
    }

    for (let i = 0; i < MAX_GIBS; i++) {
      this.gibs.push({
        active: false,
        settled: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        rot: new THREE.Euler(),
        angVel: new THREE.Vector3(),
        scale: 1,
        life: 0,
        maxLife: 6,
        meat: false,
        bounced: false,
      });
      this.writeGib(i);
    }
    for (let i = 0; i < MAX_DECALS; i++) {
      this.decals.push({ active: false, x: 0, z: 0, y: 0, rotY: 0, scale: 0, targetScale: 0, aspect: 1, wall: 0, nAng: 0, oil: false });
      this.writeDecal(i);
    }
  }

  private writeGib(i: number) {
    const g = this.gibs[i];
    const s = g.active ? g.scale : 0;
    tmpQuat.setFromEuler(g.rot);
    tmpMat.compose(g.pos, tmpQuat, tmpScale.set(s, s, s));
    this.gibMesh.setMatrixAt(i, tmpMat);
  }

  private writeDecal(i: number) {
    const d = this.decals[i];
    const s = d.active ? d.scale : 0;
    // spin around the surface normal, then align onto floor, wall, or prop flank
    tmpQuat.setFromEuler(new THREE.Euler(0, d.rotY, 0));
    if (d.wall === 5) {
      tmpQuat.premultiply(tmpQuat2.setFromUnitVectors(UP, tmpVec.set(Math.sin(d.nAng), 0, Math.cos(d.nAng))));
    } else {
      tmpQuat.premultiply(WALL_ALIGN[d.wall]);
    }
    // tiny per-index offset keeps overlapping splats off the host surface
    const lift = 0.013 + i * 0.00004;
    let px = d.x;
    let py = d.y;
    let pz = d.z;
    if (d.wall === 0) py = lift;
    else if (d.wall === 1) px = d.x + lift;
    else if (d.wall === 2) px = d.x - lift;
    else if (d.wall === 3) pz = d.z + lift;
    else if (d.wall === 4) pz = d.z - lift;
    else {
      px = d.x + Math.sin(d.nAng) * lift;
      pz = d.z + Math.cos(d.nAng) * lift;
    }
    tmpMat.compose(
      new THREE.Vector3(px, py, pz),
      tmpQuat,
      tmpScale.set(s * d.aspect, 1, s),
    );
    // a slot lives in exactly one pool; the other renders it at zero scale
    (d.oil ? this.oilMesh : this.decalMesh).setMatrixAt(i, tmpMat);
    tmpMat.makeScale(0, 0, 0);
    (d.oil ? this.decalMesh : this.oilMesh).setMatrixAt(i, tmpMat);
  }

  /** blood/oil plastered onto a wall face (1=west 2=east 3=north 4=south) */
  wallSplat(x: number, y: number, z: number, wall: number, rand: () => number, count = 2, sizeMult = 1, oil = false) {
    for (let n = 0; n < count; n++) {
      const i = this.decalCursor;
      this.decalCursor = (this.decalCursor + 1) % MAX_DECALS;
      const d = this.decals[i];
      d.active = true;
      d.oil = oil;
      d.wall = wall;
      d.x = x;
      d.z = z;
      d.y = Math.max(0.25, y + (rand() - 0.5) * 0.8);
      if (wall <= 2) d.z = z + (rand() - 0.5) * 1.2;
      else d.x = x + (rand() - 0.5) * 1.2;
      d.rotY = rand() * Math.PI * 2;
      d.scale = 0.15;
      d.targetScale = (0.6 + rand() * 1.0) * sizeMult;
      d.aspect = 1;
      if (oil) tmpColor.setHSL(0.6, 0.12, 0.03 + rand() * 0.02);
      else tmpColor.setHSL(0.995, 0.8, 0.055 + rand() * 0.045);
      (d.oil ? this.oilMesh : this.decalMesh).setColorAt(i, tmpColor);
    }
    if (this.decalMesh.instanceColor) this.decalMesh.instanceColor.needsUpdate = true;
    if (this.oilMesh.instanceColor) this.oilMesh.instanceColor.needsUpdate = true;
    this.decalsDirty = true;
  }

  /** blood (or oil) splash on the floor — pools and spreads over ~2s */
  splat(x: number, z: number, rand: () => number, count = 3, sizeMult = 1, oil = false) {
    for (let n = 0; n < count; n++) {
      const i = this.decalCursor;
      this.decalCursor = (this.decalCursor + 1) % MAX_DECALS;
      const d = this.decals[i];
      d.active = true;
      d.oil = oil;
      d.wall = 0;
      d.y = 0;
      d.x = x + (rand() - 0.5) * 1.2 * sizeMult;
      d.z = z + (rand() - 0.5) * 1.2 * sizeMult;
      d.rotY = rand() * Math.PI * 2;
      d.scale = 0.15;
      d.targetScale = (0.7 + rand() * 1.2) * sizeMult;
      d.aspect = 1;
      if (oil) tmpColor.setHSL(0.6, 0.12, 0.03 + rand() * 0.02); // near-black machine oil
      else tmpColor.setHSL(0.995, 0.8, 0.055 + rand() * 0.045); // dark arterial reds
      (d.oil ? this.oilMesh : this.decalMesh).setColorAt(i, tmpColor);
    }
    if (this.decalMesh.instanceColor) this.decalMesh.instanceColor.needsUpdate = true;
    if (this.oilMesh.instanceColor) this.oilMesh.instanceColor.needsUpdate = true;
    this.decalsDirty = true;
  }

  /** one big pool that keeps widening — what's left where something died */
  pool(x: number, z: number, sizeMult = 1, oil = false) {
    const i = this.decalCursor;
    this.decalCursor = (this.decalCursor + 1) % MAX_DECALS;
    const d = this.decals[i];
    d.active = true;
    d.oil = oil;
    d.wall = 0;
    d.y = 0;
    d.x = x;
    d.z = z;
    d.rotY = this.rand() * Math.PI * 2;
    d.scale = 0.25;
    d.targetScale = (1.9 + this.rand() * 1.0) * sizeMult;
    d.aspect = 1;
    if (oil) tmpColor.setHSL(0.6, 0.15, 0.025 + this.rand() * 0.015);
    else tmpColor.setHSL(0.995, 0.8, 0.06 + this.rand() * 0.03); // near-black heart blood
    (d.oil ? this.oilMesh : this.decalMesh).setColorAt(i, tmpColor);
    if (this.decalMesh.instanceColor) this.decalMesh.instanceColor.needsUpdate = true;
    if (this.oilMesh.instanceColor) this.oilMesh.instanceColor.needsUpdate = true;
    this.decalsDirty = true;
  }

  /** directional spray — a fan of elongated streaks along the kill vector */
  spray(x: number, z: number, dirX: number, dirZ: number, count = 5, sizeMult = 1, oil = false) {
    const baseAng = Math.atan2(dirX, dirZ);
    for (let n = 0; n < count; n++) {
      const i = this.decalCursor;
      this.decalCursor = (this.decalCursor + 1) % MAX_DECALS;
      const d = this.decals[i];
      const dist = (0.5 + n * 0.45 + this.rand() * 0.4) * sizeMult;
      const ang = baseAng + (this.rand() - 0.5) * 0.7;
      d.active = true;
      d.oil = oil;
      d.wall = 0;
      d.y = 0;
      d.x = x + Math.sin(ang) * dist;
      d.z = z + Math.cos(ang) * dist;
      d.rotY = ang + Math.PI / 2;
      d.scale = 0.1;
      d.targetScale = (0.55 - n * 0.05 + this.rand() * 0.25) * sizeMult;
      d.aspect = 1.9;
      if (oil) tmpColor.setHSL(0.6, 0.12, 0.025 + this.rand() * 0.015);
      else tmpColor.setHSL(0.995, 0.8, 0.05 + this.rand() * 0.04);
      (d.oil ? this.oilMesh : this.decalMesh).setColorAt(i, tmpColor);
    }
    if (this.decalMesh.instanceColor) this.decalMesh.instanceColor.needsUpdate = true;
    if (this.oilMesh.instanceColor) this.oilMesh.instanceColor.needsUpdate = true;
    this.decalsDirty = true;
  }

  /**
   * a flame touched spilled oil: the WHOLE contiguous slick catches — flood
   * fill through overlapping oil decals from the ignition point. Each ignited
   * decal chars on the spot (matte, near-black, no longer oil) and its
   * position/size is returned so the game can lay fire over it.
   */
  igniteOilNear(x: number, z: number, r: number): { x: number; z: number; r: number }[] {
    const out: { x: number; z: number; r: number }[] = [];
    const frontier: { x: number; z: number; r: number }[] = [{ x, z, r }];
    while (frontier.length > 0) {
      const f = frontier.pop()!;
      for (let i = 0; i < MAX_DECALS; i++) {
        const d = this.decals[i];
        if (!d.active || !d.oil || d.wall !== 0) continue;
        const dr = d.targetScale * 0.7;
        if (Math.hypot(d.x - f.x, d.z - f.z) > f.r + dr) continue;
        d.oil = false; // burnt oil is spent: charred and matte
        tmpColor.setHSL(0.07, 0.25, 0.03);
        this.decalMesh.setColorAt(i, tmpColor);
        this.writeDecal(i);
        const hit = { x: d.x, z: d.z, r: dr };
        out.push(hit);
        frontier.push(hit);
      }
    }
    if (out.length > 0) {
      if (this.decalMesh.instanceColor) this.decalMesh.instanceColor.needsUpdate = true;
      this.decalsDirty = true;
    }
    return out;
  }

  /** scorch mark (Deadhand, Pyre) */
  scorch(x: number, z: number, rand: () => number, sizeMult = 1) {
    const i = this.decalCursor;
    this.decalCursor = (this.decalCursor + 1) % MAX_DECALS;
    const d = this.decals[i];
    d.active = true;
    d.oil = false; // char is bone-dry
    d.wall = 0;
    d.y = 0;
    d.aspect = 1;
    d.x = x;
    d.z = z;
    d.rotY = rand() * Math.PI * 2;
    d.scale = 0.3;
    d.targetScale = (0.9 + rand() * 0.8) * sizeMult;
    tmpColor.setHSL(0.08, 0.2, 0.02 + rand() * 0.02);
    (d.oil ? this.oilMesh : this.decalMesh).setColorAt(i, tmpColor);
    if (this.decalMesh.instanceColor) this.decalMesh.instanceColor.needsUpdate = true;
    if (this.oilMesh.instanceColor) this.oilMesh.instanceColor.needsUpdate = true;
    this.decalsDirty = true;
  }

  /**
   * gib burst — meat and bone under impulse.
   * kind: 'meat' (red), 'ash' (vaporized), 'bone', 'brass' (casings), 'metal' (machine parts)
   */
  burst(
    pos: THREE.Vector3,
    rand: () => number,
    count: number,
    power = 1,
    kind: 'meat' | 'ash' | 'bone' | 'brass' | 'metal' = 'meat',
    dir?: { x: number; z: number },
  ) {
    for (let n = 0; n < count; n++) {
      const i = this.gibCursor;
      this.gibCursor = (this.gibCursor + 1) % MAX_GIBS;
      const g = this.gibs[i];
      g.active = true;
      g.settled = false;
      g.pos.set(pos.x + (rand() - 0.5) * 0.3, Math.max(0.3, pos.y) + rand() * 0.4, pos.z + (rand() - 0.5) * 0.3);
      const a = rand() * Math.PI * 2;
      const sp = (2 + rand() * 4.5) * power;
      g.vel.set(Math.cos(a) * sp, (3 + rand() * 5) * power, Math.sin(a) * sp);
      if (dir) {
        // carried by the momentum of the killing blow
        g.vel.x += dir.x * 4.5 * power;
        g.vel.z += dir.z * 4.5 * power;
      }
      g.rot.set(rand() * 3, rand() * 3, rand() * 3);
      g.angVel.set((rand() - 0.5) * 18, (rand() - 0.5) * 18, (rand() - 0.5) * 18);
      g.scale = kind === 'brass' ? 0.42 + rand() * 0.2 : 0.5 + rand() * 0.95;
      g.maxLife = kind === 'brass' ? 2.5 + rand() : 5.5 + rand() * 4;
      g.life = g.maxLife;
      g.meat = kind === 'meat';
      g.bounced = false;
      if (kind === 'meat') tmpColor.setHSL(0.99, 0.72, 0.1 + rand() * 0.09);
      else if (kind === 'ash') tmpColor.setHSL(0.08, 0.05, 0.06 + rand() * 0.05);
      else if (kind === 'brass') tmpColor.setHSL(0.11, 0.65, 0.42 + rand() * 0.12);
      else if (kind === 'metal') tmpColor.setHSL(0.58, 0.06, 0.22 + rand() * 0.18);
      else tmpColor.setHSL(0.1, 0.15, 0.65 + rand() * 0.15);
      this.gibMesh.setColorAt(i, tmpColor);
    }
    if (this.gibMesh.instanceColor) this.gibMesh.instanceColor.needsUpdate = true;
    this.gibsDirty = true;
  }

  /**
   * hand a severed body part (already re-parented to the scene at its world
   * transform) to the physics pool — it tumbles, bounces, bleeds, stays
   */
  addDebris(obj: THREE.Object3D, vel: THREE.Vector3, angVel: THREE.Vector3) {
    if (this.debris.length >= MAX_DEBRIS) {
      const old = this.debris.shift()!;
      this.disposeDebris(old);
    }
    this.debris.push({ obj, vel, angVel, t: 12, settled: false, bounced: false });
  }

  private disposeDebris(d: Debris) {
    // geometries are cached and materials share programs — removal is enough
    this.scene.remove(d.obj);
  }

  /** room transition: the next arena is clean (until it isn't) */
  clear() {
    for (let i = 0; i < MAX_GIBS; i++) {
      this.gibs[i].active = false;
      this.writeGib(i);
    }
    for (let i = 0; i < MAX_DECALS; i++) {
      this.decals[i].active = false;
      this.writeDecal(i);
    }
    for (const d of this.debris) this.disposeDebris(d);
    this.debris = [];
    this.gibsDirty = true;
    this.decalsDirty = true;
  }

  update(dt: number) {
    for (let i = 0; i < MAX_GIBS; i++) {
      const g = this.gibs[i];
      if (!g.active) continue;
      g.life -= dt;
      if (g.life <= 0) {
        g.active = false;
        this.writeGib(i);
        this.gibsDirty = true;
        continue;
      }
      if (!g.settled) {
        g.vel.y -= 22 * dt;
        g.pos.addScaledVector(g.vel, dt);
        g.rot.x += g.angVel.x * dt;
        g.rot.y += g.angVel.y * dt;
        g.rot.z += g.angVel.z * dt;
        if (g.pos.y <= 0.07) {
          g.pos.y = 0.07;
          g.vel.y *= -0.35;
          g.vel.x *= 0.55;
          g.vel.z *= 0.55;
          g.angVel.multiplyScalar(0.5);
          // meat marks where it lands
          if (g.meat && !g.bounced && this.rand() < 0.6) {
            this.splat(g.pos.x, g.pos.z, this.rand, 1, 0.45 * g.scale);
          }
          g.bounced = true;
          if (Math.abs(g.vel.y) < 0.8) {
            g.settled = true;
            g.vel.set(0, 0, 0);
          }
        }
        this.writeGib(i);
        this.gibsDirty = true;
      } else if (g.life < 0.6) {
        // sink away
        g.pos.y = 0.07 - (0.6 - g.life) * 0.15;
        this.writeGib(i);
        this.gibsDirty = true;
      }
    }

    for (let i = 0; i < MAX_DECALS; i++) {
      const d = this.decals[i];
      if (!d.active || d.scale >= d.targetScale) continue;
      d.scale = Math.min(d.targetScale, d.scale + dt * d.targetScale * 0.55);
      this.writeDecal(i);
      this.decalsDirty = true;
    }

    // severed parts: tumble, bounce, bleed where they land, linger
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.t -= dt;
      if (d.t <= 0) {
        this.disposeDebris(d);
        this.debris.splice(i, 1);
        continue;
      }
      if (d.settled) {
        if (d.t < 0.7) d.obj.position.y -= dt * 0.4; // sink away at the end
        continue;
      }
      d.vel.y -= 20 * dt;
      d.obj.position.addScaledVector(d.vel, dt);
      d.obj.rotation.x += d.angVel.x * dt;
      d.obj.rotation.y += d.angVel.y * dt;
      d.obj.rotation.z += d.angVel.z * dt;
      if (d.obj.position.y <= 0.16) {
        d.obj.position.y = 0.16;
        d.vel.y = Math.abs(d.vel.y) * 0.35;
        d.vel.x *= 0.5;
        d.vel.z *= 0.5;
        d.angVel.multiplyScalar(0.45);
        if (!d.bounced) {
          d.bounced = true;
          this.splat(d.obj.position.x, d.obj.position.z, this.rand, 2, 0.8);
        }
        if (d.vel.y < 0.9) {
          d.settled = true;
          this.splat(d.obj.position.x, d.obj.position.z, this.rand, 1, 0.6);
        }
      }
    }

    if (this.gibsDirty) {
      this.gibMesh.instanceMatrix.needsUpdate = true;
      this.gibsDirty = false;
    }
    if (this.decalsDirty) {
      this.decalMesh.instanceMatrix.needsUpdate = true;
      this.oilMesh.instanceMatrix.needsUpdate = true;
      this.decalsDirty = false;
    }
  }
}

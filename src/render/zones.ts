import * as THREE from 'three';
import { boxGeo, cylGeo, torusGeo, circleGeo, rockGeo } from './geocache';
import { texturedStd } from './textures';
import type { Rng } from '../core/rng';

// Deliberate level design: the 15-room descent tells a story you can read on
// screen. Crash site on a burning world → the torn hull → cargo → the crew's
// spaces → the ship's guts → its brain → its guns → the foundry where the
// Foreman waits. Each zone has its own surfaces, palette, set dressing, and
// animated lights. Decorators place combat cover deliberately, not randomly.

export interface Collider {
  x: number;
  z: number;
  r: number;
}

export interface ZoneVent {
  pos: THREE.Vector3;
  kind: 'fire' | 'steam' | 'spark' | 'smoke';
  /** average emissions per second */
  rate: number;
  /** optional lifetime in seconds — temporary emitters (post-strike smoke columns) */
  ttl?: number;
}

export interface RoomBuild {
  colliders: Collider[];
  vents: ZoneVent[];
  /** zone-authored ordnance the game arms as live destructibles */
  explosives?: { x: number; z: number; r: number; mesh: THREE.Object3D }[];
}

/** animation registry the Stage exposes to decorators */
export interface FxReg {
  blink(mat: THREE.MeshBasicMaterial, on: number, off: number, speed: number, phase?: number): void;
  pulseLight(l: THREE.PointLight, base: number, amp: number, speed: number, phase?: number): void;
  spin(o: THREE.Object3D, axis: 'x' | 'y' | 'z', speed: number): void;
  sway(o: THREE.Object3D, amp: number, speed: number): void;
  piston(o: THREE.Object3D, amp: number, speed: number, phase?: number): void;
}

export type DoorStyle = 'pass' | 'airlock' | 'bulkhead' | 'blast' | 'containment' | 'crew';

export interface ZoneDef {
  name: string;
  floorTex: 'ground' | 'deck' | 'tile';
  wallTex: 'rock' | 'panel';
  /** open horizon bounded by rocks/dead trees instead of walls */
  outdoor?: boolean;
  /** what the north exit looks like */
  doorStyle: DoorStyle;
  floorTint: number;
  wallTint: number;
  accent: number;
  lamp: number;
  fog: number;
  fogDensity: number;
  /** floor roughness scalar (1 = dead matte; lower = worn metal / waxed tile) */
  floorGloss?: number;
  /** multiplier on the drifting fog sheet count */
  fogSheets?: number;
  /** kill the standard corner work lights (screen-lit rooms) */
  noCornerLights?: boolean;
  decorate(g: THREE.Group, rng: Rng, fx: FxReg): RoomBuild;
}

const AW = 24; // arena width  (x: -12..12)
const AD = 30; // arena depth (z: -15..15) — two screens; enter south, door north

// ------------------------------------------------------------- helpers
function std(color: number, rough = 0.75, metal = 0.5): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

function box(
  w: number, h: number, d: number, mat: THREE.Material,
  x: number, y: number, z: number, parent: THREE.Object3D, ry = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(boxGeo(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.y = ry;
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function cylinder(
  rt: number, rb: number, h: number, mat: THREE.Material,
  x: number, y: number, z: number, parent: THREE.Object3D, segs = 12,
): THREE.Mesh {
  const m = new THREE.Mesh(cylGeo(rt, rb, h, segs), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function pointLight(color: number, intensity: number, range: number, x: number, y: number, z: number, parent: THREE.Object3D): THREE.PointLight {
  const l = new THREE.PointLight(color, intensity, range, 1.9);
  l.position.set(x, y, z);
  parent.add(l);
  return l;
}

/** a fallen crew member — armor plate lumps, dried blood beneath */
function corpse(g: THREE.Group, rng: Rng, x: number, z: number, armored: boolean) {
  const rot = rng.range(0, Math.PI * 2);
  const body = armored ? std(0x3a3d45, 0.6, 0.6) : std(0x5a4438, 0.9, 0.1);
  const flesh = std(0x6a3535, 0.95, 0.02);
  box(0.5, 0.16, 0.28, body, x, 0.08, z, g, rot);
  box(0.22, 0.12, 0.24, armored ? body : flesh, x + Math.cos(rot) * 0.34, 0.06, z - Math.sin(rot) * 0.34, g, rot);
  box(0.4, 0.1, 0.12, flesh, x - Math.cos(rot) * 0.3, 0.05, z + Math.sin(rot) * 0.3, g, rot + 0.5);
  // dried blood: overlapping squashed lobes, not a neat circle
  const bloodMat = new THREE.MeshStandardMaterial({ color: 0x2a0808, roughness: 0.4, metalness: 0 });
  for (let i = 0; i < 3; i++) {
    const blood = new THREE.Mesh(circleGeo(0.3 + rng.next() * 0.35, 10), bloodMat);
    blood.rotation.x = -Math.PI / 2;
    blood.rotation.z = rng.next() * Math.PI;
    blood.scale.set(1 + rng.next() * 0.8, 0.55 + rng.next() * 0.5, 1);
    blood.position.set(x + (rng.next() - 0.5) * 0.8, 0.013 + i * 0.001, z + (rng.next() - 0.5) * 0.8);
    g.add(blood);
  }
}

/** shared cargo container — stackable, collidable */
function container(g: THREE.Group, rng: Rng, x: number, z: number, colliders: Collider[], twoHigh: boolean) {
  const palette = [0x5a3028, 0x4a5238, 0x37424e, 0x5c4a22];
  const ry = rng.range(-0.15, 0.15);
  const c1 = texturedStd('panel', rng.pick(palette), 0.65, 0.55, 0.8);
  box(2.0, 1.15, 1.15, c1, x, 0.575, z, g, ry);
  box(2.04, 0.1, 1.19, std(0x22242a, 0.7, 0.6), x, 1.16, z, g, ry);
  if (twoHigh) {
    const c2 = texturedStd('panel', rng.pick(palette), 0.65, 0.55, 0.8);
    box(2.0, 1.15, 1.15, c2, x + rng.range(-0.15, 0.15), 1.75, z + rng.range(-0.1, 0.1), g, ry + rng.range(-0.1, 0.1));
    if (rng.chance(0.5)) {
      // third tier — the hold was packed to the ceiling
      const c3 = texturedStd('panel', rng.pick(palette), 0.65, 0.55, 0.8);
      box(1.9, 1.1, 1.1, c3, x + rng.range(-0.25, 0.25), 2.88, z + rng.range(-0.12, 0.12), g, ry + rng.range(-0.18, 0.18));
    }
  }
  colliders.push({ x, z, r: 1.35 });
}

/** a personal terminal — hinged screen, still glowing */
function laptop(g: THREE.Group, fx: FxReg, x: number, y: number, z: number, ry: number, color = 0x3c8a5a) {
  const body = std(0x2c2f36, 0.6, 0.6);
  box(0.36, 0.03, 0.26, body, x, y + 0.015, z, g, ry);
  const lid = box(0.36, 0.26, 0.02, body, x - Math.sin(ry) * 0.12, y + 0.14, z - Math.cos(ry) * 0.12, g, ry);
  lid.rotation.x = -0.35;
  const sm = new THREE.MeshBasicMaterial({ color });
  const scr = box(0.3, 0.2, 0.006, sm, x - Math.sin(ry) * 0.105, y + 0.14, z - Math.cos(ry) * 0.105, g, ry);
  scr.rotation.x = -0.35;
  scr.castShadow = false;
  fx.blink(sm, color, 0x0a0e12, 0.2 + (Math.abs(x * 7) % 1) * 2, x + z);
}

/** a work chair, shoved back the moment it all went wrong */
function chair(g: THREE.Group, x: number, z: number, ry: number) {
  const m = std(0x3a3e46, 0.7, 0.4);
  box(0.44, 0.06, 0.44, m, x, 0.42, z, g, ry);
  box(0.44, 0.5, 0.06, m, x - Math.sin(ry) * 0.22, 0.7, z - Math.cos(ry) * 0.22, g, ry);
  cylinder(0.05, 0.05, 0.4, m, x, 0.2, z, g, 8);
}

// ------------------------------------------------------------- zones
const crashSite = (heavy: boolean): ZoneDef => ({
  name: heavy ? 'Поле обломков' : 'Место крушения',
  outdoor: true,
  doorStyle: (heavy ? 'airlock' : 'pass') as DoorStyle,
  floorTex: 'ground',
  wallTex: 'rock',
  floorTint: 0x8a7f74, // burn the pale dirt down to scorched umber
  wallTint: 0x6a6058,
  accent: 0xff5a14,
  lamp: 0xff8a4a,
  fog: 0x160a05,
  fogDensity: 0.017,
  decorate(g, rng, fx) {
    const colliders: Collider[] = [];
    const vents: ZoneVent[] = [];
    const hull = texturedStd('panel', 0x3a332c, 0.6, 0.7, 1.2);
    const scorch = texturedStd('panel', 0x211b16, 0.85, 0.4, 5, 2.4); // 16m silhouette — tile, don't stretch

    // the dying ship looms past the north wall — where you are headed
    const silhouette = box(16, 7, 2.5, scorch, -2, 2.2, -19, g, 0.12);
    silhouette.rotation.z = 0.08;
    box(5, 9, 2, scorch, 6.5, 2.5, -19.3, g, -0.1);
    const shipGlow = pointLight(0xff6a1c, 30, 18, 2, 5, -17.5, g);
    fx.pulseLight(shipGlow, 30, 8, 1.3);

    // buried hull shards, still burning, strewn down the whole approach
    const shardCount = heavy ? 6 : 5;
    for (let i = 0; i < shardCount; i++) {
      const x = rng.range(-9, 9);
      const z = rng.range(-13, 10);
      if (Math.hypot(x, z - 13) < 4.5 || (Math.abs(x) < 2.4 && z < -11)) continue;
      const shard = box(rng.range(1.4, 2.4), rng.range(1.2, 2.2), 0.3, hull, x, rng.range(0.4, 0.8), z, g, rng.range(0, 3));
      shard.rotation.z = rng.range(-0.5, 0.5);
      colliders.push({ x, z, r: 1.1 });
      if (rng.chance(0.7)) {
        vents.push({ pos: new THREE.Vector3(x + rng.range(-0.5, 0.5), 0.2, z + rng.range(-0.5, 0.5)), kind: 'fire', rate: 7 });
        const fl = pointLight(0xff6a1c, 9, 5, x, 0.8, z, g);
        fx.pulseLight(fl, 9, 4, 6 + rng.next() * 3);
      }
    }

    // a broken crawler-truck, thrown on its side
    if (heavy) {
      const tx = rng.range(-6, 6);
      const tz = rng.range(-10, 6);
      const wreckG = new THREE.Group();
      wreckG.position.set(tx, 0, tz);
      wreckG.rotation.y = rng.range(0, Math.PI);
      g.add(wreckG);
      box(2.6, 1.0, 1.3, std(0x3d4038, 0.55, 0.65), 0, 0.9, 0, wreckG).rotation.z = 1.35; // flipped chassis
      for (let w = 0; w < 3; w++) {
        const wheel = cylinder(0.4, 0.4, 0.25, std(0x1a1a1c, 0.9, 0.2), -0.9 + w * 0.9, 1.45, 0.1, wreckG);
        wheel.rotation.x = Math.PI / 2;
        fx.spin(wheel, 'y', w === 1 ? 0.8 : 0); // one wheel still turning, slowly
      }
      colliders.push({ x: tx, z: tz, r: 1.5 });
      vents.push({ pos: new THREE.Vector3(tx, 1.2, tz), kind: 'steam', rate: 3 });

      // sheer cliff walls climb into darkness on both flanks — the debris
      // field is a canyon, and the only way through is forward
      const cliff = texturedStd('rock', 0x2a241e, 0.98, 0.02, 2.2);
      for (const side of [-1, 1]) {
        for (let i = 0; i < 7; i++) {
          const cz3 = -14 + i * 4.6 + rng.range(-0.8, 0.8);
          const ch = rng.range(4.5, 8);
          const crag = new THREE.Mesh(rockGeo(rng.int(0, 5)), cliff);
          crag.scale.set(rng.range(2.2, 3.4), ch, rng.range(2.4, 3.6));
          crag.position.set(side * (AW / 2 + rng.range(1.4, 2.6)), ch * 0.32, cz3);
          crag.rotation.y = rng.next() * 3;
          crag.castShadow = true;
          crag.receiveShadow = true;
          g.add(crag);
        }
      }
    }

    if (!heavy) {
      // a ruined habitat module — collapsed walls, one corner still standing
      const bx = rng.pick([-6.5, 6.5]);
      const bz = rng.range(-6, 2);
      const wallM = texturedStd('panel', 0x4a423a, 0.8, 0.35, 1.3);
      box(3.4, 2.2, 0.3, wallM, bx, 1.1, bz - 1.5, g, 0.05).rotation.z = -0.06;
      box(0.3, 1.5, 2.6, wallM, bx - 1.6, 0.75, bz - 0.2, g).rotation.x = 0.08;
      const fallen = box(2.6, 0.26, 1.7, wallM, bx + 0.8, 0.16, bz + 0.8, g, 0.4);
      fallen.rotation.z = 0.12;
      box(1.1, 0.9, 0.9, scorch, bx - 0.7, 0.45, bz + 0.4, g, 0.7); // burnt interior junk
      colliders.push({ x: bx, z: bz - 1.2, r: 1.7 }, { x: bx - 1.5, z: bz, r: 1.1 });
      vents.push({ pos: new THREE.Vector3(bx - 0.5, 0.6, bz), kind: 'smoke', rate: 2 });

      // a ground car, crushed flat under the plate that landed on it
      const carX = rng.pick([-3, 3.5]);
      const carZ = rng.range(4, 9);
      const carRy = rng.range(0, 3);
      const car = box(2.1, 0.5, 1.0, std(0x5a3a30, 0.55, 0.6), carX, 0.26, carZ, g, carRy);
      car.scale.y = 0.62; // pancaked
      const cab = box(1.0, 0.32, 0.9, std(0x2a2622, 0.7, 0.3), carX - Math.cos(carRy) * 0.3, 0.44, carZ + Math.sin(carRy) * 0.3, g, carRy);
      cab.scale.y = 0.55; // caved in
      for (const [wx, wz] of [[-0.8, 0.55], [0.8, 0.55], [-0.8, -0.55], [0.8, -0.55]]) {
        const wheel = cylinder(0.26, 0.26, 0.16, std(0x17171a, 0.95, 0.1), carX + wx, 0.24, carZ + wz, g, 10);
        wheel.rotation.x = Math.PI / 2;
      }
      const plate2 = box(2.4, 0.2, 1.6, hull, carX + 0.4, 0.72, carZ, g, carRy + 0.5);
      plate2.rotation.z = 0.18;
      colliders.push({ x: carX, z: carZ, r: 1.4 });
      vents.push({ pos: new THREE.Vector3(carX, 0.7, carZ), kind: 'steam', rate: 2.5 });
    }

    // the dead: crew thrown from the wreck
    for (let i = 0; i < (heavy ? 6 : 4); i++) {
      corpse(g, rng, rng.range(-9, 9), rng.range(-12, 11), rng.chance(0.5));
    }
    // scattered rubble — craggy stone, not marbles
    const rock = texturedStd('rock', 0x6e6a64, 0.95, 0.1, 1.5);
    for (let i = 0; i < 12; i++) {
      const x = rng.range(-10, 10);
      const z = rng.range(-13.5, 12);
      if (Math.hypot(x, z - 13) < 3) continue;
      const rk = new THREE.Mesh(rockGeo(rng.int(0, 5)), rock);
      // non-uniform: small rubble must read as broken shards, never as eggs
      const s = rng.range(0.22, 0.5);
      rk.scale.set(s * rng.range(0.75, 1.5), s * rng.range(0.45, 0.8), s * rng.range(0.75, 1.5));
      rk.position.set(x, 0.15, z);
      rk.rotation.set(rng.next() * 3, rng.next() * 3, rng.next() * 3);
      rk.castShadow = true;
      g.add(rk);
    }
    return { colliders, vents };
  },
});

const hullBreach: ZoneDef = {
  name: 'Пробоина',
  doorStyle: 'bulkhead',
  floorTex: 'deck',
  wallTex: 'panel',
  floorTint: 0x6a655c,
  wallTint: 0x5c5850,
  accent: 0xe83a2a,
  lamp: 0xff6a52,
  fog: 0x0c0806,
  fogDensity: 0.014,
  decorate(g, rng, fx) {
    const colliders: Collider[] = [];
    const vents: ZoneVent[] = [];
    const hull = texturedStd('panel', 0x3c3e46, 0.55, 0.75, 1.2);
    // peeled hull plates, blown inward, all the way down the breach
    for (let i = 0; i < 7; i++) {
      const x = rng.range(-9, 9);
      const z = rng.range(-13, 10);
      if (Math.hypot(x, z - 13) < 4.5 || (Math.abs(x) < 2.4 && z < -11)) continue;
      const plate = box(rng.range(1.2, 2), rng.range(1.4, 2.4), 0.18, hull, x, 0.7, z, g, rng.range(0, 3));
      plate.rotation.x = rng.range(-0.6, -0.2);
      colliders.push({ x, z, r: 1.0 });
      if (rng.chance(0.6)) vents.push({ pos: new THREE.Vector3(x, 0.9, z), kind: 'spark', rate: 2.5 });
    }
    // torn cable bundles hanging from the wall line, spitting
    for (let i = 0; i < 5; i++) {
      const x = rng.range(-10, 10);
      const side = rng.chance(0.5) ? -1 : 1;
      const z = side * (AD / 2 - 0.6);
      const cable = cylinder(0.05, 0.05, 1.3, std(0x1c1c20, 0.8, 0.4), x, 1.5, z, g);
      cable.rotation.z = rng.range(-0.4, 0.4);
      fx.sway(cable, 0.12, 1.5 + rng.next());
      vents.push({ pos: new THREE.Vector3(x, 0.9, z), kind: 'spark', rate: 1.6 });
    }
    // work lights still hanging from the torn ceiling — flickering hard,
    // spitting sparks; the breach is live wiring end to end
    for (const [lx, lz] of [[-4, -7], [5, 2]] as [number, number][]) {
      cylinder(0.03, 0.03, 1.1, std(0x1c1c20, 0.7, 0.5), lx, 3.3, lz, g);
      const shade = cylinder(0.26, 0.4, 0.24, std(0x33363c, 0.5, 0.7), lx, 2.7, lz, g);
      shade.castShadow = false;
      const bulbM = new THREE.MeshBasicMaterial({ color: 0xffe2b0 });
      box(0.14, 0.1, 0.14, bulbM, lx, 2.6, lz, g);
      fx.blink(bulbM, 0xffe2b0, 0x2a2418, 9, lx);
      const hl = pointLight(0xffd9a0, 20, 12, lx, 2.4, lz, g);
      fx.pulseLight(hl, 20, 9, 9, lx * 2);
      vents.push({ pos: new THREE.Vector3(lx, 2.5, lz), kind: 'spark', rate: 1.2 });
    }
    // emergency strobes
    for (const sx of [-6, 6]) {
      const lampMat = new THREE.MeshBasicMaterial({ color: 0xff2a1a });
      box(0.3, 0.16, 0.16, lampMat, sx, 2.0, -AD / 2 + 0.55, g);
      fx.blink(lampMat, 0xff2a1a, 0x2a0808, 2.2, sx);
      const l = pointLight(0xff2a1a, 0, 8, sx, 2.0, -AD / 2 + 1, g);
      fx.pulseLight(l, 7, 7, 2.2, sx);
    }
    corpse(g, rng, rng.range(-6, 6), rng.range(2, 10), true);
    corpse(g, rng, rng.range(-8, 8), rng.range(-12, -5), true);
    return { colliders, vents };
  },
};

const cargoHold: ZoneDef = {
  name: 'Грузовой трюм',
  doorStyle: 'blast',
  floorTex: 'deck',
  wallTex: 'panel',
  floorTint: 0x777a80,
  wallTint: 0x6e7076,
  accent: 0xffb02a,
  lamp: 0xffd06a,
  fog: 0x0a0908,
  fogDensity: 0.011,
  floorGloss: 0.5, // old scratched deck steel — worn, but it still reflects
  decorate(g, rng, fx) {
    const colliders: Collider[] = [];
    const vents: ZoneVent[] = [];
    // container stacks — the hold is CRAMPED: six big stacks…
    container(g, rng, -6.5, -9, colliders, true);
    container(g, rng, 6.5, -8, colliders, rng.chance(0.6));
    container(g, rng, rng.pick([-3, 3]), -2.5, colliders, false);
    container(g, rng, rng.pick([-6, 6]), 4.5, colliders, rng.chance(0.5));
    container(g, rng, rng.range(-2, 2), 8.5, colliders, false);
    container(g, rng, rng.pick([-8.5, 8.5]), 0.5, colliders, true);
    // …and a dozen loose crates between them
    for (let i = 0; i < 12; i++) {
      const x = rng.range(-9.5, 9.5);
      const z = rng.range(-12.5, 9.5);
      if (Math.hypot(x, z - 13) < 3.5 || (Math.abs(x) < 2.2 && z < -11.5)) continue;
      if (colliders.some((c) => Math.hypot(c.x - x, c.z - z) < c.r + 0.9)) continue;
      const s = rng.range(0.55, 0.9);
      box(s, s, s, texturedStd('panel', rng.pick([0x4a5238, 0x5c4a22, 0x37424e]), 0.7, 0.45, 0.6), x, s / 2, z, g, rng.range(0, 3));
      if (rng.chance(0.35)) {
        box(s * 0.7, s * 0.7, s * 0.7, texturedStd('panel', 0x5a3028, 0.7, 0.45, 0.6), x + 0.15, s + s * 0.35, z, g, rng.range(0, 3));
      }
      colliders.push({ x, z, r: s * 0.75 });
    }

    // twin gantry cranes: one over the far container row, one right over the
    // entrance — each with a pair of spotlights flooding the deck below
    const steel = std(0x4a4436, 0.5, 0.8);
    const buildCrane = (craneZ: number) => {
      for (const sx of [-1, 1]) {
        box(0.5, 4.2, 0.5, steel, sx * (AW / 2 - 1.1), 2.1, craneZ, g);
      }
      box(AW - 1.6, 0.5, 0.7, steel, 0, 4.3, craneZ, g); // bridge beam
      const trolley = new THREE.Group();
      trolley.position.set(rng.range(-4, 4), 4.0, craneZ);
      g.add(trolley);
      box(0.9, 0.4, 0.9, std(0x5c4a22, 0.55, 0.7), 0, 0, 0, trolley);
      cylinder(0.03, 0.03, 1.6, std(0x1c1c20, 0.6, 0.6), 0, -1.0, 0, trolley);
      const hook = new THREE.Group();
      hook.position.y = -1.9;
      trolley.add(hook);
      box(0.9, 0.55, 0.55, std(0x5a3028, 0.65, 0.55), 0, -0.25, 0, hook); // hanging crate
      fx.sway(hook, 0.08, 0.7);
      for (const lx of [-4.5, 4.5]) {
        const housing = box(0.4, 0.3, 0.4, std(0x33302a, 0.5, 0.7), lx, 4.0, craneZ + 0.45, g);
        housing.rotation.x = 0.5;
        const spot = new THREE.SpotLight(0xffe2b0, 70, 17, 0.62, 0.5, 1.4);
        spot.position.set(lx, 4.1, craneZ + 0.3);
        // beams rake INTO the hold from either crane, never into the walls
        spot.target.position.set(lx * 0.7, 0, craneZ + (craneZ < 0 ? 3.5 : -3.5));
        spot.castShadow = false;
        g.add(spot);
        g.add(spot.target);
      }
    };
    buildCrane(-10.5);
    buildCrane(10.5);

    // pallets and drums
    const drum = std(0x37424e, 0.6, 0.7);
    for (let i = 0; i < 5; i++) {
      const x = rng.range(-9, 9);
      const z = rng.range(-13, 8);
      if (colliders.some((c) => Math.hypot(c.x - x, c.z - z) < 2.6) || Math.hypot(x, z - 13) < 3.5) continue;
      box(1.1, 0.12, 1.1, std(0x4a3c28, 0.85, 0.2), x, 0.06, z, g, rng.range(0, 1.5));
      cylinder(0.32, 0.32, 0.7, drum, x + 0.1, 0.47, z, g);
      colliders.push({ x, z, r: 0.7 });
    }
    const nearLamp = pointLight(0xffd06a, 10, 9, 0, 3.2, 6, g);
    fx.pulseLight(nearLamp, 10, 2, 0.5, 3);
    return { colliders, vents };
  },
};

const quarters: ZoneDef = {
  name: 'Жилой отсек',
  doorStyle: 'crew',
  floorTex: 'tile',
  wallTex: 'panel',
  floorTint: 0x8a8478,
  wallTint: 0x767065,
  accent: 0xd8c8a0,
  lamp: 0xffe8be,
  fog: 0x0a0a08,
  fogDensity: 0.012,
  floorGloss: 0.78,
  decorate(g, rng, fx) {
    const colliders: Collider[] = [];
    const vents: ZoneVent[] = [];
    const frame = std(0x3c4046, 0.6, 0.65);
    const mattress = std(0x5a5648, 0.95, 0.02);
    const bloodMattress = std(0x4a2020, 0.9, 0.02);
    // bunk rows in both halves — someone died in their sleep. several someones.
    const bunkSpots: [number, number][] = [
      [-8.5, -12.7], [-5.1, -12.7], [-1.7, -12.7], [1.7, -12.7],
      [-7.5, 5.5], [5.5, 6.5], [-4.5, 9.8], [7.8, 10.2],
    ];
    for (let i = 0; i < bunkSpots.length; i++) {
      const [x, z] = bunkSpots[i];
      box(2.4, 0.12, 1.1, frame, x, 0.5, z, g);
      box(2.4, 0.12, 1.1, frame, x, 1.4, z, g);
      box(2.2, 0.14, 0.95, i === 1 ? bloodMattress : mattress, x, 0.62, z, g);
      box(2.2, 0.14, 0.95, mattress, x, 1.52, z, g);
      for (const [px, pz] of [[-1.1, -0.45], [1.1, -0.45], [-1.1, 0.45], [1.1, 0.45]]) {
        box(0.1, 1.6, 0.1, frame, x + px, 0.8, z + pz, g);
      }
      colliders.push({ x, z, r: 1.35 });
    }
    // ---- the locker room: a walled-off corner of its own ----
    const partition = texturedStd('panel', 0x6a6458, 0.7, 0.5, 2.4, 1);
    box(0.25, 2.2, 2.6, partition, 4.8, 1.1, -13.3, g); // divider, north stub
    box(0.25, 2.2, 1.8, partition, 4.8, 1.1, -9.9, g); // divider, south stub — gap = doorway
    box(6.9, 2.2, 0.25, partition, 8.35, 1.1, -9.1, g); // room's south wall
    for (const c of [
      { x: 4.8, z: -13.6 }, { x: 4.8, z: -12.6 }, { x: 4.8, z: -10.2 }, { x: 4.8, z: -9.4 },
      { x: 5.6, z: -9.1 }, { x: 7.0, z: -9.1 }, { x: 8.4, z: -9.1 }, { x: 9.8, z: -9.1 }, { x: 11.2, z: -9.1 },
    ]) colliders.push({ ...c, r: 0.55 });
    const lockerM = std(0x4a545e, 0.55, 0.7);
    for (let i = 0; i < 5; i++) {
      const x = 6.2 + i * 1.05;
      if (x > 10.8) break;
      box(0.95, 2.0, 0.55, lockerM, x, 1.0, -13.2, g);
      box(0.08, 0.3, 0.04, std(0x9a9a9a, 0.4, 0.9), x + 0.3, 1.1, -12.9, g);
    }
    for (let i = 0; i < 3; i++) {
      box(0.55, 2.0, 0.95, lockerM, 11.4, 1.0, -12.6 + i * 1.05, g); // east wall bank
    }
    // one locker door blown open on the floor, its owner's light still on
    box(0.9, 0.06, 1.9, lockerM, 7.5, 0.03, -11.2, g, 0.5);
    const lockerGlow = pointLight(0xffe8be, 12, 7, 8, 2.0, -11.2, g);
    fx.pulseLight(lockerGlow, 12, 2, 0.4, 5);

    // overturned tables — cover in the middle stretch
    for (const tz of [-4, 1.5]) {
      const tx = rng.range(-4, 4);
      box(2.0, 0.12, 1.1, std(0x5c4a32, 0.8, 0.25), tx, 0.55, tz, g, 1.35).rotation.z = 1.5;
      colliders.push({ x: tx, z: tz, r: 0.9 });
      box(0.5, 0.5, 0.5, std(0x5c4a32, 0.8, 0.25), tx + rng.range(-2, 2), 0.25, tz + rng.range(1, 2.5), g, rng.range(0, 3));
    }
    // the crew
    corpse(g, rng, -4, -10.5, false);
    corpse(g, rng, rng.range(2, 5), rng.range(-8, 0), false);
    corpse(g, rng, rng.range(-6, 0), rng.range(4, 10), false);
    // scattered effects: papers, a still-lit personal lamp
    for (let i = 0; i < 14; i++) {
      box(0.2, 0.01, 0.28, new THREE.MeshStandardMaterial({ color: 0xb8b0a0, roughness: 0.95 }), rng.range(-8, 8), 0.02, rng.range(-12, 11), g, rng.next() * 3);
    }
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffe8be });
    box(0.14, 0.2, 0.14, lampMat, -4.2, 0.6, -12.4, g);
    const pl = pointLight(0xffe8be, 6, 5, -4.2, 0.8, -12.4, g);
    fx.pulseLight(pl, 6, 1.5, 11); // guttering
    fx.blink(lampMat, 0xffe8be, 0x554a38, 11, 2);

    // people LIVED here — the deck lighting still runs warm and steady
    for (const [wx, wz] of [[-4, -6], [4, -1], [0, 7]] as [number, number][]) {
      box(0.5, 0.1, 0.5, std(0x2c2f36, 0.6, 0.6), wx, 2.75, wz, g);
      const ceil = pointLight(0xffeed0, 17, 12, wx, 2.55, wz, g);
      fx.pulseLight(ceil, 17, 1.5, 0.3, wx);
    }
    // mess tables the crew ate at — books, cups, a terminal still logged in
    const woodM = std(0x5c4a32, 0.8, 0.25);
    for (const [tx2, tz2] of [[-1.5, -8.5], [3, 1.5]] as [number, number][]) {
      box(1.9, 0.1, 1.1, woodM, tx2, 0.72, tz2, g);
      for (const lx of [-0.8, 0.8]) box(0.1, 0.72, 0.9, woodM, tx2 + lx, 0.36, tz2, g);
      colliders.push({ x: tx2, z: tz2, r: 1.05 });
      chair(g, tx2 - 0.6, tz2 + 1.0, 0.3);
      chair(g, tx2 + 0.7, tz2 - 1.0, Math.PI - 0.2);
      for (let i = 0; i < 3; i++) {
        box(0.22, 0.05, 0.16, std(rng.pick([0x6a3a2a, 0x2a4a5a, 0x5a5a2a]), 0.9, 0.05), tx2 + rng.range(-0.7, 0.7), 0.8, tz2 + rng.range(-0.4, 0.4), g, rng.next() * 3);
      }
      cylinder(0.05, 0.04, 0.1, std(0x8a8d94, 0.4, 0.7), tx2 + rng.range(-0.6, 0.6), 0.82, tz2 + rng.range(-0.3, 0.3), g, 8);
    }
    laptop(g, fx, -1.2, 0.77, -8.3, 0.4, 0x3c8a5a);
    laptop(g, fx, 3.3, 0.77, 1.7, Math.PI - 0.3, 0x3c6a9a);

    // the vending machine hums on, faithful to the end
    box(0.95, 1.9, 0.75, std(0x7a2a28, 0.45, 0.6), -11.3, 0.95, 2, g);
    const vendM = new THREE.MeshBasicMaterial({ color: 0xaad4ff });
    box(0.06, 1.1, 0.5, vendM, -10.82, 1.15, 2, g);
    fx.blink(vendM, 0xaad4ff, 0x3a5a70, 0.7, 4);
    const vendL = pointLight(0xaad4ff, 9, 6, -10.6, 1.2, 2, g);
    fx.pulseLight(vendL, 9, 2, 0.7, 1);
    colliders.push({ x: -11.3, z: 2, r: 0.85 });
    return { colliders, vents };
  },
};

const messHall: ZoneDef = {
  name: 'Столовая',
  doorStyle: 'crew',
  floorTex: 'tile',
  wallTex: 'panel',
  floorTint: 0x848078,
  wallTint: 0x707068,
  accent: 0xc8d8b0,
  lamp: 0xe8ffd0,
  fog: 0x090a08,
  fogDensity: 0.012,
  floorGloss: 0.35, // waxed galley tile — it was mopped every shift
  decorate(g, rng, fx) {
    const colliders: Collider[] = [];
    const vents: ZoneVent[] = [];
    const table = std(0x4e4438, 0.7, 0.35);
    const bench = std(0x3c3830, 0.75, 0.3);
    // four long mess tables — cover spines in both halves of the hall
    for (const [zx, tz] of [[-3.5, -8], [3.5, -8], [-3.5, 4], [3.5, 4]] as [number, number][]) {
      box(6.5, 0.14, 1.0, table, zx, 0.72, tz, g);
      for (const lx of [-2.8, 0, 2.8]) box(0.12, 0.72, 0.9, table, zx + lx, 0.36, tz, g);
      box(6.5, 0.1, 0.45, bench, zx, 0.42, tz + 1.1, g);
      box(6.5, 0.1, 0.45, bench, zx, 0.42, tz - 1.1, g);
      colliders.push({ x: zx - 2, z: tz, r: 1.0 }, { x: zx + 2, z: tz, r: 1.0 });
      // the last meal is still on the tables: trays, plates, cups
      for (let i = 0; i < 4; i++) {
        box(0.3, 0.03, 0.2, std(0x8a8d94, 0.4, 0.8), zx + rng.range(-2.8, 2.8), 0.81, tz + rng.range(-0.3, 0.3), g, rng.next());
      }
      for (let i = 0; i < 3; i++) {
        cylinder(0.13, 0.15, 0.025, std(0xb8bcc4, 0.35, 0.6), zx + rng.range(-2.8, 2.8), 0.81, tz + rng.range(-0.35, 0.35), g, 12);
      }
      for (let i = 0; i < 2; i++) {
        cylinder(0.05, 0.04, 0.1, std(0x8a8d94, 0.4, 0.7), zx + rng.range(-2.6, 2.6), 0.84, tz + rng.range(-0.3, 0.3), g, 8);
      }
    }
    // serving counter — shifted west so the exit lane stays wide open
    box(6.4, 1.0, 0.9, texturedStd('panel', 0x6a6e76, 0.5, 0.75, 2.2, 1), -6.8, 0.5, -13.7, g);
    for (let x2 = -9.6; x2 <= -4.2; x2 += 1.35) colliders.push({ x: x2, z: -13.7, r: 0.75 });
    for (let i = 0; i < 3; i++) {
      cylinder(0.22, 0.18, 0.3, std(0x6a6d73, 0.35, 0.9), -9 + i * 2, 1.15, -13.7, g);
    }
    // counter clutter + its own service light
    for (let i = 0; i < 5; i++) {
      if (rng.chance(0.5)) cylinder(0.13, 0.15, 0.025, std(0xb8bcc4, 0.35, 0.6), rng.range(-9.6, -4.2), 1.02, -13.7 + rng.range(-0.25, 0.25), g, 12);
      else box(0.3, 0.03, 0.2, std(0x8a8d94, 0.4, 0.8), rng.range(-9.6, -4.2), 1.02, -13.7 + rng.range(-0.25, 0.25), g, rng.next());
    }
    const counterL = pointLight(0xe8ffd0, 14, 8, -6.8, 2.3, -13, g);
    fx.pulseLight(counterL, 14, 2, 0.35, 7);

    // hanging lamps over EVERY table pair — the galley is the bright room
    const mkLamp = (lx: number, lz: number, phase: number) => {
      const lampArm = new THREE.Group();
      lampArm.position.set(lx, 2.6, lz);
      g.add(lampArm);
      cylinder(0.02, 0.02, 0.9, std(0x1c1c20, 0.6, 0.6), 0, -0.45, 0, lampArm);
      const shade = cylinder(0.3, 0.42, 0.22, std(0x33363c, 0.5, 0.7), 0, -0.95, 0, lampArm);
      const bulb = new THREE.MeshBasicMaterial({ color: 0xe8ffd0 });
      box(0.12, 0.08, 0.12, bulb, 0, -1.02, 0, lampArm);
      shade.castShadow = false;
      const hl = pointLight(0xe8ffd0, 18, 9, 0, -1.1, 0, lampArm);
      fx.sway(lampArm, 0.12, 0.5 + phase * 0.11);
      fx.pulseLight(hl, 18, 3, 6 + phase);
    };
    mkLamp(-3.5, -8, 0);
    mkLamp(3.5, -8, 1);
    mkLamp(-3.5, 4, 2);
    mkLamp(3.5, 4, 3);
    // the last meal went badly
    corpse(g, rng, rng.range(-5, 5), rng.range(-9.5, -6.5), false);
    corpse(g, rng, rng.range(-7, -3), 2.5, false);
    corpse(g, rng, rng.range(2, 7), rng.range(6, 10), false);
    return { colliders, vents };
  },
};

const hydroponics: ZoneDef = {
  name: 'Гидропоника',
  doorStyle: 'crew',
  floorTex: 'tile',
  wallTex: 'panel',
  floorTint: 0x6f7a6c,
  wallTint: 0x5e6a5c,
  accent: 0x6adc4a,
  lamp: 0x9fff6a,
  fog: 0x060a05,
  fogDensity: 0.014,
  floorGloss: 0.42, // condensation-slick tile
  fogSheets: 1.8, // the misters never stopped
  decorate(g, rng, fx) {
    const colliders: Collider[] = [];
    const vents: ZoneVent[] = [];
    const glass = new THREE.MeshStandardMaterial({
      color: 0x9fb8a8, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.35,
    });
    // culture vats — something still grows in there
    for (const [vx, vz] of [[-7, -10], [7, -10], [0, -4.5], [-5, 5]]) {
      cylinder(0.75, 0.85, 0.5, std(0x3c4640, 0.55, 0.7), vx, 0.25, vz, g, 16);
      const tank = cylinder(0.65, 0.65, 1.5, glass, vx, 1.25, vz, g, 16);
      tank.castShadow = false;
      const fluidMat = new THREE.MeshBasicMaterial({ color: 0x4a9a2c, transparent: true, opacity: 0.7 });
      const fluid = cylinder(0.55, 0.55, 1.1, fluidMat, vx, 1.1, vz, g, 14);
      fluid.castShadow = false;
      fx.blink(fluidMat as unknown as THREE.MeshBasicMaterial, 0x4a9a2c, 0x2c6a1a, 0.8, vx);
      const gl = pointLight(0x5adc3a, 11, 7, vx, 1.3, vz, g);
      fx.pulseLight(gl, 11, 3, 0.8, vx);
      colliders.push({ x: vx, z: vz, r: 1.05 });
      if (rng.chance(0.5)) vents.push({ pos: new THREE.Vector3(vx, 2.1, vz), kind: 'steam', rate: 2 });
    }
    // planter troughs, overgrown with the wrong kind of growth
    const growth = std(0x2c4020, 0.95, 0.02);
    const meat = std(0x5a3535, 0.9, 0.05);
    for (const tz of [-1, 1, 8.5, 10.5]) {
      box(9, 0.5, 0.9, std(0x46504a, 0.6, 0.6), -2, 0.25, tz, g);
      for (let i = 0; i < 9; i++) {
        const bx = -6 + i * 1.0 + rng.range(-0.2, 0.2);
        box(0.4, rng.range(0.2, 0.7), 0.4, rng.chance(0.75) ? growth : meat, bx, 0.6, tz + rng.range(-0.2, 0.2), g, rng.next());
      }
      colliders.push({ x: -5.5, z: tz, r: 1.0 }, { x: -2, z: tz, r: 1.0 }, { x: 1.5, z: tz, r: 1.0 });
    }
    // drip lines
    for (const dz of [0, 9.5]) {
      for (let i = 0; i < 3; i++) {
        cylinder(0.04, 0.04, 3.2, std(0x33363c, 0.6, 0.7), -5 + i * 3.4, 2.4, dz, g).rotation.z = Math.PI / 2;
      }
    }
    // work benches against the side walls — the lab died mid-experiment
    const bench2 = std(0x4a525a, 0.45, 0.75);
    for (const side of [-1, 1]) {
      for (const bz of [-6, 2.5]) {
        const bx2 = side * (AW / 2 - 1.35);
        box(1.1, 0.8, 2.6, bench2, bx2, 0.4, bz, g);
        colliders.push({ x: bx2, z: bz, r: 1.0 });
        // science clutter: vials, cans, a logbook, a terminal still sampling
        for (let i = 0; i < 4; i++) {
          const vz = bz + rng.range(-1, 1);
          if (rng.chance(0.5)) {
            const vialM = new THREE.MeshBasicMaterial({ color: rng.pick([0x6adc4a, 0x4a9adc, 0xdcb04a]) });
            cylinder(0.045, 0.045, rng.range(0.12, 0.22), vialM, bx2 + rng.range(-0.3, 0.3), 0.88, vz, g, 8).castShadow = false;
          } else {
            cylinder(0.07, 0.07, 0.16, std(0x8a8d94, 0.4, 0.8), bx2 + rng.range(-0.3, 0.3), 0.88, vz, g, 8);
          }
        }
        box(0.34, 0.05, 0.26, std(0x5a4a32, 0.85, 0.1), bx2, 0.83, bz + rng.range(-0.9, 0.9), g, rng.next());
        laptop(g, fx, bx2, 0.8, bz + rng.range(-1.1, 1.1), side > 0 ? -Math.PI / 2 : Math.PI / 2, 0x3c8a5a);
      }
    }
    return { colliders, vents };
  },
};

const machinery = (deep: boolean): ZoneDef => ({
  name: deep ? 'Машинный ряд — Глубина' : 'Машинный ряд',
  doorStyle: 'bulkhead',
  floorTex: 'deck',
  wallTex: 'panel',
  floorTint: 0x585550, // grittier: soot-dark working deck
  wallTint: 0x4c4a44,
  accent: 0xff7b1c,
  lamp: 0xffa04a,
  fog: 0x0a0806,
  fogDensity: 0.013,
  decorate(g, rng, fx) {
    const colliders: Collider[] = [];
    const vents: ZoneVent[] = [];
    const block = texturedStd('deck', 0x565a62, 0.55, 0.75, 0.9);
    const steel = std(0x55595f, 0.35, 0.9);
    // piston engines — banks in both halves, hammering
    const bankRows: [number[], number][] = deep
      ? [[[-6.5, 0, 6.5], -10.5], [[-6.5, 6.5], 4.5]]
      : [[[-6.5, 6.5], -10.5], [[0], 4.5]];
    for (const [xs, bz] of bankRows) {
      for (const ex of xs) {
        box(2.6, 1.3, 1.6, block, ex, 0.65, bz, g);
        for (let p = 0; p < 3; p++) {
          const piston = cylinder(0.16, 0.16, 0.8, steel, ex - 0.8 + p * 0.8, 1.6, bz, g);
          fx.piston(piston, 0.22, 5 + p, p * 1.3 + ex + bz);
        }
        box(2.7, 0.14, 1.7, std(0x8a6a1c, 0.6, 0.4), ex, 1.38, bz, g);
        colliders.push({ x: ex, z: bz, r: 1.6 });
        vents.push({ pos: new THREE.Vector3(ex + 1.1, 1.2, bz + 0.2), kind: 'steam', rate: 4 });
      }
    }
    // flywheel housing between the banks
    const fwx = rng.range(-2.5, 2.5);
    box(0.6, 1.9, 1.9, block, fwx, 0.95, -3, g);
    const wheel = cylinder(0.85, 0.85, 0.2, steel, fwx + 0.42, 0.95, -3, g, 18);
    wheel.rotation.z = Math.PI / 2;
    fx.spin(wheel, 'y', deep ? 4 : 2.2);
    colliders.push({ x: fwx, z: -3, r: 1.25 });
    // overhead duct hugging the north wall — visible, never occluding
    box(AW - 5, 0.5, 1.1, std(0x2e3138, 0.65, 0.75), 0, 3.6, -AD / 2 + 1.2, g);
    cylinder(0.14, 0.14, 1.6, std(0x2e3138, 0.65, 0.75), rng.range(-6, 6), 2.8, -AD / 2 + 1.2, g);
    // heat shimmer lamps
    for (const [lx, lz] of [[-9, -7], [9, -7], [-9, 8], [9, 8]]) {
      const l = pointLight(0xff7b1c, 10, 8, lx, 1.8, lz, g);
      fx.pulseLight(l, 10, 3, 5, lx + lz);
    }
    // pipe runs clinging to both side walls, three tiers high
    const pipeM = std(0x4e4a42, 0.55, 0.8);
    for (const side of [-1, 1]) {
      const px2 = side * (AW / 2 - 0.55);
      for (const [py, pr] of [[0.8, 0.16], [1.5, 0.24], [2.2, 0.12]] as [number, number][]) {
        const run = cylinder(pr, pr, AD - 3, pipeM, px2, py, 0, g, 10);
        run.rotation.x = Math.PI / 2;
      }
      for (let i = 0; i < 4; i++) {
        const jz = -11 + i * 6.5;
        cylinder(0.1, 0.1, 1.6, pipeM, px2, 1.5, jz, g, 8);
        if (rng.chance(0.5)) vents.push({ pos: new THREE.Vector3(px2 - side * 0.4, 1.6, jz), kind: 'steam', rate: 2 });
      }
    }
    // wall control panels, still cycling their dead routines
    for (const [px3, pz3] of [[-AW / 2 + 0.6, -6], [AW / 2 - 0.6, 3]] as [number, number][]) {
      box(0.25, 1.1, 1.5, std(0x333842, 0.5, 0.7), px3, 1.3, pz3, g);
      const pm = new THREE.MeshBasicMaterial({ color: 0xffa04a });
      box(0.06, 0.5, 0.9, pm, px3 + (px3 < 0 ? 0.14 : -0.14), 1.4, pz3, g);
      fx.blink(pm, 0xffa04a, 0x2a1808, rng.range(0.5, 2), px3);
    }
    // the tech's stand, terminal still logged into the dying engine
    box(0.9, 0.75, 0.6, std(0x3c4046, 0.6, 0.6), 3.5, 0.375, -6.5, g);
    laptop(g, fx, 3.5, 0.75, -6.5, Math.PI, 0x9a6a2c);
    colliders.push({ x: 3.5, z: -6.5, r: 0.7 });
    corpse(g, rng, rng.range(-4, 4), rng.range(-7, 8), true);
    return { colliders, vents };
  },
});

const coolantDucts: ZoneDef = {
  name: 'Контур охлаждения',
  doorStyle: 'containment',
  floorTex: 'deck',
  wallTex: 'panel',
  floorTint: 0x687078,
  wallTint: 0x5c646e,
  accent: 0x5a9fe8,
  lamp: 0x8ec4ff,
  fog: 0x05070c,
  fogDensity: 0.014,
  decorate(g, rng, fx) {
    const colliders: Collider[] = [];
    const vents: ZoneVent[] = [];
    const pipeMat = std(0x46525e, 0.4, 0.85);
    // floor trunk lines you have to move around
    for (const pz of [-8.5, -1, 7]) {
      const gap = rng.range(-5, 5); // a crawl-through gap in each line
      const stripMat = new THREE.MeshBasicMaterial({ color: 0x6ab8ff });
      fx.blink(stripMat, 0x6ab8ff, 0x2a4a6a, 0.5, pz);
      for (const seg of [[-12, gap - 1.6], [gap + 1.6, 12]]) {
        const cx = (seg[0] + seg[1]) / 2;
        const len = seg[1] - seg[0];
        if (len < 1) continue;
        const p = cylinder(0.45, 0.45, len, pipeMat, cx, 0.45, pz, g, 14);
        p.rotation.z = Math.PI / 2;
        // frost glow strip riding this segment only
        box(len - 0.3, 0.05, 0.08, stripMat, cx, 0.92, pz, g);
        // colliders approximated by circles along the pipe
        for (let x = seg[0] + 0.8; x < seg[1] - 0.4; x += 1.6) {
          colliders.push({ x, z: pz, r: 0.75 });
        }
      }
    }
    // wall pipe tiers — the loop wraps the whole chamber
    for (const side of [-1, 1]) {
      const px2 = side * (AW / 2 - 0.55);
      for (const [py, pr] of [[1.0, 0.2], [1.8, 0.3]] as [number, number][]) {
        const run = cylinder(pr, pr, AD - 3, pipeMat, px2, py, 0, g, 10);
        run.rotation.x = Math.PI / 2;
      }
    }
    // vertical manifolds — never in front of the exit hatch
    for (let i = 0; i < 5; i++) {
      let mx = rng.range(-9, 9);
      const mz = rng.pick([-AD / 2 + 1.2, AD / 2 - 1.2]);
      if (mz < 0 && Math.abs(mx) < 2.8) mx = Math.sign(mx || 1) * (2.8 + rng.range(0, 2));
      cylinder(0.35, 0.35, 2.6, pipeMat, mx, 1.3, mz, g, 12);
      cylinder(0.5, 0.5, 0.3, std(0x33363c, 0.5, 0.8), mx, 2.2, mz, g, 12);
      vents.push({ pos: new THREE.Vector3(mx, 1.9, mz + (mz < 0 ? 0.4 : -0.4)), kind: 'steam', rate: 5 });
    }
    // bright, cold, even — the one part of the ship still doing its job
    for (const lz of [-11, -3, 5, 12]) {
      const cl = pointLight(0x8ec8ff, 20, 14, 0, 2.6, lz, g);
      fx.pulseLight(cl, 20, 2, 0.5, lz);
    }
    return { colliders, vents };
  },
};

const reactor: ZoneDef = {
  name: 'Реакторный зал',
  doorStyle: 'containment',
  floorTex: 'deck',
  wallTex: 'panel',
  floorTint: 0x565a52,
  wallTint: 0x4c524a,
  accent: 0x8aff5a,
  lamp: 0xc0ff8a,
  fog: 0x050a04,
  fogDensity: 0.013,
  decorate(g, rng, fx) {
    const colliders: Collider[] = [];
    const vents: ZoneVent[] = [];
    // THE CORE — a pillar of sick light deep in the chamber, revealed on approach
    const cx = 0;
    const cz = -7;
    cylinder(1.5, 1.7, 0.5, std(0x3a4038, 0.5, 0.8), cx, 0.25, cz, g, 20);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xc4ffa0 });
    const core = cylinder(0.55, 0.55, 3.4, coreMat, cx, 2.2, cz, g, 16);
    core.castShadow = false;
    fx.blink(coreMat, 0xc4ffa0, 0x6ac04a, 1.1, 0);
    const cage = std(0x2e3430, 0.45, 0.85);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      box(0.18, 3.6, 0.18, cage, cx + Math.cos(a) * 1.15, 2.1, cz + Math.sin(a) * 1.15, g);
    }
    for (const ry of [1.1, 2.2, 3.3]) {
      const ring = new THREE.Mesh(torusGeo(1.18, 0.07, 8, 24), cage);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(cx, ry, cz);
      ring.castShadow = true;
      g.add(ring);
    }
    // the core OWNS this room: a green sun in a cage
    const coreLight = pointLight(0x8aff5a, 160, 30, cx, 2.4, cz, g);
    fx.pulseLight(coreLight, 160, 50, 1.1);
    const coreWash = pointLight(0x6ada3a, 24, 22, 0, 3, 3, g); // green wash reaches the entry
    fx.pulseLight(coreWash, 24, 6, 1.1, 2);
    colliders.push({ x: cx, z: cz, r: 1.85 });

    // radial floor conduits feeding the core
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      const len = rng.range(4, 7);
      const mx = cx + Math.cos(a) * (1.9 + len / 2);
      const mz = cz + Math.sin(a) * (1.9 + len / 2) * 0.6;
      if (Math.abs(mz) > 13.5 || Math.abs(mx) > 10.5) continue;
      const duct = box(len, 0.18, 0.4, std(0x3a4038, 0.5, 0.75), mx, 0.09, mz, g, -a);
      duct.receiveShadow = true;
      const glowMat = new THREE.MeshBasicMaterial({ color: 0x6adc4a });
      box(len - 0.4, 0.04, 0.1, glowMat, mx, 0.2, mz, g, -a);
      fx.blink(glowMat, 0x6adc4a, 0x2c5a1a, 1.1, i * 0.6);
    }
    // containment pylons marching down the chamber
    for (const [px, pz] of [[-7, -11], [7, -11], [-7, -3], [7, -3], [-5, 6], [5, 6]]) {
      box(0.9, 2.8, 0.9, std(0x3e443c, 0.55, 0.7), px, 1.4, pz, g);
      const warnMat = new THREE.MeshBasicMaterial({ color: 0xffc23c });
      box(0.94, 0.12, 0.94, warnMat, px, 2.5, pz, g);
      fx.blink(warnMat, 0xffc23c, 0x4a3a10, 3, px + pz);
      colliders.push({ x: px, z: pz, r: 0.85 });
    }
    // shielding blocks near the entry — cover before the core comes into view
    for (const sx of [-3.5, 3.5]) {
      box(1.8, 1.2, 1.0, std(0x3a4038, 0.5, 0.8), sx, 0.6, 10, g, rng.range(-0.2, 0.2));
      colliders.push({ x: sx, z: 10, r: 1.2 });
    }
    vents.push({ pos: new THREE.Vector3(cx, 4, cz), kind: 'steam', rate: 3 });
    return { colliders, vents };
  },
};

const controlDeck: ZoneDef = {
  name: 'Мостик',
  doorStyle: 'bulkhead',
  floorTex: 'tile',
  wallTex: 'panel',
  floorTint: 0x787e88,
  wallTint: 0x666c78,
  accent: 0x8ec4ff,
  lamp: 0xc4e0ff,
  fog: 0x06080c,
  fogDensity: 0.011,
  noCornerLights: true, // the bridge is lit by its screens and nothing else
  decorate(g, rng, fx) {
    const colliders: Collider[] = [];
    const vents: ZoneVent[] = [];
    const consoleBody = std(0x333842, 0.5, 0.7);
    const screenColors = [0x3c8a5a, 0x3c6a9a, 0x9a6a2c, 0x8a3c3c];

    // the main viewscreen — moved OFF the exit wall's door lane, still cycling
    const bigScreenMat = new THREE.MeshBasicMaterial({ color: 0x16303c });
    box(7, 2.4, 0.15, bigScreenMat, -7, 1.8, -AD / 2 + 0.55, g);
    fx.blink(bigScreenMat, 0x1e4a5c, 0x0a1418, 0.23, 0);
    box(7.4, 0.2, 0.3, consoleBody, -7, 3.1, -AD / 2 + 0.55, g);
    const screenGlow = pointLight(0x3c6a9a, 14, 12, -7, 1.8, -AD / 2 + 2, g);
    fx.pulseLight(screenGlow, 14, 5, 0.23);

    // horseshoe of console banks — the ship's brain, pulled toward the middle
    // of the deck so the exit reads clean behind it
    const bankDefs: [number, number, number, number][] = [
      [-4.5, -9.2, 3.2, 0.35], [4.5, -9.2, 3.2, -0.35], [0, -8.2, 4.4, 0],
    ];
    for (const [bx, bz, bw, bry] of bankDefs) {
      box(bw, 0.85, 0.9, consoleBody, bx, 0.42, bz, g, bry);
      const top = box(bw, 0.5, 0.14, consoleBody, bx, 1.1, bz - 0.3, g, bry);
      top.rotation.x = -0.35;
      const nScreens = Math.floor(bw / 0.8);
      for (let i = 0; i < nScreens; i++) {
        const sm = new THREE.MeshBasicMaterial({ color: rng.pick(screenColors) });
        const scr = box(0.55, 0.34, 0.03, sm, bx - bw / 2 + 0.5 + i * 0.8, 1.12, bz - 0.22, g, bry);
        scr.rotation.x = -0.35;
        fx.blink(sm, rng.pick(screenColors), 0x0a0e12, rng.range(0.15, 4), i * 2 + bx);
      }
      colliders.push({ x: bx, z: bz, r: bw / 2 * 0.75 });
    }
    // freestanding plot table — mid-room cover
    box(2.2, 0.75, 1.4, consoleBody, 0, 0.375, -4, g);
    const holoMat = new THREE.MeshBasicMaterial({ color: 0x5adc9a, transparent: true, opacity: 0.5 });
    const holo = box(1.4, 0.5, 0.9, holoMat, 0, 1.15, -4, g);
    holo.castShadow = false;
    fx.blink(holoMat, 0x5adc9a, 0x1a4a30, 1.7, 1);
    colliders.push({ x: 0, z: -4, r: 1.35 });

    // auxiliary console islands in the entry half
    for (const sx of [-4.5, 4.5]) {
      box(1.7, 0.85, 0.95, consoleBody, sx, 0.42, 5, g, sx > 0 ? -0.25 : 0.25);
      const sm = new THREE.MeshBasicMaterial({ color: rng.pick(screenColors) });
      const scr = box(0.6, 0.36, 0.04, sm, sx, 1.06, 4.75, g, sx > 0 ? -0.25 : 0.25);
      scr.rotation.x = -0.35;
      fx.blink(sm, rng.pick(screenColors), 0x0a0e12, rng.range(0.3, 3), sx);
      colliders.push({ x: sx, z: 5, r: 1.05 });
    }

    // indicator strips along both side walls — hundreds of tiny lights
    for (const side of [-1, 1]) {
      for (let i = 0; i < 12; i++) {
        const im = new THREE.MeshBasicMaterial({ color: rng.pick(screenColors) });
        box(0.14, 0.1, 0.1, im, side * (AW / 2 - 0.55), 1.3 + (i % 3) * 0.35, -13 + Math.floor(i / 3) * 6.5, g);
        fx.blink(im, rng.pick(screenColors), 0x0a0e12, rng.range(0.4, 6), i * 1.7 + side);
      }
    }
    // more stations mid-deck — the bridge is dense with dead iron
    for (const side of [-1, 1]) {
      box(1.7, 0.85, 0.95, consoleBody, side * 7.5, 0.42, -1, g, side * 0.5);
      const sm2 = new THREE.MeshBasicMaterial({ color: rng.pick(screenColors) });
      const scr2 = box(0.6, 0.36, 0.04, sm2, side * 7.5, 1.06, -1.25, g, side * 0.5);
      scr2.rotation.x = -0.35;
      fx.blink(sm2, rng.pick(screenColors), 0x0a0e12, rng.range(0.3, 3), side * 3);
      colliders.push({ x: side * 7.5, z: -1, r: 1.05 });
      chair(g, side * 7.5, 0.4, side * -0.5 + Math.PI);
    }
    // the watch's chairs, shoved back the moment it all went wrong
    for (const [chx, chz, chr] of [[-4.2, -7.4, 0.4], [0, -6.7, 0], [4.2, -7.4, -0.4], [-4.5, 6.3, 0.2], [4.5, 6.3, -0.2]] as [number, number, number][]) {
      chair(g, chx, chz, chr);
    }
    // no ceiling lights survive here — the SCREENS light the room
    for (const [gx, gz, gc] of [[-4.5, -9.4, 0x3c8a5a], [4.5, -9.4, 0x3c6a9a], [0, -4, 0x5adc9a], [4.5, 4.6, 0x9a6a2c], [-4.5, 4.6, 0x8a3c3c]] as [number, number, number][]) {
      const gl2 = pointLight(gc, 10, 9, gx, 1.5, gz, g);
      fx.pulseLight(gl2, 10, 4, rng.range(1.5, 4), gx + gz);
    }
    corpse(g, rng, rng.range(-3, 3), rng.range(-7, -6), true); // the watch officer
    return { colliders, vents };
  },
};

const fireControl: ZoneDef = {
  name: 'Пост огня',
  doorStyle: 'blast',
  floorTex: 'deck',
  wallTex: 'panel',
  floorTint: 0x6e6862,
  wallTint: 0x605a56,
  accent: 0xe84a2a,
  lamp: 0xff7a52,
  fog: 0x0a0605,
  fogDensity: 0.012,
  decorate(g, rng, fx) {
    const colliders: Collider[] = [];
    const vents: ZoneVent[] = [];
    const explosives: NonNullable<RoomBuild['explosives']> = [];
    const tubeMat = texturedStd('deck', 0x4e525a, 0.45, 0.85, 0.9);
    const shellMat = std(0x5c4a22, 0.5, 0.75);
    // torpedo tubes raked against the north wall
    for (let i = 0; i < 3; i++) {
      const tx = -5 + i * 5;
      const tube = cylinder(0.55, 0.6, 3.6, tubeMat, tx, 1.5, -13.1, g, 14);
      tube.rotation.x = -1.1;
      box(1.4, 0.8, 1.2, std(0x33363c, 0.55, 0.7), tx, 0.4, -12.4, g);
      colliders.push({ x: tx, z: -12.4, r: 1.1 });
      const wm = new THREE.MeshBasicMaterial({ color: 0xff3020 });
      box(0.16, 0.1, 0.1, wm, tx + 0.5, 0.9, -11.9, g);
      fx.blink(wm, 0xff3020, 0x2a0808, 1.4, tx);
    }
    // shell racks — ordnance stacked in both halves. The near racks are LIVE:
    // one stray bolt and the whole pile goes up
    for (const [rx, rz] of [[-6, -5], [6, -5], [-6, 6], [6, 6]]) {
      const live = rz > 0;
      const rackG = new THREE.Group();
      rackG.position.set(rx, 0, rz);
      g.add(rackG);
      box(2.8, 0.2, 1.2, tubeMat, 0, 0.1, 0, rackG);
      for (let s = 0; s < 3; s++) {
        for (let h = 0; h < 2 - (s % 2); h++) {
          const shell = cylinder(0.22, 0.22, 2.4, shellMat, 0, 0.35 + h * 0.5 + (s % 2) * 0.25, -0.8 + s * 0.75, rackG, 12);
          shell.rotation.z = Math.PI / 2;
        }
      }
      if (live) {
        const wm2 = new THREE.MeshBasicMaterial({ color: 0xff3020 });
        box(0.5, 0.12, 0.06, wm2, 0, 0.62, 0.64, rackG);
        fx.blink(wm2, 0xff3020, 0x2a0808, 2.2, rx);
        explosives.push({ x: rx, z: rz, r: 1.2, mesh: rackG });
      } else {
        colliders.push({ x: rx, z: rz, r: 1.5 });
      }
    }
    // targeting console island near the entry
    box(1.6, 0.9, 1.0, std(0x333842, 0.5, 0.7), 0, 0.45, 9.5, g);
    const tm = new THREE.MeshBasicMaterial({ color: 0x8a3c3c });
    box(1.0, 0.4, 0.05, tm, 0, 1.15, 9.25, g).rotation.x = -0.4;
    fx.blink(tm, 0xc84a3c, 0x200a08, 0.6, 0);
    colliders.push({ x: 0, z: 9.5, r: 1.05 });
    // launch-warning strobes sweep the room
    for (const [sx, sz] of [[-9.5, -8], [9.5, -8], [-9.5, 5], [9.5, 5]]) {
      const l = pointLight(0xff3020, 0, 10, sx, 2.2, sz, g);
      fx.pulseLight(l, 6, 6, 1.4, sx + sz);
    }
    corpse(g, rng, rng.range(-3, 3), rng.range(0, 3), true);
    return { colliders, vents, explosives };
  },
};

const foundry: ZoneDef = {
  name: 'Литейный док',
  doorStyle: 'blast',
  floorTex: 'deck',
  wallTex: 'panel',
  floorTint: 0x5e564e,
  wallTint: 0x544e48,
  accent: 0xff5a14,
  lamp: 0xff8a4a,
  fog: 0x120704,
  fogDensity: 0.014,
  decorate(g, _rng, fx) {
    const colliders: Collider[] = []; // boss arena stays clear — the Foreman needs charge lanes
    const vents: ZoneVent[] = [];
    // slag channels along the east/west edges, glowing like open veins
    for (const side of [-1, 1]) {
      const sx = side * (AW / 2 - 0.9);
      box(1.2, 0.1, AD - 2, std(0x2a2622, 0.7, 0.5), sx, 0.05, 0, g);
      const slagMat = new THREE.MeshBasicMaterial({ color: 0xff6a1c });
      const slag = box(0.7, 0.06, AD - 2.6, slagMat, sx, 0.11, 0, g);
      slag.castShadow = false;
      fx.blink(slagMat, 0xff7a24, 0xa03408, 0.7, side);
      const sl = pointLight(0xff5a14, 20, 10, sx, 0.8, 0, g);
      fx.pulseLight(sl, 20, 6, 0.7, side);
      vents.push({ pos: new THREE.Vector3(sx, 0.3, -8), kind: 'fire', rate: 3 });
      vents.push({ pos: new THREE.Vector3(sx, 0.3, 0), kind: 'fire', rate: 3 });
      vents.push({ pos: new THREE.Vector3(sx, 0.3, 8), kind: 'fire', rate: 3 });
    }
    // the Foreman's gantry crane, idle above the kill floor
    const steel = std(0x4a4436, 0.5, 0.8);
    box(0.6, 4.6, 0.6, steel, -10.8, 2.3, -13.5, g);
    box(0.6, 4.6, 0.6, steel, 10.8, 2.3, -13.5, g);
    box(22, 0.6, 0.8, steel, 0, 4.6, -13.5, g);
    const chainHook = new THREE.Group();
    chainHook.position.set(3, 4.3, -13.5);
    g.add(chainHook);
    cylinder(0.04, 0.04, 1.8, std(0x1c1c20, 0.6, 0.6), 0, -0.9, 0, chainHook);
    const grabbed = box(0.8, 0.6, 0.6, std(0x3a3d45, 0.6, 0.6), 0, -2.0, 0, chainHook); // something armored, hanging
    grabbed.rotation.z = 0.3;
    fx.sway(chainHook, 0.1, 0.5);
    // crucibles at the far corners (outside the play bounds, glowing)
    for (const cxx of [-10.5, 10.5]) {
      cylinder(0.9, 1.1, 1.4, std(0x33302c, 0.6, 0.6), cxx, 0.7, -13.9, g, 14);
      const meltMat = new THREE.MeshBasicMaterial({ color: 0xffa24a });
      const melt = cylinder(0.75, 0.75, 0.1, meltMat, cxx, 1.42, -13.9, g, 14);
      melt.castShadow = false;
      fx.blink(meltMat, 0xffa24a, 0xc04a10, 0.9, cxx);
      vents.push({ pos: new THREE.Vector3(cxx, 1.6, -13.9), kind: 'fire', rate: 6 });
    }
    return { colliders, vents };
  },
};

// room 1..15 → zone
const ROOM_ZONES: ZoneDef[] = [
  crashSite(false), // 1
  crashSite(true), // 2
  hullBreach, // 3
  cargoHold, // 4
  cargoHold, // 5 (elite)
  quarters, // 6
  messHall, // 7
  hydroponics, // 8
  machinery(false), // 9
  machinery(true), // 10 (elite)
  coolantDucts, // 11
  reactor, // 12
  controlDeck, // 13
  fireControl, // 14
  foundry, // 15 (boss)
];

export function zoneForRoom(room: number): ZoneDef {
  return ROOM_ZONES[Math.min(ROOM_ZONES.length, Math.max(1, room)) - 1];
}

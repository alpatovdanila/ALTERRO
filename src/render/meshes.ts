import * as THREE from 'three';
import { boxGeo, cylGeo, sphereGeo } from './geocache';
import type { EnemyDef } from '../data/enemies';

// Primitive-composite character builders, v2: articulated rigs (limbs on pivot
// groups so they can swing), mixed box/cylinder silhouettes, greeble detail.
// Still no asset files — geometry is the art style, detail is the fidelity.

export interface AnimRig {
  legL?: THREE.Object3D;
  legR?: THREE.Object3D;
  legL2?: THREE.Object3D; // rear pair for quadrupeds
  legR2?: THREE.Object3D;
  armL?: THREE.Object3D;
  armR?: THREE.Object3D;
  torso?: THREE.Object3D;
  head?: THREE.Object3D;
  gun?: THREE.Object3D;
  /** turret cannon / antenna / pistons — behavior-specific animated bit */
  extra?: THREE.Object3D;
}

export interface BuiltMesh {
  root: THREE.Group;
  flashMats: THREE.MeshStandardMaterial[];
  eyeMats: THREE.MeshBasicMaterial[];
  rig: AnimRig;
}

function std(color: number, rough = 0.8, metal = 0.35): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
  // readability lift: bodies carry a whisper of self-light so they never
  // fall into full silhouette against the dark decks
  m.emissive.set(color).multiplyScalar(0.14);
  return m;
}

function box(
  w: number, h: number, d: number,
  mat: THREE.Material,
  x: number, y: number, z: number,
  parent: THREE.Object3D,
): THREE.Mesh {
  const m = new THREE.Mesh(boxGeo(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

function cyl(
  rTop: number, rBot: number, h: number,
  mat: THREE.Material,
  x: number, y: number, z: number,
  parent: THREE.Object3D,
  segs = 10,
): THREE.Mesh {
  const m = new THREE.Mesh(cylGeo(rTop, rBot, h, segs), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

/** dynamic objects don't render into the (baked) shadow map */
export function disableCastShadows(root: THREE.Object3D) {
  root.traverse((o) => {
    (o as THREE.Mesh).castShadow = false;
  });
}

// one shared blob-shadow resource set — grounds characters on the deck
const shadowGeo = new THREE.CircleGeometry(1, 16).rotateX(-Math.PI / 2);
const shadowMat = new THREE.MeshBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0.38,
  depthWrite: false,
  fog: false,
});

function blobShadow(radius: number, parent: THREE.Object3D) {
  const m = new THREE.Mesh(shadowGeo, shadowMat);
  m.scale.setScalar(radius);
  m.position.y = 0.025;
  m.renderOrder = 2;
  parent.add(m);
}

/** pivot group at the joint; the limb geometry hangs below it */
function limb(
  mat: THREE.Material,
  r: number, len: number,
  x: number, y: number, z: number,
  parent: THREE.Object3D,
): THREE.Group {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  parent.add(pivot);
  cyl(r, r * 0.82, len, mat, 0, -len / 2, 0, pivot);
  return pivot;
}

// ---------------------------------------------------------------- player
export function buildPlayer(
  relicColor: number,
  trait?: 'runandgun' | 'twinbarrel',
  accent = 0x7a6428,
): BuiltMesh & { relicMat: THREE.MeshBasicMaterial } {
  const root = new THREE.Group();
  const rig: AnimRig = {};
  const armor = std(0x3d4049, 0.55, 0.7);
  const dark = std(0x22242a, 0.7, 0.55);
  // the relic dictates the livery: belt, pauldron plates, emblem, sight rail
  const trim = std(accent, 0.45, 0.85);
  const bone = std(0xcfc5ae, 0.9, 0.05);

  // legs on pivots + armored boots
  rig.legL = limb(dark, 0.11, 0.42, -0.17, 0.56, 0, root);
  rig.legR = limb(dark, 0.11, 0.42, 0.17, 0.56, 0, root);
  box(0.2, 0.14, 0.3, armor, 0, -0.36, 0.04, rig.legL);
  box(0.2, 0.14, 0.3, armor, 0, -0.36, 0.04, rig.legR);
  box(0.18, 0.16, 0.2, armor, 0, -0.16, 0.02, rig.legL); // greave
  box(0.18, 0.16, 0.2, armor, 0, -0.16, 0.02, rig.legR);

  box(0.42, 0.18, 0.32, dark, 0, 0.6, 0, root); // pelvis
  box(0.44, 0.08, 0.34, trim, 0, 0.68, 0, root); // belt

  // torso group (can pitch)
  const torso = new THREE.Group();
  torso.position.y = 0.72;
  root.add(torso);
  rig.torso = torso;
  box(0.62, 0.52, 0.42, armor, 0, 0.26, 0, torso);
  box(0.4, 0.34, 0.06, dark, 0, 0.28, 0.22, torso); // chest plate inset
  box(0.12, 0.12, 0.04, trim, 0, 0.34, 0.26, torso); // aquila-ish emblem
  // layered pauldrons — a hair deeper than the torso (0.42): sharing its
  // exact front/back planes was a shoulder-seam z-fight
  for (const sx of [-1, 1]) {
    box(0.4, 0.3, 0.45, armor, sx * 0.48, 0.44, 0, torso);
    box(0.42, 0.1, 0.47, trim, sx * 0.48, 0.6, 0, torso);
    box(0.34, 0.16, 0.36, dark, sx * 0.44, 0.28, 0, torso);
  }
  // arms angled forward to the bolter
  rig.armL = limb(dark, 0.09, 0.34, -0.48, 0.34, 0.06, torso);
  rig.armR = limb(dark, 0.09, 0.34, 0.48, 0.34, 0.06, torso);
  rig.armL.rotation.x = -0.9;
  rig.armR.rotation.x = -0.9;
  box(0.16, 0.14, 0.16, armor, 0, -0.34, 0, rig.armL); // gauntlets
  box(0.16, 0.14, 0.16, armor, 0, -0.34, 0, rig.armR);

  // the bolter — two-handed, front and center
  const gun = new THREE.Group();
  gun.position.set(0.02, 0.22, 0.42);
  torso.add(gun);
  rig.gun = gun;
  box(0.2, 0.24, 0.62, dark, 0, 0, 0, gun); // receiver
  if (trait === 'twinbarrel') {
    // the Two Barrels doctrine, worn on the weapon itself
    cyl(0.048, 0.048, 0.34, armor, -0.06, 0.03, 0.46, gun).rotation.x = Math.PI / 2;
    cyl(0.048, 0.048, 0.34, armor, 0.06, 0.03, 0.46, gun).rotation.x = Math.PI / 2;
    box(0.2, 0.1, 0.1, armor, 0, 0.02, 0.62, gun); // wide twin brake
  } else {
    cyl(0.055, 0.055, 0.34, armor, 0, 0.03, 0.46, gun).rotation.x = Math.PI / 2; // barrel
    box(0.08, 0.1, 0.1, armor, 0, 0.02, 0.62, gun); // muzzle brake
  }
  if (trait === 'runandgun') {
    // stride servos bolted to the greaves — fire on the move
    box(0.09, 0.22, 0.13, trim, 0.14, -0.12, -0.05, rig.legL);
    box(0.09, 0.22, 0.13, trim, -0.14, -0.12, -0.05, rig.legR);
  }
  box(0.08, 0.2, 0.16, armor, 0, -0.2, -0.06, gun); // magazine
  box(0.05, 0.07, 0.2, trim, 0, 0.16, 0.1, gun); // sight rail

  // head
  const head = new THREE.Group();
  head.position.y = 1.32;
  root.add(head);
  rig.head = head;
  box(0.26, 0.24, 0.28, dark, 0, 0, 0.02, head);
  const visor = new THREE.MeshBasicMaterial({ color: 0xff3020 });
  // proud of the faceplate — its back plane on the helmet face flickered
  box(0.2, 0.05, 0.03, visor, 0, 0.02, 0.185, head);
  box(0.12, 0.08, 0.03, armor, 0, -0.08, 0.16, head); // rebreather
  box(0.3, 0.06, 0.3, armor, 0, 0.14, 0, head); // brow ridge

  // backpack: reactor, relic, exhaust stacks (clear of the torso's back plane)
  box(0.44, 0.5, 0.26, dark, 0, 1.0, -0.355, root);
  const relicMat = new THREE.MeshBasicMaterial({ color: relicColor, transparent: true, opacity: 0.25 });
  box(0.22, 0.32, 0.08, relicMat, 0, 1.02, -0.5, root);
  cyl(0.05, 0.06, 0.3, dark, -0.16, 1.34, -0.36, root);
  cyl(0.05, 0.06, 0.3, dark, 0.16, 1.34, -0.36, root);
  // purity seals + trophy bone
  box(0.07, 0.16, 0.02, bone, -0.22, 0.86, 0.23, root);
  box(0.06, 0.12, 0.02, bone, 0.26, 0.72, 0.23, root);
  box(0.05, 0.05, 0.18, bone, -0.5, 0.62, 0.1, root);
  blobShadow(0.62, root);
  disableCastShadows(root); // movers use blob shadows; the key light's map is baked

  return { root, flashMats: [armor, dark, trim], eyeMats: [visor], rig, relicMat };
}

// ---------------------------------------------------------------- enemies
export function buildEnemy(def: EnemyDef): BuiltMesh {
  const root = new THREE.Group();
  const rig: AnimRig = {};
  const body = std(def.bodyColor, 0.75, 0.35);
  // putrid green flesh — the Grafted must never vanish into blood-soaked decks
  const flesh = std(0x8aa04e, 0.95, 0.02);
  const fleshDark = std(0x556e38, 0.98, 0.02);
  const eye = new THREE.MeshBasicMaterial({ color: def.eyeColor });
  const s = def.scale;
  blobShadow(def.radius * 1.55, root);

  switch (def.behavior) {
    case 'melee': {
      // grafted husk — fused crewman, one arm still machine
      rig.legL = limb(fleshDark, 0.07 * s, 0.4 * s, -0.14 * s, 0.42 * s, 0, root);
      rig.legR = limb(body, 0.07 * s, 0.4 * s, 0.14 * s, 0.42 * s, 0, root);
      const torso = new THREE.Group();
      torso.position.y = 0.48 * s;
      torso.rotation.x = 0.38;
      root.add(torso);
      rig.torso = torso;
      box(0.46 * s, 0.5 * s, 0.32 * s, body, 0, 0.22 * s, 0, torso);
      box(0.3 * s, 0.34 * s, 0.3 * s, flesh, 0.09 * s, 0.2 * s, 0.06 * s, torso); // grafted mass
      for (let i = 0; i < 3; i++) {
        box(0.05 * s, 0.12 * s, 0.05 * s, bone(), -0.1 * s + i * 0.1 * s, 0.5 * s, -0.14 * s, torso); // spine spurs
      }
      const head = new THREE.Group();
      head.position.set(0, 0.52 * s, 0.14 * s);
      torso.add(head);
      rig.head = head;
      box(0.2 * s, 0.2 * s, 0.22 * s, fleshDark, 0, 0, 0, head);
      box(0.16 * s, 0.06 * s, 0.06 * s, body, 0, -0.1 * s, 0.08 * s, head); // jaw clamp
      box(0.07 * s, 0.05 * s, 0.02, eye, -0.04 * s, 0.02 * s, 0.12 * s, head);
      box(0.05 * s, 0.04 * s, 0.02, eye, 0.06 * s, -0.01 * s, 0.12 * s, head); // uneven
      rig.armL = limb(flesh, 0.06 * s, 0.52 * s, -0.28 * s, 0.4 * s, 0.06 * s, torso);
      rig.armR = limb(body, 0.07 * s, 0.44 * s, 0.28 * s, 0.4 * s, 0.06 * s, torso);
      box(0.12 * s, 0.14 * s, 0.1 * s, fleshDark, 0, -0.56 * s, 0.02 * s, rig.armL); // claw mass
      box(0.11 * s, 0.1 * s, 0.12 * s, std(0x33363c, 0.5, 0.8), 0, -0.48 * s, 0.02 * s, rig.armR); // tool fist
      disableCastShadows(root);
      return { root, flashMats: [body, flesh, fleshDark], eyeMats: [eye], rig };
    }
    case 'swarm': {
      // vent crawler — a torso on four scuttling legs, dragging entrails
      const torso = new THREE.Group();
      torso.position.y = 0.26 * s;
      root.add(torso);
      rig.torso = torso;
      const t = box(0.46 * s, 0.24 * s, 0.66 * s, flesh, 0, 0, 0, torso);
      t.rotation.z = 0.08;
      box(0.3 * s, 0.14 * s, 0.3 * s, fleshDark, 0, 0.14 * s, -0.1 * s, torso);
      const head = new THREE.Group();
      head.position.set(0, 0.08 * s, 0.34 * s);
      torso.add(head);
      rig.head = head;
      box(0.2 * s, 0.16 * s, 0.18 * s, body, 0, 0, 0, head);
      box(0.1 * s, 0.04 * s, 0.02, eye, 0, 0.02 * s, 0.1 * s, head);
      rig.legL = limb(body, 0.035 * s, 0.26 * s, -0.24 * s, 0.2 * s, 0.2 * s, root);
      rig.legR = limb(body, 0.035 * s, 0.26 * s, 0.24 * s, 0.2 * s, 0.2 * s, root);
      rig.legL2 = limb(body, 0.035 * s, 0.26 * s, -0.24 * s, 0.2 * s, -0.18 * s, root);
      rig.legR2 = limb(body, 0.035 * s, 0.26 * s, 0.24 * s, 0.2 * s, -0.18 * s, root);
      box(0.08 * s, 0.06 * s, 0.3 * s, fleshDark, 0, 0.06 * s, -0.48 * s, root); // dragged entrail
      box(0.06 * s, 0.05 * s, 0.2 * s, flesh, 0.04 * s, 0.04 * s, -0.72 * s, root);
      disableCastShadows(root);
      return { root, flashMats: [body, flesh, fleshDark], eyeMats: [eye], rig };
    }
    case 'ranged': {
      // bile spitter — distended glowing gut, siphon head
      rig.legL = limb(body, 0.06 * s, 0.34 * s, -0.12 * s, 0.36 * s, 0, root);
      rig.legR = limb(body, 0.06 * s, 0.34 * s, 0.12 * s, 0.36 * s, 0, root);
      const torso = new THREE.Group();
      torso.position.y = 0.4 * s;
      root.add(torso);
      rig.torso = torso;
      box(0.38 * s, 0.6 * s, 0.3 * s, body, 0, 0.3 * s, 0, torso);
      const sacMat = new THREE.MeshBasicMaterial({ color: 0x86c22c });
      const sac = new THREE.Mesh(sphereGeo(0.2 * s, 12, 10), sacMat);
      sac.position.set(0, 0.18 * s, 0.14 * s);
      torso.add(sac);
      root.userData.sac = sac;
      // feeder tubes into the sac
      cyl(0.035 * s, 0.035 * s, 0.3 * s, flesh, -0.14 * s, 0.4 * s, 0.12 * s, torso).rotation.z = 0.7;
      cyl(0.035 * s, 0.035 * s, 0.3 * s, flesh, 0.14 * s, 0.4 * s, 0.12 * s, torso).rotation.z = -0.7;
      const head = new THREE.Group();
      head.position.set(0, 0.66 * s, 0.06 * s);
      torso.add(head);
      rig.head = head;
      cyl(0.05 * s, 0.09 * s, 0.26 * s, fleshDark, 0, 0.04 * s, 0.1 * s, head).rotation.x = 1.1; // siphon
      box(0.06 * s, 0.05 * s, 0.02, eye, -0.07 * s, 0.06 * s, 0.1 * s, head);
      box(0.06 * s, 0.05 * s, 0.02, eye, 0.07 * s, 0.06 * s, 0.1 * s, head);
      disableCastShadows(root);
      return { root, flashMats: [body, flesh, fleshDark], eyeMats: [eye], rig };
    }
    case 'turret': {
      // mortar polyp — rooted flesh cannon, does not move, hits like a bell
      cyl(0.5 * s, 0.62 * s, 0.24 * s, fleshDark, 0, 0.12 * s, 0, root, 14); // base mound
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const r = cyl(0.05 * s, 0.08 * s, 0.5 * s, flesh, Math.cos(a) * 0.5 * s, 0.06 * s, Math.sin(a) * 0.5 * s, root);
        r.rotation.z = Math.cos(a) * 1.25;
        r.rotation.x = -Math.sin(a) * 1.25; // roots splaying into the deck
      }
      cyl(0.16 * s, 0.24 * s, 0.5 * s, flesh, 0, 0.45 * s, 0, root, 12); // stalk
      const eyeG = new THREE.Group();
      eyeG.position.y = 0.78 * s;
      root.add(eyeG);
      rig.extra = eyeG;
      const socket = new THREE.Mesh(sphereGeo(0.22 * s, 14, 12), body);
      socket.castShadow = true;
      eyeG.add(socket);
      cyl(0.09 * s, 0.11 * s, 0.34 * s, std(0x3a3d34, 0.5, 0.7), 0, 0.02 * s, 0.24 * s, eyeG).rotation.x = Math.PI / 2; // grafted barrel
      const iris = new THREE.Mesh(sphereGeo(0.07 * s, 10, 8), eye);
      iris.position.set(0, 0.02 * s, 0.42 * s);
      eyeG.add(iris);
      disableCastShadows(root);
      return { root, flashMats: [body, flesh, fleshDark], eyeMats: [eye], rig };
    }
    case 'shocker': {
      // conduit wretch — skeletal, a lightning rod grafted to its spine
      rig.legL = limb(fleshDark, 0.05 * s, 0.42 * s, -0.1 * s, 0.44 * s, 0, root);
      rig.legR = limb(fleshDark, 0.05 * s, 0.42 * s, 0.1 * s, 0.44 * s, 0, root);
      const torso = new THREE.Group();
      torso.position.y = 0.48 * s;
      root.add(torso);
      rig.torso = torso;
      box(0.3 * s, 0.44 * s, 0.2 * s, flesh, 0, 0.2 * s, 0, torso);
      for (let i = 0; i < 3; i++) box(0.32 * s, 0.03 * s, 0.22 * s, bone(), 0, 0.1 * s + i * 0.12 * s, 0, torso); // rib bands
      const head = new THREE.Group();
      head.position.set(0, 0.5 * s, 0.04 * s);
      torso.add(head);
      rig.head = head;
      box(0.16 * s, 0.18 * s, 0.16 * s, fleshDark, 0, 0, 0, head);
      box(0.1 * s, 0.03 * s, 0.02, eye, 0, 0.02 * s, 0.09 * s, head);
      // the mast
      const mast = new THREE.Group();
      mast.position.set(0, 0.42 * s, -0.14 * s);
      torso.add(mast);
      rig.extra = mast;
      cyl(0.025 * s, 0.035 * s, 0.6 * s, std(0x44484f, 0.4, 0.9), 0, 0.3 * s, 0, mast);
      const tip = new THREE.Mesh(sphereGeo(0.06 * s, 8, 8), eye);
      tip.position.y = 0.64 * s;
      mast.add(tip);
      // prong arms
      rig.armL = limb(fleshDark, 0.04 * s, 0.36 * s, -0.18 * s, 0.36 * s, 0.04 * s, torso);
      rig.armR = limb(fleshDark, 0.04 * s, 0.36 * s, 0.18 * s, 0.36 * s, 0.04 * s, torso);
      box(0.03 * s, 0.14 * s, 0.03 * s, eye, 0, -0.42 * s, 0, rig.armL);
      box(0.03 * s, 0.14 * s, 0.03 * s, eye, 0, -0.42 * s, 0, rig.armR);
      disableCastShadows(root);
      return { root, flashMats: [flesh, fleshDark], eyeMats: [eye], rig };
    }
    case 'charger': {
      // hull ram — a battering wedge that used to be a cargo loader and a man
      rig.legL = limb(body, 0.07 * s, 0.3 * s, -0.2 * s, 0.32 * s, 0.18 * s, root);
      rig.legR = limb(body, 0.07 * s, 0.3 * s, 0.2 * s, 0.32 * s, 0.18 * s, root);
      rig.legL2 = limb(fleshDark, 0.07 * s, 0.3 * s, -0.2 * s, 0.32 * s, -0.16 * s, root);
      rig.legR2 = limb(fleshDark, 0.07 * s, 0.3 * s, 0.2 * s, 0.32 * s, -0.16 * s, root);
      const torso = new THREE.Group();
      torso.position.y = 0.42 * s;
      root.add(torso);
      rig.torso = torso;
      box(0.5 * s, 0.36 * s, 0.7 * s, body, 0, 0.1 * s, -0.05 * s, torso);
      box(0.34 * s, 0.26 * s, 0.3 * s, flesh, 0, 0.28 * s, -0.2 * s, torso); // hunched meat
      // the wedge
      const wedge = box(0.56 * s, 0.44 * s, 0.16 * s, std(0x4a4038, 0.45, 0.8), 0, 0.06 * s, 0.4 * s, torso);
      wedge.rotation.x = -0.3;
      box(0.58 * s, 0.06 * s, 0.18 * s, std(0x8a6a1c, 0.6, 0.4), 0, 0.26 * s, 0.36 * s, torso); // hazard lip
      const head = new THREE.Group();
      head.position.set(0, 0.3 * s, 0.28 * s);
      torso.add(head);
      rig.head = head;
      box(0.14 * s, 0.12 * s, 0.12 * s, fleshDark, 0, 0, 0, head);
      box(0.05 * s, 0.04 * s, 0.02, eye, -0.03 * s, 0.01 * s, 0.07 * s, head);
      box(0.05 * s, 0.04 * s, 0.02, eye, 0.04 * s, 0.01 * s, 0.07 * s, head);
      // back pistons
      const pistons = new THREE.Group();
      pistons.position.set(0, 0.3 * s, -0.3 * s);
      torso.add(pistons);
      rig.extra = pistons;
      cyl(0.05 * s, 0.05 * s, 0.24 * s, std(0x55595f, 0.4, 0.9), -0.14 * s, 0, 0, pistons);
      cyl(0.05 * s, 0.05 * s, 0.24 * s, std(0x55595f, 0.4, 0.9), 0.14 * s, 0, 0, pistons);
      disableCastShadows(root);
      return { root, flashMats: [body, flesh, fleshDark], eyeMats: [eye], rig };
    }
    case 'elite': {
      // bulkhead bulwark — drags a ship's door as a shield
      rig.legL = limb(body, 0.1 * s, 0.34 * s, -0.18 * s, 0.36 * s, 0, root);
      rig.legR = limb(body, 0.1 * s, 0.34 * s, 0.18 * s, 0.36 * s, 0, root);
      const torso = new THREE.Group();
      torso.position.y = 0.42 * s;
      root.add(torso);
      rig.torso = torso;
      box(0.56 * s, 0.64 * s, 0.42 * s, body, 0, 0.3 * s, -0.06 * s, torso);
      box(0.36 * s, 0.4 * s, 0.32 * s, flesh, 0.1 * s, 0.24 * s, 0.04 * s, torso);
      const head = new THREE.Group();
      head.position.set(0, 0.72 * s, 0.04 * s);
      torso.add(head);
      rig.head = head;
      box(0.24 * s, 0.22 * s, 0.24 * s, body, 0, 0, 0, head);
      box(0.08 * s, 0.06 * s, 0.02, eye, 0, 0.01 * s, 0.13 * s, head);
      // shield slab with rivets and viewport
      const slabMat = std(0x2c2e34, 0.5, 0.75);
      const shield = new THREE.Group();
      shield.position.set(0, 0.34 * s, 0.34 * s);
      shield.rotation.x = -0.1;
      torso.add(shield);
      rig.extra = shield;
      box(0.85 * s, 0.85 * s, 0.09 * s, slabMat, 0, 0, 0, shield);
      const rivet = std(0x55595f, 0.4, 0.9);
      for (const [rx, ry] of [[-0.34, -0.34], [0.34, -0.34], [-0.34, 0.34], [0.34, 0.34]]) {
        box(0.06 * s, 0.06 * s, 0.11 * s, rivet, rx * s, ry * s, 0, shield);
      }
      box(0.3 * s, 0.06 * s, 0.1 * s, eye, 0, 0.18 * s, 0.005 * s, shield); // glowing viewport slit
      rig.armL = limb(flesh, 0.07 * s, 0.4 * s, -0.3 * s, 0.5 * s, 0.1 * s, torso);
      rig.armR = limb(body, 0.08 * s, 0.4 * s, 0.3 * s, 0.5 * s, 0.1 * s, torso);
      disableCastShadows(root);
      return { root, flashMats: [body, flesh, slabMat], eyeMats: [eye], rig };
    }
    case 'boss': {
      // THE FOREMAN — loader exoskeleton, pilot liquefied in the cabin
      const frame = std(0x5a4a30, 0.5, 0.7);
      const dark = std(0x26221c, 0.7, 0.55);
      const steel = std(0x55595f, 0.4, 0.9);
      box(1.7, 0.5, 1.3, dark, 0, 0.35, -0.1, root); // tread base
      for (const sx of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          cyl(0.16, 0.16, 0.2, steel, sx * 0.75, 0.28, -0.5 + i * 0.42, root).rotation.z = Math.PI / 2; // road wheels
        }
      }
      const torso = new THREE.Group();
      torso.position.y = 0.85;
      root.add(torso);
      rig.torso = torso;
      box(1.5, 0.85, 1.0, frame, 0, 0.35, 0, torso); // chassis
      box(1.54, 0.12, 1.04, std(0x8a6a1c, 0.6, 0.4), 0, 0.75, 0, torso); // hazard band
      // cabin + pilot soup
      box(0.75, 0.6, 0.65, dark, 0, 1.05, 0.08, torso);
      const soup = new THREE.MeshBasicMaterial({ color: 0x9a3020 });
      box(0.5, 0.36, 0.04, soup, 0, 1.05, 0.42, torso);
      const lamp = new THREE.MeshBasicMaterial({ color: def.eyeColor });
      box(0.14, 0.1, 0.05, lamp, -0.45, 1.32, 0.35, torso);
      box(0.14, 0.1, 0.05, lamp, 0.45, 1.32, 0.35, torso);
      // exhaust stacks (game emits smoke from these)
      cyl(0.09, 0.11, 0.7, dark, -0.55, 1.1, -0.45, torso);
      cyl(0.09, 0.11, 0.7, dark, 0.55, 1.1, -0.45, torso);
      root.userData.stackL = new THREE.Vector3(-0.55, 2.3, -0.45);
      root.userData.stackR = new THREE.Vector3(0.55, 2.3, -0.45);
      // claw arms on pivots
      for (const sx of [-1, 1]) {
        const arm = new THREE.Group();
        arm.position.set(sx * 0.95, 0.55, 0.15);
        torso.add(arm);
        if (sx < 0) rig.armL = arm;
        else rig.armR = arm;
        box(0.32, 0.32, 1.1, frame, 0, 0, 0.45, arm);
        cyl(0.07, 0.07, 0.5, steel, 0, 0.2, 0.35, arm).rotation.x = Math.PI / 2; // piston
        box(0.44, 0.42, 0.35, dark, 0, -0.02, 1.05, arm);
        box(0.14, 0.5, 0.3, dark, -0.16, -0.3, 1.05, arm); // claw fingers
        box(0.14, 0.5, 0.3, dark, 0.16, -0.3, 1.05, arm);
      }
      disableCastShadows(root);
      return { root, flashMats: [frame, dark, steel], eyeMats: [lamp, soup], rig };
    }
  }
  disableCastShadows(root);
  // fallback (should not happen)
  return { root, flashMats: [body], eyeMats: [eye], rig };

  function bone(): THREE.MeshStandardMaterial {
    return std(0xcfc5ae, 0.9, 0.05);
  }
}

// ---------------------------------------------------------------- misc
/** player bolter shell — bright core for bloom; floor glow comes from the light pool */
export function buildBolt(color = 0xffdf8a): THREE.Group {
  const g = new THREE.Group();
  const outer = new THREE.Mesh(boxGeo(0.065, 0.065, 0.32), new THREE.MeshBasicMaterial({ color }));
  g.add(outer);
  const core = new THREE.Mesh(boxGeo(0.035, 0.035, 0.38), new THREE.MeshBasicMaterial({ color: 0xfffbe8 }));
  g.add(core);
  return g;
}

/** enemy bile glob */
export function buildGlob(scale = 1): THREE.Group {
  const g = new THREE.Group();
  const outer = new THREE.Mesh(
    sphereGeo(0.17 * scale, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0x86c22c, transparent: true, opacity: 0.75 }),
  );
  g.add(outer);
  const core = new THREE.Mesh(sphereGeo(0.09 * scale, 8, 6), new THREE.MeshBasicMaterial({ color: 0xd8ff7a }));
  g.add(core);
  return g;
}

/** turret mortar orb — big, slow, glowing; the whole point is dodging it */
export function buildMortarOrb(): THREE.Group {
  const g = new THREE.Group();
  const outer = new THREE.Mesh(
    sphereGeo(0.34, 14, 12),
    new THREE.MeshBasicMaterial({ color: 0xff8038, transparent: true, opacity: 0.55 }),
  );
  g.add(outer);
  const core = new THREE.Mesh(sphereGeo(0.18, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffd8a0 }));
  g.add(core);
  return g;
}

/** health orb */
export function buildOrb(): THREE.Mesh {
  return new THREE.Mesh(
    sphereGeo(0.18, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xe04444 }),
  );
}

// ------------------------------------------------------ destructible props
/** red fuel barrel — shoot it, regret standing near it */
export function buildExplosiveBarrel(): THREE.Group {
  const g = new THREE.Group();
  const red = std(0x9a2018, 0.55, 0.6);
  const band = std(0xd8c25a, 0.6, 0.4);
  cyl(0.42, 0.42, 1.0, red, 0, 0.5, 0, g, 12);
  const b = cyl(0.43, 0.43, 0.12, band, 0, 0.62, 0, g, 12);
  b.castShadow = false;
  cyl(0.12, 0.12, 0.08, std(0x2a2424, 0.6, 0.7), 0, 1.04, 0, g, 8);
  return g;
}

/** small breakables: crates, cups, canisters — pure catharsis */
export function buildSmallProp(kind: 'crate' | 'cup' | 'canister'): THREE.Group {
  const g = new THREE.Group();
  if (kind === 'crate') {
    box(0.5, 0.42, 0.5, std(0x6a5638, 0.85, 0.15), 0, 0.21, 0, g);
    box(0.52, 0.07, 0.52, std(0x4a3c26, 0.85, 0.15), 0, 0.4, 0, g);
  } else if (kind === 'cup') {
    cyl(0.08, 0.06, 0.16, std(0xb8b4a8, 0.3, 0.2), 0, 0.08, 0, g, 8);
  } else {
    cyl(0.16, 0.16, 0.5, std(0x4a5a48, 0.5, 0.7), 0, 0.25, 0, g, 8);
    cyl(0.06, 0.06, 0.1, std(0x2a2424, 0.6, 0.7), 0, 0.55, 0, g, 6);
  }
  return g;
}

// XP motes share one geometry + material — dozens can exist per room
const moteGeo = new THREE.OctahedronGeometry(0.13, 0);
const moteMat = new THREE.MeshBasicMaterial({ color: 0xd8c25a });

/** experience mote — dropped by the dead, harvested when the room falls silent */
export function buildXpMote(): THREE.Mesh {
  return new THREE.Mesh(moteGeo, moteMat);
}

/** the Gravelight orb */
export function buildGravelightOrb(scale: number): THREE.Group {
  const g = new THREE.Group();
  const core = new THREE.Mesh(
    sphereGeo(0.55 * scale, 20, 16),
    new THREE.MeshBasicMaterial({ color: 0x66ff88 }),
  );
  g.add(core);
  const shell = new THREE.Mesh(
    sphereGeo(0.75 * scale, 20, 16),
    new THREE.MeshBasicMaterial({ color: 0x0a2a12, transparent: true, opacity: 0.55 }),
  );
  g.add(shell);
  return g;
}

/** Sentinel Casket war engine */
export function buildCasket(): BuiltMesh {
  const root = new THREE.Group();
  const rig: AnimRig = {};
  const iron = std(0x3c4650, 0.5, 0.8);
  const dark = std(0x1c2026, 0.7, 0.6);
  const glow = new THREE.MeshBasicMaterial({ color: 0x8adfff });
  const casket = box(0.8, 1.7, 0.5, iron, 0, 0.85, 0, root);
  casket.rotation.x = 0.08;
  box(0.6, 0.4, 0.1, dark, 0, 1.3, 0.28, root);
  box(0.3, 0.12, 0.04, glow, 0, 1.1, 0.3, root);
  box(0.24, 0.24, 0.9, dark, -0.55, 0.9, 0.1, root);
  box(0.24, 0.24, 0.9, dark, 0.55, 0.9, 0.1, root);
  box(0.5, 0.1, 0.55, std(0x7a6428, 0.45, 0.85), 0, 1.75, 0, root); // laurel crown plate
  disableCastShadows(root);
  return { root, flashMats: [iron, dark], eyeMats: [glow], rig };
}

/** black sphere of the Hollow King */
export function buildSingularity(scale: number): THREE.Group {
  const g = new THREE.Group();
  const core = new THREE.Mesh(
    sphereGeo(0.7 * scale, 24, 18),
    new THREE.MeshBasicMaterial({ color: 0x000000 }),
  );
  g.add(core);
  const rim = new THREE.Mesh(
    sphereGeo(0.78 * scale, 24, 18),
    new THREE.MeshBasicMaterial({ color: 0x9a4ae0, transparent: true, opacity: 0.3, side: THREE.BackSide }),
  );
  g.add(rim);
  return g;
}

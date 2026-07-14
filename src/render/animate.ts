import type { Enemy } from '../game/game';
import type { AnimRig } from './meshes';

// Procedural animation over the primitive rigs. No keyframes — poses are
// functions of walk phase, state, and time. Cheap, robust, always in sync
// with the sim.

/** swing limbs from a walk phase; amount fades with animSpeed */
function walk(rig: AnimRig, phase: number, amount: number, armScale = 0.7) {
  const swing = Math.sin(phase) * amount;
  if (rig.legL) rig.legL.rotation.x = swing;
  if (rig.legR) rig.legR.rotation.x = -swing;
  // quadruped rear pair runs counter-phase
  if (rig.legL2) rig.legL2.rotation.x = -swing;
  if (rig.legR2) rig.legR2.rotation.x = swing;
  if (rig.armL && armScale > 0) rig.armL.rotation.x = -swing * armScale;
  if (rig.armR && armScale > 0) rig.armR.rotation.x = swing * armScale;
}

export function animatePlayer(
  rig: AnimRig,
  opts: { moving: boolean; bobT: number; recoil: number; windup: number; time: number },
) {
  const phase = opts.bobT * 9;
  const amount = opts.moving ? 0.55 : 0;
  const swing = Math.sin(phase) * amount;
  if (rig.legL) rig.legL.rotation.x = swing;
  if (rig.legR) rig.legR.rotation.x = -swing;
  if (rig.torso) {
    // breathe at rest; on the march the armor SWAYS — shoulders roll with the
    // stride, hips counter-twist, the lean pulses with each footfall
    rig.torso.rotation.x = opts.moving
      ? 0.09 + Math.sin(phase * 2) * 0.02
      : Math.sin(opts.time * 1.6) * 0.015;
    rig.torso.rotation.z = opts.moving ? Math.sin(phase) * 0.06 : Math.sin(opts.time * 1.1) * 0.008;
    rig.torso.rotation.y = opts.moving ? Math.sin(phase + Math.PI) * 0.045 : 0;
    if (opts.windup > 0) {
      rig.torso.rotation.x = -0.18; // plant and brace
      rig.torso.rotation.z = 0;
      rig.torso.rotation.y = 0;
    }
  }
  if (rig.gun) {
    rig.gun.position.z = 0.42 - opts.recoil * 0.9;
    rig.gun.rotation.x = -opts.recoil * 1.4;
    // the barrel rides the step rhythm (twice per stride), settles to breathing
    const baseY = (rig.gun.userData.baseY ??= rig.gun.position.y);
    rig.gun.position.y = baseY + (opts.moving ? Math.sin(phase * 2) * 0.015 : Math.sin(opts.time * 1.6) * 0.006);
  }
  if (rig.head) {
    rig.head.rotation.x = opts.moving ? 0.06 : 0;
    rig.head.rotation.z = opts.moving ? -Math.sin(phase) * 0.03 : 0; // gaze stays level against the sway
  }
}

export function animateEnemy(e: Enemy, time: number) {
  const rig = e.mesh.rig;
  const b = e.def.behavior;

  switch (b) {
    case 'swarm':
      walk(rig, e.walkPhase * 2.2, 0.9 * e.animSpeed, 0);
      if (rig.torso) rig.torso.rotation.z = 0.08 + Math.sin(e.walkPhase * 2.2) * 0.06 * e.animSpeed;
      if (rig.head) rig.head.rotation.y = Math.sin(time * 11 + e.walkPhase) * 0.18; // vermin twitch
      break;
    case 'turret': {
      // rooted — the eye-cannon tracks, the stalk sways and slowly scans
      if (rig.extra) {
        rig.extra.rotation.x = Math.sin(time * 1.3) * 0.06;
        rig.extra.rotation.y = Math.sin(time * 0.6 + e.walkPhase) * 0.25;
        if (e.state === 'windup') {
          // pull back like a mortar before the shot
          rig.extra.position.z = -0.12 * (1 - e.stateT / 0.9);
        } else {
          rig.extra.position.z *= 0.85;
        }
      }
      break;
    }
    case 'shocker': {
      walk(rig, e.walkPhase, 0.5 * e.animSpeed, 0.3);
      if (rig.torso) rig.torso.rotation.z = Math.sin(e.walkPhase) * 0.06 * e.animSpeed;
      if (e.state === 'windup' || e.state === 'recover') {
        // prongs forward, mast humming
        if (rig.armL) rig.armL.rotation.x = -1.3;
        if (rig.armR) rig.armR.rotation.x = -1.3;
        if (rig.extra) rig.extra.rotation.z = Math.sin(time * 40) * 0.05;
      } else if (rig.extra) {
        rig.extra.rotation.z = Math.sin(time * 3 + e.walkPhase) * 0.04;
      }
      break;
    }
    case 'charger': {
      walk(rig, e.walkPhase * 1.6, 0.7 * e.animSpeed, 0);
      if (rig.torso) {
        if (e.state === 'windup') {
          rig.torso.position.y = 0.42 * e.def.scale - 0.1 * (1 - e.stateT / 0.9); // crouch
          rig.torso.rotation.x = 0.12;
        } else if (e.state === 'lunge') {
          rig.torso.position.y = 0.42 * e.def.scale;
          rig.torso.rotation.x = -0.14; // wedge down, full ram
          if (rig.extra) rig.extra.position.z = -0.3 * e.def.scale + Math.sin(time * 50) * 0.04; // pistons hammering
        } else {
          rig.torso.position.y = 0.42 * e.def.scale;
          rig.torso.rotation.x = 0;
          rig.torso.rotation.z = Math.sin(e.walkPhase * 1.6) * 0.05 * e.animSpeed; // hull rocks as it stalks
        }
      }
      break;
    }
    case 'boss': {
      // treads don't animate; the claws and cabin do
      const battack = e.boss?.attack;
      const clawT = battack === 'charge-warn' || battack === 'charging' ? Math.sin(time * 18) * 0.25 : Math.sin(time * 2.1) * 0.06;
      if (rig.armL) rig.armL.rotation.x = clawT;
      if (rig.armR) rig.armR.rotation.x = -clawT;
      if (rig.torso) rig.torso.rotation.y = Math.sin(time * 0.8) * 0.03; // cabin surveys the room
      if (rig.torso && e.boss?.phase2) rig.torso.rotation.z = Math.sin(time * 27) * 0.012; // rattling apart
      break;
    }
    default: {
      // melee / ranged / elite bipeds
      const heavy = b === 'elite';
      walk(rig, e.walkPhase, (heavy ? 0.35 : 0.55) * e.animSpeed);
      if (rig.torso) {
        // gait: shoulders roll with the steps — the heavier the body, the
        // harder the roll; hips counter-twist a beat behind
        rig.torso.rotation.z = Math.sin(e.walkPhase) * (heavy ? 0.11 : 0.07) * e.animSpeed;
        rig.torso.rotation.y = Math.sin(e.walkPhase + Math.PI) * 0.05 * e.animSpeed;
      }
      if (rig.torso && e.state === 'windup') {
        const k = 1 - e.stateT / 0.7;
        rig.torso.rotation.x = (b === 'melee' ? 0.38 : 0) + 0.25 * k; // rear back to strike
      } else if (rig.torso) {
        // breathe: even the dead things heave
        rig.torso.rotation.x = (b === 'melee' ? 0.38 : 0) + Math.sin(time * 1.9 + e.walkPhase) * 0.025;
      }
      if (rig.head && !heavy) {
        rig.head.rotation.y = Math.sin(time * 0.9 + e.walkPhase) * 0.12; // wrong little scans
        rig.head.rotation.z = Math.sin(e.walkPhase) * 0.06 * e.animSpeed; // lolls with the gait
      }
      break;
    }
  }
}

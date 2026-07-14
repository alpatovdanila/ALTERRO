import * as THREE from 'three';
import type { Game, Enemy } from './game';
import type { UltimateId } from '../data/ultimates';
import { buildGravelightOrb, buildCasket, buildSingularity, type BuiltMesh } from '../render/meshes';
import { sfx } from '../core/sfx';
import { ARENA_W, ARENA_D } from '../render/scene';
import { cylGeo } from '../render/geocache';

// Runtime for the 8 launch ultimates (DESIGN.md §5.5).
// Every ultimate is a set piece: it owns the screen while it runs.

const HALF_W = ARENA_W / 2;
const HALF_D = ARENA_D / 2;

type Active =
  | { kind: 'gravelight'; orb: THREE.Group; pos: THREE.Vector3; dir: THREE.Vector3; zapT: number }
  | { kind: 'quiet-word'; t: number; waveR: number; bossHit: boolean }
  | { kind: 'red-choir'; t: number }
  | {
      kind: 'deadhand';
      phase: 'frame' | 'fire';
      t: number;
      marks: { e: Enemy | null; pos: THREE.Vector3; el: HTMLDivElement }[];
      fired: number;
      missiles: { mesh: THREE.Mesh; from: THREE.Vector3; target: THREE.Vector3; t: number; mark: number }[];
      frameEl: HTMLDivElement;
    }
  | { kind: 'waltz'; targets: Enemy[]; idx: number; t: number }
  | { kind: 'grasp'; phase: 'pull' | 'crush'; t: number; mesh: THREE.Group; center: THREE.Vector3; tickT: number }
  | { kind: 'casket'; mesh: BuiltMesh; pos: THREE.Vector3; t: number; hp: number; fireCd: number; landT: number }
  | { kind: 'pyre'; r: number; hit: Set<Enemy>; light: THREE.PointLight | null; t: number };

function overlay(id: string): HTMLElement {
  return document.getElementById(id)!;
}

export class UltimateRunner {
  private g: Game;
  private a: Active | null = null;
  /** pooled glow borrowed for the current set piece */
  private orbLight: THREE.PointLight | null = null;

  constructor(game: Game) {
    this.g = game;
  }

  get active(): boolean {
    return this.a !== null;
  }

  /** waltz teleports the player — movement/firing are surrendered to the dance */
  get lockPlayer(): boolean {
    return this.a?.kind === 'waltz';
  }

  private get mult(): number {
    return this.g.ultPotencyMult;
  }
  private rand = () => this.g.rng.next();

  /** one missile lands: the bracketed target dies, the deck answers */
  private strikeImpact(mark: { e: Enemy | null; pos: THREE.Vector3; el: HTMLDivElement }) {
    const g = this.g;
    mark.el.remove();
    const p = mark.pos.clone().setY(0.3);
    sfx.explosion();
    g.stage.addShake(0.45);
    g.stage.ring(mark.pos, 3.2, 0xff8a3a, 0.35);
    g.particles.explosion(p, 1.7);
    g.particles.fire(p, 8, 1.8);
    g.particles.sparks(p, 7, undefined, 1.6);
    g.particles.puff(p.clone().setY(0.9), 3, { size: 1.3, dark: true, life: 1.8 });
    g.gore.scorch(mark.pos.x, mark.pos.z, this.rand, 1.8);
    this.igniteOil(mark.pos.x, mark.pos.z, 2.4, 5);
    const l = g.stage.lendLight(0xffa050, 90, 14);
    if (l) {
      l.position.set(mark.pos.x, 1.6, mark.pos.z);
      setTimeout(() => g.stage.releaseLight(l), 280);
    }
    if (this.rand() < 0.5) {
      g.stage.vents.push({ pos: p.clone().setY(0.25), kind: 'smoke', rate: 3.5, ttl: 5 });
    }
    // the marked one dies; anything crowding it burns too
    for (const e of [...g.enemies]) {
      if (e.state === 'spawn') continue;
      const d = e.pos.distanceTo(mark.pos);
      if (e === mark.e || d < 0.6) {
        if (e.def.behavior === 'boss') g.damageEnemy(e, e.maxHp * 0.25, 'ult');
        else g.damageEnemy(e, e.hp + 1, 'ult', { vaporize: true });
      } else if (d < 2.4) {
        g.damageEnemy(e, 45 * this.mult, 'ult');
      }
    }
    for (const dd of [...g.destructibles]) {
      if (dd.pos.distanceTo(mark.pos) < 2.4) g.damageDestructible(dd, 999);
    }
  }

  /**
   * torch every oil slick within `r` (flood-fills through touching decals).
   * Zone count is capped — the biggest pools burn, the droplets just char.
   */
  private igniteOil(x: number, z: number, r: number, cap: number) {
    const g = this.g;
    const pools = g.gore.igniteOilNear(x, z, r);
    if (pools.length === 0) return;
    pools.sort((a, b) => b.r - a.r);
    for (const p of pools.slice(0, cap)) {
      g.burnZones.push({ x: p.x, z: p.z, r: p.r + 0.15, t: 5, dps: 8, hurtsPlayer: true });
      g.particles.fire(new THREE.Vector3(p.x, 0.08, p.z), 4, 1.2);
    }
    sfx.fire();
  }

  start(id: UltimateId) {
    if (this.a) return;
    const g = this.g;
    switch (id) {
      case 'gravelight': {
        // aim at the centroid of the living — the orb wants company
        const dir = new THREE.Vector3(0, 0, -1);
        if (g.enemies.length > 0) {
          const c = new THREE.Vector3();
          for (const e of g.enemies) c.add(e.pos);
          c.divideScalar(g.enemies.length);
          dir.subVectors(c, g.playerPos).setY(0);
          if (dir.lengthSq() < 0.01) dir.set(0, 0, -1);
          dir.normalize();
        }
        const orb = buildGravelightOrb(0.8 + 0.25 * this.g.ultTier);
        orb.position.set(g.playerPos.x, 0.9, g.playerPos.z);
        g.stage.scene.add(orb);
        const orbLight = g.stage.lendLight(0x66ff88, 40, 12);
        if (orbLight) orbLight.position.copy(orb.position);
        this.orbLight = orbLight;
        g.stage.setMood(0x0e2a16, 0.35, 6);
        this.a = { kind: 'gravelight', orb, pos: g.playerPos.clone(), dir, zapT: 0 };
        sfx.ultLaunch();
        break;
      }
      case 'quiet-word': {
        // all audio drops to a single whisper. the silence is the spectacle.
        sfx.muffle(2.6);
        sfx.whisper();
        g.stage.setMood(0x565e78, 0.3, 2.6);
        g.stage.ring(g.playerPos, 28, 0xb8c4ff, 2.1);
        this.a = { kind: 'quiet-word', t: 0, waveR: 0, bossHit: false };
        break;
      }
      case 'red-choir': {
        sfx.frenzy();
        overlay('fx-choir').style.opacity = '1';
        g.stage.setMood(0x4a0d0d, 0.45, 8);
        const dur = 8 * (1 + 0.25 * (g.ultTier - 1));
        for (const e of g.enemies) {
          if (e.def.behavior !== 'boss') {
            e.frenzied = true;
            e.targetEnemy = null;
          }
        }
        this.a = { kind: 'red-choir', t: dur };
        break;
      }
      case 'deadhand': {
        // uplink: a targeting frame sweeps out from the center of the SCREEN,
        // stamps a bracket on every hostile, then one missile answers each
        sfx.klaxon();
        g.stage.ring(g.playerPos, 26, 0xff3020, 1.5);
        g.stage.setMood(0x38100a, 0.6, 1.2);
        const frameEl = document.createElement('div');
        frameEl.className = 'strike-frame';
        document.getElementById('app')!.appendChild(frameEl);
        setTimeout(() => frameEl.classList.add('expanded'), 30);
        this.a = { kind: 'deadhand', phase: 'frame', t: 0.7, marks: [], fired: 0, missiles: [], frameEl };
        break;
      }
      case 'waltz': {
        const count = 8 + 4 * g.ultTier;
        const targets = [...g.enemies]
          .filter((e) => e.state !== 'spawn')
          .sort((x, y) => x.pos.distanceToSquared(g.playerPos) - y.pos.distanceToSquared(g.playerPos))
          .slice(0, count);
        if (targets.length === 0) {
          g.ultCharge = g.ultChargeNeed * 0.5; // nothing to dance with — refund half
          return;
        }
        g.stage.setMood(0x1a1214, 0.3, targets.length * 0.16 + 0.5);
        this.a = { kind: 'waltz', targets, idx: 0, t: 0.05 };
        break;
      }
      case 'grasp': {
        // opens ahead of the player — the long rooms mean "room center" could be a screen away
        const center = new THREE.Vector3(
          THREE.MathUtils.clamp(g.playerPos.x * 0.5, -8, 8),
          1.0,
          THREE.MathUtils.clamp(g.playerPos.z - 6.5, -HALF_D + 3, HALF_D - 3),
        );
        const mesh = buildSingularity(1 + 0.3 * (g.ultTier - 1));
        mesh.position.copy(center);
        g.stage.scene.add(mesh);
        const graspLight = g.stage.lendLight(0x9a4ae0, 30, 10);
        if (graspLight) graspLight.position.set(center.x, 1.5, center.z);
        this.orbLight = graspLight;
        g.stage.setMood(0x160a24, 0.3, 3.4);
        sfx.darkSpell();
        this.a = { kind: 'grasp', phase: 'pull', t: 1.6, mesh, center, tickT: 0 };
        break;
      }
      case 'casket': {
        const near = g.nearestEnemy(g.playerPos);
        const pos = g.playerPos.clone();
        if (near) {
          const d = new THREE.Vector3().subVectors(near.pos, g.playerPos).setY(0).normalize();
          pos.addScaledVector(d, 2.2);
        } else {
          pos.z -= 2.2;
        }
        pos.x = THREE.MathUtils.clamp(pos.x, -HALF_W + 1, HALF_W - 1);
        pos.z = THREE.MathUtils.clamp(pos.z, -HALF_D + 1, HALF_D - 1);
        const mesh = buildCasket();
        mesh.root.position.set(pos.x, 12, pos.z);
        g.stage.scene.add(mesh.root);
        const state = { kind: 'casket' as const, mesh, pos, t: 20, hp: 250 * this.mult, fireCd: 0, landT: 0.35 };
        this.a = state;
        g.tauntDamage = (amount) => { state.hp -= amount; };
        sfx.bigLaunch(); // inbound from orbit
        break;
      }
      case 'pyre': {
        sfx.fire();
        const light = g.stage.lendLight(0xff8a2c, 70, 20);
        if (light) light.position.set(g.playerPos.x, 2.5, g.playerPos.z);
        // the fire becomes the room's only light source
        g.stage.setMood(0x0a0402, 0.1, 8);
        g.stage.ring(g.playerPos, 16, 0xfff3c4, 1.5);
        g.stage.ring(g.playerPos, 16, 0xff6a1c, 1.7);
        // burning ground persists (DESIGN.md §5.5 #8)
        const zones = [{ x: g.playerPos.x, z: g.playerPos.z }];
        for (let i = 0; i < 8; i++) {
          const ang = (i / 8) * Math.PI * 2;
          zones.push({ x: g.playerPos.x + Math.cos(ang) * 3.6, z: g.playerPos.z + Math.sin(ang) * 3.6 });
        }
        for (const z of zones) {
          g.burnZones.push({ x: z.x, z: z.z, r: 1.7, t: 10, dps: 8 * this.mult });
          g.gore.scorch(z.x, z.z, this.rand, 1.6);
        }
        this.a = { kind: 'pyre', r: 0, hit: new Set(), light, t: 8 };
        break;
      }
    }
  }

  abort() {
    if (!this.a) return;
    const g = this.g;
    g.stage.releaseLight(this.orbLight);
    this.orbLight = null;
    if (this.a.kind === 'gravelight') g.stage.scene.remove(this.a.orb);
    if (this.a.kind === 'grasp') g.stage.scene.remove(this.a.mesh);
    if (this.a.kind === 'deadhand') {
      this.a.frameEl.remove();
      for (const m of this.a.marks) m.el.remove();
      for (const mi of this.a.missiles) g.stage.scene.remove(mi.mesh);
    }
    if (this.a.kind === 'casket') {
      g.stage.scene.remove(this.a.mesh.root);
      g.tauntPos = null;
    }
    if (this.a.kind === 'pyre') g.stage.releaseLight(this.a.light);
    if (this.a.kind === 'red-choir') this.endChoir();
    overlay('fx-choir').style.opacity = '0';
    this.a = null;
  }

  private endChoir() {
    overlay('fx-choir').style.opacity = '0';
    for (const e of this.g.enemies) {
      if (e.frenzied) {
        e.frenzied = false;
        e.targetEnemy = null;
        e.frenzyDotT = 4; // survivors keep bleeding
      }
    }
  }

  update(dt: number) {
    if (!this.a) return;
    const g = this.g;
    const a = this.a;

    // player untouchable during the set piece — except the long-running casket,
    // and pyre only while its ring is still expanding
    const grantsInvuln = a.kind !== 'casket' && !(a.kind === 'pyre' && a.r > 16);
    if (grantsInvuln) g.invulnT = Math.max(g.invulnT, 0.15);

    switch (a.kind) {
      case 'gravelight': {
        a.pos.addScaledVector(a.dir, 3.6 * dt);
        a.orb.position.set(a.pos.x, 0.9 + Math.sin(performance.now() / 130) * 0.1, a.pos.z);
        if (this.orbLight) this.orbLight.position.copy(a.orb.position);
        a.zapT -= dt;
        if (a.zapT <= 0) {
          a.zapT = 0.12;
          const inRange = g.enemies
            .filter((e) => e.state !== 'spawn' && e.pos.distanceTo(a.pos) < 5.5)
            .slice(0, 3);
          for (const e of inRange) {
            g.stage.zap(a.orb.position, e.pos.clone().setY(0.7), 0x8affa8);
            g.particles.electric(e.pos.clone().setY(0.7), 3, 0x8affa8);
            sfx.zap();
            g.damageEnemy(e, 16 * this.mult, 'ult', { vaporize: true });
          }
        }
        const hitWall =
          a.pos.x < -HALF_W + 1 || a.pos.x > HALF_W - 1 ||
          a.pos.z < -HALF_D + 1 || a.pos.z > HALF_D - 1;
        if (hitWall) {
          // detonation against the far wall
          g.stage.addShake(0.8);
          g.stage.ring(a.pos, 6, 0x8affa8, 0.5);
          g.stage.vents.push({ pos: a.pos.clone().setY(0.3), kind: 'smoke', rate: 4, ttl: 5 });
          sfx.explosion();
          for (const e of [...g.enemies]) {
            if (e.state === 'spawn') continue;
            if (e.pos.distanceTo(a.pos) < 5) {
              g.damageEnemy(e, 90 * this.mult, 'ult', { vaporize: true });
            }
          }
          g.stage.scene.remove(a.orb);
          g.stage.releaseLight(this.orbLight);
          this.orbLight = null;
          this.a = null;
        }
        break;
      }

      case 'quiet-word': {
        a.t += dt;
        a.waveR = a.t * 13;
        for (const e of [...g.enemies]) {
          if (e.state === 'spawn' || e.state === 'doomed') continue;
          if (e.pos.distanceTo(g.playerPos) < a.waveR) {
            if (e.def.behavior === 'boss') {
              if (!a.bossHit) {
                a.bossHit = true;
                const pct = 0.25 + 0.05 * g.ultTier;
                g.damageEnemy(e, e.maxHp * pct, 'ult');
                if (e.hp > 0) {
                  e.state = 'stun';
                  e.stateT = 3;
                }
              }
            } else {
              // freeze, shudder, then the self-inflicted end — in a wave from the player
              e.state = 'doomed';
              e.stateT = 0.35 + this.rand() * 0.25;
            }
          }
        }
        if (a.t > 3.4) this.a = null; // rooms are two screens tall — let the wave finish crossing
        break;
      }

      case 'red-choir': {
        a.t -= dt;
        if (a.t <= 0) {
          this.endChoir();
          this.a = null;
        }
        break;
      }

      case 'deadhand': {
        // brackets ride their targets in screen space
        for (const m of a.marks) {
          if (m.e && m.e.hp > 0 && g.enemies.includes(m.e)) m.pos.copy(m.e.pos);
          const s = g.stage.toScreen(m.pos.x, 0.9, m.pos.z);
          m.el.style.left = `${s.x}px`;
          m.el.style.top = `${s.y}px`;
        }

        if (a.phase === 'frame') {
          // ---- the targeting frame sweeps out from the screen center ----
          a.t -= dt;
          g.stage.addShake(dt * 0.5);
          if (a.t <= 0) {
            a.frameEl.classList.add('locked');
            const app = document.getElementById('app')!;
            for (const e of g.enemies) {
              if (e.state === 'spawn') continue;
              const el = document.createElement('div');
              el.className = 'strike-mark';
              app.appendChild(el);
              a.marks.push({ e, pos: e.pos.clone(), el });
            }
            if (a.marks.length === 0) {
              // no targets — a few blind strikes so the sky still answers
              for (let i = 0; i < 4; i++) {
                a.marks.push({
                  e: null,
                  pos: new THREE.Vector3(
                    this.rand() * (ARENA_W - 6) - HALF_W + 3,
                    0,
                    this.rand() * (ARENA_D - 6) - HALF_D + 3,
                  ),
                  el: document.createElement('div'), // never attached
                });
              }
            }
            sfx.ready();
            a.phase = 'fire';
            a.t = 0.35;
          }
          break;
        }

        // ---- fire: one missile per bracket, staggered ----
        a.t -= dt;
        if (a.t <= 0 && a.fired < a.marks.length) {
          const m = a.marks[a.fired];
          const from = new THREE.Vector3(m.pos.x + (this.rand() - 0.5) * 2, 15, m.pos.z - 3);
          const mesh = new THREE.Mesh(
            cylGeo(0.06, 0.13, 1.3, 6),
            new THREE.MeshBasicMaterial({ color: 0xffd9a0 }),
          );
          mesh.position.copy(from);
          mesh.lookAt(m.pos.x, 0, m.pos.z);
          mesh.rotateX(Math.PI / 2); // cylinder axis onto the flight line
          g.stage.scene.add(mesh);
          a.missiles.push({ mesh, from, target: m.pos.clone(), t: 0.16, mark: a.fired });
          sfx.mortarShot();
          a.fired++;
          a.t = 0.12;
        }
        for (let i = a.missiles.length - 1; i >= 0; i--) {
          const mi = a.missiles[i];
          mi.t -= dt;
          const k = 1 - Math.max(0, mi.t) / 0.16;
          mi.mesh.position.lerpVectors(mi.from, mi.target, k);
          if (this.rand() < 0.6) g.particles.fire(mi.mesh.position, 1, 0.5);
          if (mi.t <= 0) {
            g.stage.scene.remove(mi.mesh);
            this.strikeImpact(a.marks[mi.mark]);
            a.missiles.splice(i, 1);
          }
        }
        if (a.fired >= a.marks.length && a.missiles.length === 0) {
          for (const m of a.marks) m.el.remove();
          a.frameEl.remove();
          this.a = null;
        }
        break;
      }

      case 'waltz': {
        a.t -= dt;
        if (a.t <= 0) {
          a.t = 0.15;
          // skip targets that died before their turn came
          while (a.idx < a.targets.length && !g.enemies.includes(a.targets[a.idx])) a.idx++;
          if (a.idx >= a.targets.length) {
            this.a = null;
            break;
          }
          const e = a.targets[a.idx++];
          g.particles.puff(g.playerPos.clone().setY(0.8), 1, { size: 0.7, dark: true, life: 0.5 }); // blink out
          g.playerPos.set(
            THREE.MathUtils.clamp(e.pos.x + (this.rand() - 0.5), -HALF_W + 0.6, HALF_W - 0.6),
            0,
            THREE.MathUtils.clamp(e.pos.z + (this.rand() - 0.5), -HALF_D + 0.6, HALF_D - 0.6),
          );
          sfx.execute();
          g.stage.addShake(0.12);
          if (e.def.behavior === 'boss') {
            g.damageEnemy(e, 60 * this.mult, 'ult');
          } else {
            g.damageEnemy(e, e.hp + 1, 'ult', { execute: true });
          }
          if (a.idx >= a.targets.length) this.a = null;
        }
        break;
      }

      case 'grasp': {
        a.mesh.rotation.y += dt * 2;
        if (a.phase === 'pull') {
          a.t -= dt;
          for (const e of g.enemies) {
            if (e.state === 'spawn' || e.def.behavior === 'boss') continue;
            const d = new THREE.Vector3().subVectors(a.center, e.pos).setY(0);
            const dist = d.length();
            if (dist > 0.2) {
              d.divideScalar(dist);
              e.pos.addScaledVector(d, Math.min(9, 3 + 14 / Math.max(1, dist)) * dt);
            }
            e.state = 'stun';
            e.stateT = 0.2;
          }
          if (a.t <= 0) {
            a.phase = 'crush';
            a.t = 0.9;
          }
        } else {
          a.t -= dt;
          a.tickT -= dt;
          a.mesh.scale.setScalar(1 + (0.9 - a.t) * 0.3);
          if (a.tickT <= 0) {
            a.tickT = 0.3;
            sfx.hit();
            for (const e of [...g.enemies]) {
              if (e.state === 'spawn') continue;
              const dist = e.pos.distanceTo(a.center);
              if (dist < 3) {
                const dmg = 45 * this.mult * (e.def.behavior === 'boss' ? 0.5 : 1);
                g.damageEnemy(e, dmg, 'ult');
              }
            }
          }
          if (a.t <= 0) {
            // ejection: paint the room red
            g.stage.ring(a.center, 10, 0xb06af0, 0.5);
            g.stage.addShake(0.9);
            sfx.explosion();
            for (const e of [...g.enemies]) {
              if (e.state === 'spawn') continue;
              if (e.pos.distanceTo(a.center) < 9.5) {
                const dmg = 70 * this.mult * (e.def.behavior === 'boss' ? 0.5 : 1);
                g.damageEnemy(e, dmg, 'ult');
              }
            }
            const c = a.center.clone().setY(0.6);
            g.gore.burst(c, this.rand, 34, 2.4, 'meat');
            g.gore.burst(c, this.rand, 8, 2, 'bone');
            g.particles.mist(c, 12);
            for (let i = 0; i < 12; i++) {
              const ang = this.rand() * Math.PI * 2;
              const r = 1.5 + this.rand() * 4;
              g.gore.splat(a.center.x + Math.cos(ang) * r, a.center.z + Math.sin(ang) * r, this.rand, 2, 1.4);
            }
            g.stage.vents.push({ pos: a.center.clone().setY(0.3), kind: 'smoke', rate: 4, ttl: 5 });
            g.stage.scene.remove(a.mesh);
            g.stage.releaseLight(this.orbLight);
            this.orbLight = null;
            this.a = null;
          }
        }
        break;
      }

      case 'casket': {
        if (a.landT > 0) {
          a.landT -= dt;
          a.mesh.root.position.y = Math.max(0, 12 * (a.landT / 0.35));
          if (a.landT <= 0) {
            g.stage.addShake(0.7);
            g.stage.ring(a.pos, 5, 0x8adfff, 0.4);
            g.gore.burst(a.pos.clone().setY(0.3), this.rand, 10, 1.2, 'ash');
            sfx.explosion();
            g.tauntPos = a.pos.clone();
          }
          break;
        }
        a.t -= dt;
        a.fireCd -= dt;
        if (a.fireCd <= 0) {
          const target = g.nearestVisibleEnemy(a.pos);
          if (target && target.pos.distanceTo(a.pos) < 12) {
            a.fireCd = 0.32;
            // twin autocannon tracers
            const muzzleL = a.pos.clone().add(new THREE.Vector3(-0.55, 0.9, 0));
            const muzzleR = a.pos.clone().add(new THREE.Vector3(0.55, 0.9, 0));
            g.stage.zap(muzzleL, target.pos.clone().setY(0.6), 0x8adfff);
            g.stage.zap(muzzleR, target.pos.clone().setY(0.6), 0xffc46a);
            sfx.casketShot();
            g.damageEnemy(target, 9 * this.mult, 'ult');
          } else {
            a.fireCd = 0.2;
          }
        }
        if (a.hp <= 0 || a.t <= 0) {
          // it screams when it expires
          sfx.bossRoar();
          g.gore.burst(a.pos.clone().setY(0.8), this.rand, 16, 1.5, 'meat');
          g.gore.burst(a.pos.clone().setY(0.8), this.rand, 8, 1.4, 'ash');
          g.gore.splat(a.pos.x, a.pos.z, this.rand, 5, 1.5);
          g.stage.scene.remove(a.mesh.root);
          g.tauntPos = null;
          this.a = null;
        }
        break;
      }

      case 'pyre': {
        a.r += 11 * dt;
        a.t -= dt;
        if (a.light) a.light.intensity = Math.max(0, 70 * (a.t / 8));
        for (const e of g.enemies) {
          if (e.state === 'spawn' || a.hit.has(e)) continue;
          if (e.pos.distanceTo(g.playerPos) < a.r) {
            a.hit.add(e);
            const bossScale = e.def.behavior === 'boss' ? 0.5 : 1;
            g.damageEnemy(e, 20 * this.mult * bossScale, 'ult');
            if (e.hp > 0) {
              e.burnT = 5;
              e.burnDps = Math.max(e.burnDps, 12 * this.mult * bossScale);
            }
          }
        }
        if (a.r > 18 && a.t <= 0) {
          g.stage.releaseLight(a.light);
          this.a = null;
        }
        break;
      }
    }
  }
}

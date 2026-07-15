import * as THREE from 'three';
import { Stage, ARENA_W, ARENA_D, type Collider } from '../render/scene';
import { zoneForRoom } from '../render/zones';
import { buildPlayer, buildEnemy, buildBolt, buildGlob, buildMortarOrb, buildOrb, buildXpMote, buildExplosiveBarrel, buildSmallProp, type BuiltMesh } from '../render/meshes';
import { animatePlayer, animateEnemy } from '../render/animate';
import { Particles } from '../render/particles';
import { FlowField, losClear } from './flowfield';
import { Gore } from './gore';
import { UltimateRunner } from './ultimates';
import { Input } from '../core/input';
import { Rng } from '../core/rng';
import { sfx } from '../core/sfx';
import { ENEMIES, type EnemyDef, scaleHp, scaleDamage } from '../data/enemies';
import type { PlayerStats, CardContext } from '../data/cards';
import { type UltimateDef, TIER_MULT } from '../data/ultimates';
import type { TraitId } from '../data/traits';

// The simulation. Fixed-timestep (driven by main.ts), seeded RNG, data-driven
// enemies/cards/ultimates. Archero contract: move to dodge, stand to fire.

export const FINAL_ROOM = 15;

const HALF_W = ARENA_W / 2;
const HALF_D = ARENA_D / 2;

export type EnemyState =
  | 'spawn'
  | 'chase'
  | 'windup'
  | 'lunge'
  | 'recover'
  | 'stun'
  | 'doomed';

export interface Enemy {
  def: EnemyDef;
  hp: number;
  maxHp: number;
  pos: THREE.Vector3;
  radius: number;
  damage: number;
  state: EnemyState;
  stateT: number;
  attackCd: number;
  /** knockback velocity — hits shove things (weight!) */
  kb: THREE.Vector3;
  lungeDir: THREE.Vector3;
  lungeHit: boolean;
  mesh: BuiltMesh;
  hitFlashT: number;
  burnT: number;
  burnDps: number;
  burnTickT: number;
  frenzied: boolean;
  frenzyDotT: number;
  targetEnemy: Enemy | null;
  /** attached flame light while burning (capped globally for perf) */
  fireLight: THREE.PointLight | null;
  facing: number;
  /** procedural animation state */
  walkPhase: number;
  animSpeed: number;
  /** rig parts already torn off (dismemberment) */
  torn: Set<string>;
  /** woken by damage — ignores the distance leash */
  aggroed: boolean;
  boss: null | {
    attack: 'idle' | 'charge-warn' | 'charging' | 'slam-warn';
    attackT: number;
    cooldown: number;
    chargeDir: THREE.Vector3;
    chargeHit: boolean;
    phase2: boolean;
    addsSpawned: [boolean, boolean];
    /** add waves owed but held back — never spawned in the same instant as
     * the hit that earned them (an airstrike must not conjure enemies) */
    addsPending: number;
    addsDelayT: number;
  };
}

interface Projectile {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  damage: number;
  fromPlayer: boolean;
  /** frenzy-fired enemy shots hurt other enemies */
  targetEnemies: boolean;
  pierceLeft: number;
  ricochetLeft: number;
  hit: Set<Enemy>;
  burnDps: number;
  mesh: THREE.Object3D;
  life: number;
  /** collision radius vs the player (mortars are big and dodgeable) */
  hitRadius: number;
  /** borrowed from the stage's light pool; returned on death */
  light: THREE.PointLight | null;
}

interface Orb {
  pos: THREE.Vector3;
  mesh: THREE.Mesh;
  t: number;
}

/** breakable set dressing — barrels explode, the rest just shatters */
export interface Destructible {
  kind: 'barrel' | 'crate' | 'cup' | 'canister';
  pos: THREE.Vector3;
  r: number;
  hp: number;
  mesh: THREE.Object3D;
  /** barrels block movement — their collider entry, removed on death */
  collider: Collider | null;
  /** chain-reaction delay */
  fuse: number;
}

/** dropped experience — sits where the enemy died, harvested on room clear */
interface XpMote {
  pos: THREE.Vector3;
  mesh: THREE.Mesh;
  xp: number;
  flying: boolean;
  /** flight time — speed ramps with it, and it hard-collects on timeout */
  flyT: number;
  t: number;
}

export interface GameEvents {
  onLevelUp(): void;
  /** the visible level-up moment, before the wheel appears */
  onCeremony(): void;
  onDeath(): void;
  onVictory(): void;
  onRoomExit(): void;
}

export interface RunStats {
  kills: number;
  damageDealt: number;
  ultUses: number;
  room: number;
  timeSec: number;
}

// Intentionally does NOT dispose GPU resources: geometries come from the
// shared cache (geocache.ts) and shader programs are shared across materials.
// Disposing them caused constant re-upload/recompile hitches mid-fight.
function disposeGroup(_root: THREE.Object3D) {
  /* removal from the scene is enough — resources are pooled */
}

export class Game {
  stage: Stage;
  gore: Gore;
  particles: Particles;
  input: Input;
  rng: Rng;
  events: GameEvents;
  ultRunner: UltimateRunner;

  // player
  playerPos = new THREE.Vector3(0, 0, 5.5);
  private playerVel = new THREE.Vector3();
  private recoil = 0;
  private bobT = 0;
  private hitStopT = 0;
  obstacles: Collider[] = [];
  /** obstacles minus destructibles — used for TARGETING (you may shoot a barrel) */
  private solidObstacles: Collider[] = [];
  private flow = new FlowField(ARENA_W, ARENA_D, 1);
  private flowT = 0;
  playerHp: number;
  stats: PlayerStats = {
    maxHp: 100,
    damage: 10.4, // rescaled to the 120rpm trigger, then trimmed 10%
    fireRate: 2.0, // 120 rounds per minute
    moveSpeed: 5.72, // +10% per playtest round 3

    multishot: 1,
    pierce: 0,
    ricochet: 0,
    burnDps: 0,
    lifesteal: 0,
    critChance: 0,
  };
  private playerMesh: ReturnType<typeof buildPlayer>;
  private fireCd = 0;
  private facing = 0;
  invulnT = 0;
  private hurtCdT = 0;
  private stepT = 0;
  moving = false;

  /** permanent combat doctrine, chosen at the reliquary */
  trait: TraitId;

  // ultimate
  ultDef: UltimateDef;
  ultTier = 1;
  ultCharge = 0;
  ultChargeRateBonus = 0;
  ultPotency = 1;
  ultOvercharged = false;
  private ultWindupT = 0;

  // progression
  level = 1;
  xp = 0;
  xpNext = 12;
  private pendingLevelUps = 0;
  private moteCombo = 0;
  private moteGraceT = 0;
  private ambientSparkT = 20;
  /** reinforcement waves still queued for this room */
  private wavesLeft = 0;
  /** silence timer: a strictly-sequential wave waits out this gap */
  private waveGapT = 0;
  /** room 1 only: a breath of quiet before first contact */
  private waveDelayT = 0;
  /** pause between the last kill landing and the XP motes lifting off */
  private harvestT = 0;
  /** the pause between collecting XP and the wheel — let the moment land */
  private ceremonyT = 0;

  // run state
  room = 1;
  roomCleared = false;
  paused = false;
  over = false;
  enemies: Enemy[] = [];
  private projectiles: Projectile[] = [];
  private orbs: Orb[] = [];
  private xpMotes: XpMote[] = [];
  destructibles: Destructible[] = [];
  /** Sentinel Casket taunt point (enemies near it attack it instead) */
  tauntPos: THREE.Vector3 | null = null;
  tauntDamage: (amount: number) => void = () => {};
  /** burning ground: Pyre Sermon, and ignited oil slicks (those burn the player too) */
  burnZones: { x: number; z: number; r: number; t: number; dps: number; hurtsPlayer?: boolean }[] = [];

  stats2: RunStats = { kills: 0, damageDealt: 0, ultUses: 0, room: 1, timeSec: 0 };

  constructor(
    stage: Stage,
    gore: Gore,
    particles: Particles,
    input: Input,
    seed: number,
    ultDef: UltimateDef,
    trait: TraitId,
    events: GameEvents,
  ) {
    this.stage = stage;
    this.gore = gore;
    this.particles = particles;
    this.input = input;
    this.rng = new Rng(seed);
    this.events = events;
    this.ultDef = ultDef;
    this.trait = trait;
    this.playerHp = this.stats.maxHp;
    this.playerMesh = buildPlayer(ultDef.color, trait, ultDef.accent); // doctrine + livery on the armor
    this.stage.scene.add(this.playerMesh.root);
    this.ultRunner = new UltimateRunner(this);
    this.loadRoom(1);
  }

  destroy() {
    this.clearRoomEntities();
    this.stage.scene.remove(this.playerMesh.root);
    disposeGroup(this.playerMesh.root);
    this.ultRunner.abort();
    this.stage.setScorched(false);
    this.stage.setDoorOpen(false);
  }

  // ------------------------------------------------------------------ cards
  get cardCtx(): CardContext {
    const self2 = this;
    return {
      stats: this.stats,
      ult: {
        get tier() { return self2.ultTier; },
        set tier(v: number) { self2.ultTier = v; },
        get chargeRateBonus() { return self2.ultChargeRateBonus; },
        set chargeRateBonus(v: number) { self2.ultChargeRateBonus = v; },
        get potency() { return self2.ultPotency; },
        set potency(v: number) { self2.ultPotency = v; },
        get overcharged() { return self2.ultOvercharged; },
        set overcharged(v: boolean) { self2.ultOvercharged = v; },
      },
      heal: (n) => { this.playerHp = Math.min(this.stats.maxHp, this.playerHp + n); },
      loseMaxHpPct: (p) => {
        this.stats.maxHp = Math.round(this.stats.maxHp * (1 - p));
        this.playerHp = Math.min(this.playerHp, this.stats.maxHp);
      },
    };
  }

  get ultPotencyMult(): number {
    return TIER_MULT[this.ultTier - 1] * this.ultPotency;
  }
  get ultChargeNeed(): number {
    return this.ultDef.chargeNeed;
  }
  get ultReady(): boolean {
    return this.ultCharge >= this.ultChargeNeed && !this.ultRunner.active && this.ultWindupT <= 0;
  }
  get boss(): Enemy | null {
    return this.enemies.find((e) => e.def.behavior === 'boss') ?? null;
  }

  addDread(points: number) {
    if (this.ultWindupT > 0) return;
    this.ultCharge = Math.min(this.ultChargeNeed, this.ultCharge + points * (1 + this.ultChargeRateBonus));
  }

  // ------------------------------------------------------------------ rooms
  private clearRoomEntities() {
    for (const e of this.enemies) {
      this.stage.scene.remove(e.mesh.root);
      disposeGroup(e.mesh.root);
    }
    this.enemies = [];
    for (const p of this.projectiles) {
      this.stage.scene.remove(p.mesh);
      disposeGroup(p.mesh);
    }
    this.projectiles = [];
    for (const o of this.orbs) {
      this.stage.scene.remove(o.mesh);
      disposeGroup(o.mesh);
    }
    this.orbs = [];
    for (const m of this.xpMotes) this.stage.scene.remove(m.mesh);
    this.xpMotes = [];
    for (const d of this.destructibles) d.mesh.removeFromParent();
    this.destructibles = [];
    this.burnZones = [];
    this.tauntPos = null;
    this.ultRunner.abort();
  }

  loadRoom(n: number) {
    for (const m of this.xpMotes) this.grantXp(m.xp); // bank stragglers — no XP lost
    this.clearRoomEntities();
    this.gore.clear();
    this.stage.setScorched(false);
    this.stage.setDoorOpen(false);
    this.room = n;
    this.stats2.room = Math.max(this.stats2.room, n);
    this.roomCleared = false;
    this.playerPos.set(0, 0, HALF_D - 2);
    this.playerVel.set(0, 0, 0);
    this.facing = Math.PI; // face north, into the room
    const built = this.stage.buildRoom(this.rng, {
      boss: n === FINAL_ROOM,
      elite: n === 5 || n === 10,
      room: n,
    });
    this.obstacles = built.colliders;
    this.placeDestructibles(n, built.explosives);
    this.refreshSolidObstacles();
    this.flow.setObstacles(this.obstacles);
    this.flow.compute(this.playerPos.x, this.playerPos.z);
    this.flowT = 0.25;
    this.stage.snapCamera(this.playerPos.z);

    if (n === FINAL_ROOM) {
      this.spawnEnemy(ENEMIES.foreman, 0, -8);
      this.spawnEnemy(ENEMIES.husk, -4, -5);
      this.spawnEnemy(ENEMIES.husk, 4, -5);
      sfx.bossRoar();
      this.stage.addShake(0.5);
      return;
    }

    // wave plan: an opening wave plus mid-fight reinforcements. A room is
    // roughly a minute of fighting, and later rooms bring more and worse.
    this.wavesLeft = n <= 2 ? 1 : n <= 9 ? 2 : 3; // the breach (3) fights in two waves
    if (n === 1) {
      // walk in, hear the wind, THEN they come — and the music holds back too
      this.waveDelayT = 3;
    } else {
      this.spawnWave(false);
    }
  }

  /**
   * zone-themed enemy pools: the streets crawl with the dead and the vermin,
   * industrial decks field the machines, the crew spaces keep their crew.
   */
  private roomPool(n: number): { def: EnemyDef; w: number }[] {
    const E = ENEMIES;
    // ranged presence runs HIGH throughout — the air should be full of things
    // to dodge, not just teeth to outrun
    // (spitter weights carry a 1.25x bump — the light ranged line leads the hell)
    if (n <= 2) return [{ def: E.husk, w: 4 }, { def: E.crawler, w: 3 }, { def: E.spitter, w: 1.25 }]; // surface
    if (n === 3) return [{ def: E.husk, w: 3 }, { def: E.crawler, w: 2 }, { def: E.spitter, w: 2.5 }];
    if (n <= 5) return [{ def: E.ram, w: 3 }, { def: E.polyp, w: 3 }, { def: E.spitter, w: 1.25 }, { def: E.crawler, w: 1 }]; // cargo
    if (n === 6) return [{ def: E.husk, w: 3 }, { def: E.wretch, w: 2 }, { def: E.spitter, w: 2.5 }]; // quarters
    if (n === 7) return [{ def: E.crawler, w: 5 }, { def: E.spitter, w: 2.5 }, { def: E.husk, w: 1 }]; // mess
    if (n === 8) return [{ def: E.spitter, w: 5 }, { def: E.crawler, w: 2 }, { def: E.polyp, w: 1 }]; // hydroponics
    if (n <= 10) return [{ def: E.ram, w: 3 }, { def: E.polyp, w: 3 }, { def: E.wretch, w: 1 }, { def: E.spitter, w: 1.25 }]; // engines
    if (n === 11) return [{ def: E.wretch, w: 3 }, { def: E.spitter, w: 2.5 }, { def: E.ram, w: 1 }, { def: E.polyp, w: 1 }];
    if (n === 12) return [{ def: E.wretch, w: 2 }, { def: E.polyp, w: 3 }, { def: E.spitter, w: 2.5 }]; // reactor
    if (n === 13) return [{ def: E.wretch, w: 3 }, { def: E.spitter, w: 3.75 }, { def: E.polyp, w: 1 }]; // control
    return [{ def: E.polyp, w: 4 }, { def: E.ram, w: 2 }, { def: E.spitter, w: 2.5 }]; // fire control
  }

  private pickWeighted(pool: { def: EnemyDef; w: number }[]): EnemyDef {
    const total = pool.reduce((s, p) => s + p.w, 0);
    let r = this.rng.next() * total;
    for (const p of pool) {
      r -= p.w;
      if (r <= 0) return p.def;
    }
    return pool[0].def;
  }

  /** one wave of themed enemies; reinforcements announce themselves */
  private spawnWave(reinforcement: boolean) {
    const n = this.room;
    let budget = (3.5 + n * 1.1) * 1.21; // +21% base pressure, all depths
    const picks: EnemyDef[] = [];
    if (!reinforcement && (n === 5 || n === 10 || (n > 10 && this.rng.chance(0.35)))) {
      picks.push(ENEMIES.bulwark);
      budget -= ENEMIES.bulwark.cost;
    }
    if (!reinforcement && n === 14) {
      // the armory opens with three heavies bearing down the racks
      for (let i = 0; i < 3; i++) {
        picks.push(ENEMIES.ram);
        budget -= ENEMIES.ram.cost;
      }
    }
    const pool = this.roomPool(n);
    let guard = 60;
    while (budget > 0.4 && guard-- > 0) {
      const def = this.pickWeighted(pool);
      if (def.cost > budget + 0.3) continue;
      picks.push(def);
      budget -= def.cost;
    }

    const placed: { x: number; z: number }[] = [];
    for (const def of picks) {
      let x = 0;
      let z = 0;
      for (let attempt = 0; attempt < 30; attempt++) {
        x = this.rng.range(-HALF_W + 1.6, HALF_W - 1.6);
        z = this.rng.range(-HALF_D + 1.6, HALF_D - 7.5);
        const dp = Math.hypot(x - this.playerPos.x, z - this.playerPos.z);
        if (dp < 6) continue;
        if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < 1.4)) continue;
        if (this.obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 0.8)) continue;
        break;
      }
      placed.push({ x, z });
      const e = this.spawnEnemy(def, x, z);
      if (reinforcement) {
        e.aggroed = true;
        this.stage.ring(e.pos, 1.6, 0xff5030, 0.6);
      }
    }
    if (reinforcement) {
      sfx.slamWarn();
      this.stage.addShake(0.2);
    }
  }

  /** breakable set dressing: exploding barrels + small cathartic clutter */
  private placeDestructibles(room: number, zoneExplosives?: { x: number; z: number; r: number; mesh: THREE.Object3D }[]) {
    // zone-authored explosives (ammo racks, fuel piles) become live barrels
    for (const ex of zoneExplosives ?? []) {
      const collider: Collider = { x: ex.x, z: ex.z, r: ex.r };
      this.obstacles.push(collider);
      this.destructibles.push({
        kind: 'barrel',
        pos: new THREE.Vector3(ex.x, 0, ex.z),
        r: ex.r,
        hp: 12,
        mesh: ex.mesh,
        collider,
        fuse: 0,
      });
    }
    if (room === FINAL_ROOM) return;
    const spot = (): { x: number; z: number } | null => {
      for (let a = 0; a < 25; a++) {
        const x = this.rng.range(-HALF_W + 2, HALF_W - 2);
        const z = this.rng.range(-HALF_D + 2.5, HALF_D - 7);
        if (Math.abs(x) < 2.4 && z < -HALF_D + 4) continue; // door lane
        if (this.obstacles.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 1.2)) continue;
        if (this.destructibles.some((d) => Math.hypot(d.pos.x - x, d.pos.z - z) < 2)) continue;
        return { x, z };
      }
      return null;
    };
    // fuel barrels (from room 2 on)
    if (room >= 2) {
      const barrels = this.rng.int(1, 2);
      for (let i = 0; i < barrels; i++) {
        const s = spot();
        if (!s) continue;
        const mesh = buildExplosiveBarrel();
        mesh.position.set(s.x, 0, s.z);
        this.stage.scene.add(mesh);
        const collider: Collider = { x: s.x, z: s.z, r: 0.6 };
        this.obstacles.push(collider);
        this.destructibles.push({
          kind: 'barrel',
          pos: new THREE.Vector3(s.x, 0, s.z),
          r: 0.55,
          hp: 10,
          mesh,
          collider,
          fuse: 0,
        });
      }
    }
    // small breakables, themed loosely by where we are
    const zone = zoneForRoom(room);
    const smallKind: Destructible['kind'] = zone.outdoor ? 'canister' : room === 6 || room === 7 ? 'cup' : 'crate';
    const count = this.rng.int(3, 5);
    for (let i = 0; i < count; i++) {
      const s = spot();
      if (!s) continue;
      const mesh = buildSmallProp(smallKind as 'crate' | 'cup' | 'canister');
      mesh.position.set(s.x, 0, s.z);
      mesh.rotation.y = this.rng.range(0, Math.PI * 2);
      this.stage.scene.add(mesh);
      this.destructibles.push({
        kind: smallKind,
        pos: new THREE.Vector3(s.x, 0, s.z),
        r: smallKind === 'cup' ? 0.22 : 0.42,
        hp: 1,
        mesh,
        collider: null,
        fuse: 0,
      });
    }
  }

  damageDestructible(d: Destructible, amount: number) {
    if (!this.destructibles.includes(d)) return;
    d.hp -= amount;
    if (d.hp > 0) return;
    const idx = this.destructibles.indexOf(d);
    this.destructibles.splice(idx, 1);
    d.mesh.removeFromParent(); // works whether it lives on the scene or in the room group
    if (d.collider) {
      const ci = this.obstacles.indexOf(d.collider);
      if (ci >= 0) this.obstacles.splice(ci, 1);
      this.refreshSolidObstacles();
      this.flow.setObstacles(this.obstacles);
      this.flow.compute(this.playerPos.x, this.playerPos.z);
    }
    const rand = () => this.rng.next();
    const p = d.pos.clone().setY(0.4);
    if (d.kind === 'barrel') {
      // the whole point of painting it red
      sfx.explosion();
      this.stage.addShake(0.55);
      this.stage.ring(d.pos, 4, 0xff8a3a, 0.4);
      this.particles.explosion(p, 1.5); // the pack's detonation flipbook
      this.particles.fire(p, 10, 1.6);
      this.particles.sparks(p, 10, undefined, 1.6);
      this.particles.puff(p.clone().setY(0.8), 4, { size: 1.3, dark: true, life: 1.8 });
      this.gore.burst(p, rand, 10, 1.6, 'metal');
      this.gore.scorch(d.pos.x, d.pos.z, rand, 1.8);
      this.stage.vents.push({ pos: p.clone().setY(0.2), kind: 'smoke', rate: 4, ttl: 3 });
      for (const e of [...this.enemies]) {
        if (e.state === 'spawn') continue;
        const dist = e.pos.distanceTo(d.pos);
        if (dist < 3.2) {
          const dir = new THREE.Vector3().subVectors(e.pos, d.pos).setY(0).normalize();
          this.damageEnemy(e, 32, 'ult', { dir, kbForce: 6 });
        }
      }
      if (this.playerPos.distanceTo(d.pos) < 3.2) this.damagePlayer(16);
      for (const other of [...this.destructibles]) {
        if (other.fuse <= 0 && other.pos.distanceTo(d.pos) < 3.2) {
          other.fuse = other.kind === 'barrel' ? 0.14 : 0.05; // chain reaction
        }
      }
    } else {
      sfx.propBreak();
      this.gore.burst(p.setY(0.25), rand, d.kind === 'cup' ? 5 : 7, 0.6, d.kind === 'cup' ? 'bone' : 'brass');
    }
  }

  private updateDestructibles(dt: number) {
    for (const d of [...this.destructibles]) {
      if (d.fuse > 0) {
        d.fuse -= dt;
        if (d.fuse <= 0) this.damageDestructible(d, 999);
      }
    }
  }

  spawnEnemy(def: EnemyDef, x: number, z: number): Enemy {
    const mesh = buildEnemy(def);
    mesh.root.position.set(x, -1.2, z);
    this.stage.scene.add(mesh.root);
    const e: Enemy = {
      def,
      hp: scaleHp(def.hp, this.room),
      maxHp: scaleHp(def.hp, this.room),
      pos: new THREE.Vector3(x, 0, z),
      radius: def.radius,
      damage: scaleDamage(def.damage, this.room),
      state: 'spawn',
      stateT: 0.8,
      attackCd: this.rng.range(0.2, 1),
      kb: new THREE.Vector3(),
      lungeDir: new THREE.Vector3(),
      lungeHit: false,
      mesh,
      hitFlashT: 0,
      burnT: 0,
      burnDps: 0,
      burnTickT: 0,
      frenzied: false,
      frenzyDotT: 0,
      targetEnemy: null,
      fireLight: null,
      facing: 0,
      walkPhase: this.rng.range(0, 6.28),
      animSpeed: 0,
      torn: new Set(),
      aggroed: false,
      boss: def.behavior === 'boss'
        ? { attack: 'idle', attackT: 0, cooldown: 2, chargeDir: new THREE.Vector3(), chargeHit: false, phase2: false, addsSpawned: [false, false], addsPending: 0, addsDelayT: 0 }
        : null,
    };
    this.enemies.push(e);
    return e;
  }

  // ----------------------------------------------------------------- combat
  damageEnemy(
    e: Enemy,
    amount: number,
    source: 'player' | 'ult' | 'enemy',
    opts: {
      vaporize?: boolean;
      execute?: boolean;
      selfInflicted?: boolean;
      /** impact direction — shoves the target, scaled down by its bulk */
      dir?: THREE.Vector3;
      kbForce?: number;
      /** DoT ticks: no hit-flash, no shove — the flames are the feedback */
      silent?: boolean;
    } = {},
  ) {
    if (e.hp <= 0 || e.state === 'spawn') return;
    const before = e.hp;
    e.hp -= amount;
    if (!opts.silent) e.hitFlashT = 0.09;
    if (!opts.silent && e.def.gore === 'machine') {
      // armor takes the round: sparks grind off on every hit
      this.particles.sparks(e.pos.clone().setY(0.6 * e.def.scale), 4, opts.dir, 0.9);
      if (this.rng.chance(0.3)) this.particles.electric(e.pos.clone().setY(0.7 * e.def.scale), 2);
    }
    e.aggroed = true; // pain wakes the distant ones
    if (opts.dir && e.def.behavior !== 'boss') {
      const force = (opts.kbForce ?? 3.2) / Math.max(0.5, e.def.scale);
      e.kb.addScaledVector(opts.dir, force);
      if (e.kb.length() > 10) e.kb.setLength(10);
    }
    // heavy hits on the living: flinch, and sometimes something comes off
    if (e.hp > 0 && amount > e.maxHp * 0.25 && e.def.behavior !== 'boss') {
      if (e.state === 'windup') {
        e.state = 'recover';
        e.stateT = 0.3; // staggered out of the attack
      }
      if (source === 'player' && this.rng.chance(0.45)) {
        const arms = (['armL', 'armR'] as const).filter(
          (k) => (e.mesh.rig as Record<string, THREE.Object3D | undefined>)[k] && !e.torn.has(k),
        );
        if (arms.length > 0) {
          this.dismember(e, this.rng.pick(arms), opts.dir, 0.8);
          this.hitStopT = Math.max(this.hitStopT, 0.03);
        }
      }
    }
    if (source === 'player') {
      this.stats2.damageDealt += amount;
      this.addDread(amount);
      if (this.stats.lifesteal > 0) {
        this.playerHp = Math.min(this.stats.maxHp, this.playerHp + amount * this.stats.lifesteal);
      }
    } else if (source === 'ult') {
      this.stats2.damageDealt += amount;
    }
    if (e.hp <= 0) {
      const overkill = opts.execute || amount >= before * 2;
      if (overkill) this.hitStopT = Math.max(this.hitStopT, 0.07); // impact frames
      this.killEnemy(e, { overkill, ...opts });
    } else {
      sfx.hit();
    }
  }

  /**
   * tear a rig part off — the actual mesh leaves the body and tumbles away,
   * bleeding. `key` is the AnimRig field so animation stops driving it.
   */
  private dismember(e: Enemy, key: 'head' | 'armL' | 'armR' | 'legL' | 'legR' | 'legL2' | 'legR2', dir?: THREE.Vector3, power = 1): boolean {
    const rig = e.mesh.rig as Record<string, THREE.Object3D | undefined>;
    const part = rig[key];
    if (!part || e.torn.has(key)) return false;
    e.torn.add(key);
    rig[key] = undefined;
    const wp = new THREE.Vector3();
    const wq = new THREE.Quaternion();
    part.getWorldPosition(wp);
    part.getWorldQuaternion(wq);
    part.removeFromParent();
    part.position.copy(wp);
    part.quaternion.copy(wq);
    this.stage.scene.add(part);
    const rand = () => this.rng.next();
    const vel = new THREE.Vector3((rand() - 0.5) * 3, 3.5 + rand() * 3.5, (rand() - 0.5) * 3);
    if (dir) vel.addScaledVector(dir, (3.5 + rand() * 3) * power);
    this.gore.addDebris(
      part,
      vel,
      new THREE.Vector3((rand() - 0.5) * 16, (rand() - 0.5) * 16, (rand() - 0.5) * 16),
    );
    if (e.def.gore === 'machine') {
      // sheared joint: sparks, hydraulic fluid, no blood
      this.particles.sparks(wp, 6, undefined, 1);
      this.particles.electric(wp, 3);
      this.gore.burst(wp, rand, 3, 0.9, 'metal', dir);
      this.gore.splat(wp.x, wp.z, rand, 2, 0.8, true);
      sfx.slamWarn();
    } else {
      // the stump erupts
      this.particles.mist(wp, 4);
      this.gore.burst(wp, rand, 3, 0.9, 'meat', dir);
      this.gore.splat(wp.x, wp.z, rand, 2, 0.8);
      sfx.tear();
    }
    return true;
  }

  /** which parts this enemy can still lose */
  private tearablekeys(e: Enemy): ('head' | 'armL' | 'armR' | 'legL' | 'legR' | 'legL2' | 'legR2')[] {
    const rig = e.mesh.rig as Record<string, THREE.Object3D | undefined>;
    const all = ['head', 'armL', 'armR', 'legL', 'legR', 'legL2', 'legR2'] as const;
    return all.filter((k) => rig[k] && !e.torn.has(k));
  }

  killEnemy(
    e: Enemy,
    opts: { overkill?: boolean; vaporize?: boolean; selfInflicted?: boolean; execute?: boolean; dir?: THREE.Vector3 } = {},
  ) {
    const idx = this.enemies.indexOf(e);
    if (idx === -1) return;
    this.enemies.splice(idx, 1);
    if (e.fireLight) {
      this.stage.releaseLight(e.fireLight);
      e.fireLight = null;
    }
    this.stats2.kills++;

    const rand = () => this.rng.next();
    const p = e.pos.clone();
    p.y = 0.5 * e.def.scale;
    const isBoss = e.def.behavior === 'boss';
    const machine = e.def.gore === 'machine';
    const chunk: 'meat' | 'metal' = machine ? 'metal' : 'meat';

    if (opts.vaporize) {
      // per-ultimate death state: no blood, just ash and a scorch shadow
      this.gore.burst(p, rand, 10, 0.9, 'ash');
      this.gore.scorch(e.pos.x, e.pos.z, rand, e.def.scale);
    } else if (opts.overkill || opts.selfInflicted) {
      // the body comes APART — real limbs first, then everything else
      if (opts.execute || opts.selfInflicted) this.dismember(e, 'head', opts.dir, 1.4); // executions take the head
      let torn = 0;
      for (const key of this.tearablekeys(e)) {
        if (torn >= (isBoss ? 2 : 4)) break;
        if (this.rng.chance(0.85)) {
          this.dismember(e, key, opts.dir, 1.2);
          torn++;
        }
      }
      this.gore.burst(p, rand, 28 + Math.floor(e.def.scale * 12), 1.5, chunk, opts.dir);
      this.gore.burst(p, rand, 8, 1.2, machine ? 'metal' : 'bone', opts.dir);
      this.gore.splat(e.pos.x, e.pos.z, rand, 7, 1.4 * e.def.scale, machine);
      this.gore.pool(e.pos.x, e.pos.z, e.def.scale, machine);
      if (opts.dir) this.gore.spray(e.pos.x, e.pos.z, opts.dir.x, opts.dir.z, 6, 1.1 * e.def.scale, machine);
      if (machine) {
        this.particles.sparks(p, 12, undefined, 1.4);
        this.particles.electric(p, 6);
        this.particles.puff(p, 3, { size: 0.9, dark: true });
        sfx.explosion();
      } else {
        this.particles.mist(p, 8);
        sfx.splat(true);
      }
      this.stage.addShake(0.4);
      this.splatterWalls(e.pos, 1.3 * e.def.scale, machine);
    } else {
      // even a clean kill loses pieces
      const keys = this.tearablekeys(e);
      if (keys.length > 0) this.dismember(e, this.rng.pick(keys), opts.dir, 0.9);
      if (keys.length > 2 && this.rng.chance(0.5)) this.dismember(e, this.rng.pick(this.tearablekeys(e)), opts.dir, 0.9);
      this.gore.burst(p, rand, 12, 0.95, chunk, opts.dir);
      this.gore.splat(e.pos.x, e.pos.z, rand, 4, e.def.scale, machine);
      this.gore.pool(e.pos.x, e.pos.z, 0.8 * e.def.scale, machine);
      if (opts.dir && this.rng.chance(0.6)) this.gore.spray(e.pos.x, e.pos.z, opts.dir.x, opts.dir.z, 4, 0.8 * e.def.scale, machine);
      if (machine) {
        this.particles.sparks(p, 7, undefined, 1);
        this.particles.puff(p, 2, { size: 0.7, dark: true });
        sfx.slamWarn();
      } else {
        this.particles.mist(p, 4);
        sfx.splat(false);
      }
      this.stage.addShake(0.18); // every kill lands
      this.splatterWalls(e.pos, 0.9 * e.def.scale, machine);
    }

    this.stage.scene.remove(e.mesh.root);

    if (e.def.behavior === 'boss') {
      this.hitStopT = Math.max(this.hitStopT, 0.3);
      this.stage.addShake(1);
      this.gore.burst(p, rand, 60, 2.6, 'meat');
      this.gore.burst(p, rand, 16, 2.2, 'bone');
      this.gore.splat(e.pos.x, e.pos.z, rand, 18, 3);
      this.gore.pool(e.pos.x, e.pos.z, 2.6);
      this.particles.mist(p, 14);
      sfx.bossRoar();
      this.over = true;
      setTimeout(() => this.events.onVictory(), 1400);
      return;
    }

    // the dead leave their experience on the floor — collected only when the
    // room falls silent (Archero-style)
    if (e.def.xp > 0) {
      const mote = buildXpMote();
      mote.position.set(e.pos.x, 0.3, e.pos.z);
      this.stage.scene.add(mote);
      this.xpMotes.push({
        pos: new THREE.Vector3(e.pos.x, 0.3, e.pos.z),
        mesh: mote,
        xp: e.def.xp,
        flying: false,
        flyT: 0,
        t: this.rng.range(0, 6.28),
      });
    }
    if (this.rng.chance(0.1)) {
      const mesh = buildOrb();
      mesh.position.set(e.pos.x, 0.4, e.pos.z);
      this.stage.scene.add(mesh);
      this.orbs.push({ pos: new THREE.Vector3(e.pos.x, 0, e.pos.z), mesh, t: 0 });
    }

    if (!this.roomCleared && this.enemies.length === 0 && this.wavesLeft === 0 && this.room !== FINAL_ROOM) {
      this.roomCleared = true;
      this.stage.setDoorOpen(true);
      sfx.door();
      // harvest AFTER the last body finishes coming apart — the kill gets its
      // beat before the reward sequence starts
      this.harvestT = 0.9;
    }
  }

  private grantXp(n: number) {
    this.xp += n;
    while (this.xp >= this.xpNext) {
      this.xp -= this.xpNext;
      this.level++;
      // steep curve: ~1 level per room early, ~1 per 2 rooms by the deep floors
      this.xpNext = 10 + (this.level - 1) * 18;
      this.pendingLevelUps++;
    }
    // the wheel does NOT open here — the ceremony in update() paces it
  }

  consumeLevelUp(): boolean {
    if (this.pendingLevelUps <= 0) return false;
    this.pendingLevelUps--;
    this.events.onLevelUp();
    return true;
  }

  damagePlayer(amount: number) {
    if (this.invulnT > 0 || this.hurtCdT > 0 || this.over) return;
    this.playerHp -= amount;
    this.hurtCdT = 0.45;
    this.addDread(amount * 3); // desperation fuel (DESIGN.md §5.1)
    this.stage.addShake(0.35);
    this.particles.mist(this.playerPos.clone().setY(0.9), 2);
    this.gore.splat(this.playerPos.x, this.playerPos.z, () => this.rng.next(), 1, 0.6);
    sfx.hurt();
    document.getElementById('fx-red')!.style.opacity = '1';
    setTimeout(() => (document.getElementById('fx-red')!.style.opacity = '0'), 300);
    if (this.playerHp <= 0) {
      this.playerHp = 0;
      this.over = true;
      const p = this.playerPos.clone();
      p.y = 0.8;
      this.gore.burst(p, () => this.rng.next(), 50, 2.0, 'meat');
      this.gore.burst(p, () => this.rng.next(), 10, 1.6, 'bone');
      this.gore.splat(p.x, p.z, () => this.rng.next(), 12, 2);
      this.gore.pool(p.x, p.z, 2.2);
      this.particles.mist(p, 12);
      this.playerMesh.root.visible = false;
      sfx.splat(true);
      sfx.tear();
      this.stage.addShake(1);
      setTimeout(() => this.events.onDeath(), 1200);
    }
  }

  private firePlayerVolley(target: Enemy) {
    const dir = new THREE.Vector3().subVectors(target.pos, this.playerPos).setY(0).normalize();
    this.facing = Math.atan2(dir.x, dir.z);
    const n = this.stats.multishot;
    const spread = 0.14;
    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * spread;
      const d = dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), off);
      // Twin Barrel doctrine: every bolt is a parallel PAIR (side by side,
      // same heading — not a spread), and every future volley upgrade keeps it
      const lateral = this.trait === 'twinbarrel' ? [-0.17, 0.17] : [0];
      const right = new THREE.Vector3(d.z, 0, -d.x);
      for (const lat of lateral) {
        const crit = this.rng.chance(this.stats.critChance);
        const mesh = buildBolt(crit ? 0xff6a3c : 0xffdf8a);
        const ox = this.playerPos.x + right.x * lat;
        const oz = this.playerPos.z + right.z * lat;
        mesh.position.set(ox, 0.85, oz);
        mesh.rotation.y = Math.atan2(d.x, d.z);
        this.stage.scene.add(mesh);
        this.projectiles.push({
          pos: new THREE.Vector3(ox, 0, oz),
          vel: d.clone().multiplyScalar(18),
          damage: this.stats.damage * (crit ? 2 : 1),
          fromPlayer: true,
          targetEnemies: false,
          pierceLeft: this.stats.pierce,
          ricochetLeft: this.stats.ricochet,
          hit: new Set(),
          burnDps: this.stats.burnDps,
          mesh,
          life: 2.2,
          hitRadius: 0.5,
          light: this.stage.lendLight(0xffb054, 6, 5), // pooled — constant scene light count
        });
      }
    }
    // firing has a body: recoil, flash, brass, sparks, smoke — and a rumble
    // that grows with the weight of the volley
    const volleyBolts = n * (this.trait === 'twinbarrel' ? 2 : 1);
    this.recoil = 0.14;
    this.stage.muzzleFlash(this.playerPos.x, this.playerPos.z);
    this.stage.addShake(Math.min(0.17, 0.05 + volleyBolts * 0.018));
    const fwd = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
    const muzzle = this.playerPos.clone().addScaledVector(fwd, 0.75);
    muzzle.y = 1.05;
    this.particles.sparks(muzzle, 3, fwd, 0.5);
    this.particles.puff(muzzle, 1, { size: 0.55, life: 0.8 });
    const right = new THREE.Vector3(Math.cos(this.facing), 0, -Math.sin(this.facing));
    const eject = this.playerPos.clone().addScaledVector(right, 0.4);
    eject.y = 1;
    this.gore.burst(eject, () => this.rng.next(), 1, 0.45, 'brass');
    sfx.shot();
  }

  fireEnemyGlob(from: Enemy, targetPos: THREE.Vector3, atEnemies: boolean, angleOffset = 0) {
    const dir = new THREE.Vector3().subVectors(targetPos, from.pos).setY(0).normalize();
    if (angleOffset !== 0) dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), angleOffset);
    const mesh = buildGlob();
    mesh.position.set(from.pos.x, 0.8, from.pos.z);
    this.stage.scene.add(mesh);
    this.projectiles.push({
      pos: from.pos.clone().setY(0),
      vel: dir.multiplyScalar(6.98), // −7%: dodgeable by reading, not by luck
      damage: from.damage * (atEnemies ? 2 : 1),
      fromPlayer: false,
      targetEnemies: atEnemies,
      pierceLeft: 0,
      ricochetLeft: 0,
      hit: new Set([from]),
      burnDps: 0,
      mesh,
      life: 3.5,
      hitRadius: 0.5,
      // fan volleys only light their center glob — the pool is small
      light: angleOffset === 0 ? this.stage.lendLight(0x9dff4a, 5, 4) : null,
    });
    if (angleOffset === 0) sfx.enemyShot();
  }

  /** turret mortar: big, slow, glowing — the whole point is walking out of the way */
  fireMortar(from: Enemy, targetPos: THREE.Vector3) {
    const dir = new THREE.Vector3().subVectors(targetPos, from.pos).setY(0).normalize();
    const mesh = buildMortarOrb();
    mesh.position.set(from.pos.x, 0.85, from.pos.z);
    this.stage.scene.add(mesh);
    this.projectiles.push({
      pos: from.pos.clone().setY(0),
      vel: dir.multiplyScalar(3.3),
      damage: from.damage,
      fromPlayer: false,
      targetEnemies: from.frenzied,
      pierceLeft: 0,
      ricochetLeft: 0,
      hit: new Set([from]),
      burnDps: 0,
      mesh,
      life: 14, // long enough to cross the entire two-screen room
      hitRadius: 0.8,
      light: this.stage.lendLight(0xff8038, 8, 5),
    });
    const muzzle = from.pos.clone().setY(1);
    this.particles.sparks(muzzle, 4, dir, 0.6);
    this.particles.puff(muzzle, 2, { size: 0.8, dark: true });
    sfx.mortarShot();
  }

  /** kills near a wall paint it — blood (or oil) climbs the bulkheads */
  private splatterWalls(pos: THREE.Vector3, sizeMult: number, oil: boolean) {
    if (zoneForRoom(this.room).outdoor) return; // no walls out there
    const rand = () => this.rng.next();
    const y = 0.5 + this.rng.next() * 0.9;
    const reach = 2.2 * sizeMult;
    if (pos.x + HALF_W < reach) this.gore.wallSplat(-HALF_W, y, pos.z, 1, rand, 3, sizeMult, oil);
    if (HALF_W - pos.x < reach) this.gore.wallSplat(HALF_W, y, pos.z, 2, rand, 3, sizeMult, oil);
    if (pos.z + HALF_D < reach && Math.abs(pos.x) > 2.4) this.gore.wallSplat(pos.x, y, -HALF_D, 3, rand, 3, sizeMult, oil);
    if (HALF_D - pos.z < reach) this.gore.wallSplat(pos.x, y, HALF_D, 4, rand, 3, sizeMult, oil);
  }

  private refreshSolidObstacles() {
    this.solidObstacles = this.obstacles.filter((o) => !this.destructibles.some((d) => d.collider === o));
  }

  /** shove a position out of any obstacle it overlaps */
  private pushOut(pos: THREE.Vector3, radius: number) {
    for (const o of this.obstacles) {
      const dx = pos.x - o.x;
      const dz = pos.z - o.z;
      const d = Math.hypot(dx, dz);
      const min = o.r + radius;
      if (d > 0.001 && d < min) {
        pos.x += (dx / d) * (min - d);
        pos.z += (dz / d) * (min - d);
      }
    }
  }

  private hitsObstacle(pos: THREE.Vector3): boolean {
    return this.obstacles.some((o) => Math.hypot(pos.x - o.x, pos.z - o.z) < o.r);
  }

  nearestEnemy(from: THREE.Vector3, exclude?: Set<Enemy> | Enemy): Enemy | null {
    let best: Enemy | null = null;
    let bd = Infinity;
    for (const e of this.enemies) {
      if (e.state === 'spawn') continue;
      if (exclude instanceof Set && exclude.has(e)) continue;
      if (exclude === e) continue;
      const d = from.distanceToSquared(e.pos);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  /** nearest enemy the shooter can actually see — no wasting bolts on cover */
  nearestVisibleEnemy(from: THREE.Vector3): Enemy | null {
    let best: Enemy | null = null;
    let bd = Infinity;
    for (const e of this.enemies) {
      if (e.state === 'spawn') continue;
      const d = from.distanceToSquared(e.pos);
      if (d >= bd) continue;
      if (!losClear(from.x, from.z, e.pos.x, e.pos.z, this.solidObstacles, 0.25)) continue;
      bd = d;
      best = e;
    }
    return best;
  }

  // ----------------------------------------------------------------- update
  update(dt: number) {
    if (this.paused || this.over) return;
    if (this.hitStopT > 0) {
      // frozen impact frames — the world holds its breath
      this.hitStopT -= dt;
      return;
    }
    this.stats2.timeSec += dt;
    this.invulnT = Math.max(0, this.invulnT - dt);
    this.hurtCdT = Math.max(0, this.hurtCdT - dt);
    sfx.setCombat(this.enemies.length > 0);
    sfx.tick(dt);

    // flow field toward the player, a few times a second — cheap BFS, and
    // every enemy gets obstacle-aware routing for free
    this.flowT -= dt;
    if (this.flowT <= 0) {
      this.flowT = 0.25;
      this.flow.compute(this.playerPos.x, this.playerPos.z);
    }

    this.updatePlayer(dt);
    this.ultRunner.update(dt);
    this.updateEnemies(dt);
    this.updateProjectiles(dt);
    this.updateOrbs(dt);
    this.updateXpMotes(dt);
    this.updateDestructibles(dt);
    this.updateBurnZones(dt);
    if (this.waveDelayT > 0) {
      this.waveDelayT -= dt;
      if (this.waveDelayT <= 0) this.spawnWave(false);
    }
    if (this.harvestT > 0) {
      this.harvestT -= dt;
      if (this.harvestT <= 0) {
        for (const m of this.xpMotes) m.flying = true;
      }
    }
    // no wave business while an ultimate holds the stage: the strike clears
    // the room, THEN the silence, THEN whatever comes next
    if (!this.roomCleared && !this.ultRunner.active && this.waveDelayT <= 0 && this.wavesLeft > 0 && this.room !== FINAL_ROOM) {
      const alive = this.enemies.filter((e) => e.state !== 'spawn').length;
      if (this.enemies.length === 0) {
        // strictly sequential wave: the field went silent (ult wipe, last
        // kill) — hold TWO SECONDS before the next one drops
        this.waveGapT += dt;
        if (this.waveGapT >= 2) {
          this.waveGapT = 0;
          this.wavesLeft--;
          this.spawnWave(true);
        }
      } else if (alive <= 2 && alive === this.enemies.length) {
        // overlap wave: the fight thinned to its last two — reinforce NOW.
        // (alive === length keeps a freshly-risen wave from counting as
        // "thinned" while its members are still in spawn state)
        this.waveGapT = 0;
        this.wavesLeft--;
        this.spawnWave(true);
      } else {
        this.waveGapT = 0;
      }
    }

    this.updateVents(dt);
    this.ambientSparkT -= dt;
    if (this.ambientSparkT <= 0) {
      this.ambientSparkT = this.rng.range(35, 60);
      const sp = new THREE.Vector3(this.rng.range(-10, 10), this.rng.range(2.2, 3.8), this.playerPos.z + this.rng.range(-9, 4));
      const ang = this.rng.range(0, Math.PI * 2);
      this.particles.streak(sp, new THREE.Vector3(Math.cos(ang), this.rng.range(-0.15, 0.05), Math.sin(ang)));
    }
    this.syncMeshes(dt);

    // level-up sequence: motes stream in → the moment lands (riff, banner,
    // gold ring) → only then the Rite Wheel appears
    this.moteGraceT = Math.max(0, this.moteGraceT - dt);
    if (this.pendingLevelUps > 0 && this.xpMotes.length === 0 && this.moteGraceT <= 0 && this.ceremonyT <= 0) {
      this.ceremonyT = 1.35;
      sfx.levelUpRiff();
      this.stage.ring(this.playerPos, 4.5, 0xd8c25a, 0.9, this.playerPos); // rides with the player
      this.stage.addShake(0.3);
      this.particles.electric(this.playerPos.clone().setY(1.2), 10, 0xd8c25a);
      this.events.onCeremony();
    }
    if (this.ceremonyT > 0) {
      this.ceremonyT -= dt;
      if (this.rng.chance(dt * 24)) this.particles.ember(this.playerPos.clone().setY(0.4), 2);
      if (this.ceremonyT <= 0) this.consumeLevelUp();
    }
  }

  private updatePlayer(dt: number) {
    const mv = this.input.move();
    const locked = this.ultRunner.lockPlayer || this.ultWindupT > 0;
    this.moving = !locked && (mv.x !== 0 || mv.z !== 0);

    // heavy armor: accelerate in, coast out — not a hockey puck, not a tank.
    // Once the room is clear there is nothing left to dodge: double-time it.
    const sprint = this.roomCleared ? 1.55 : 1;
    const k = 1 - Math.exp(-(this.moving ? 9 : 13) * dt);
    this.playerVel.x += (mv.x * this.stats.moveSpeed * sprint * (locked ? 0 : 1) - this.playerVel.x) * k;
    this.playerVel.z += (mv.z * this.stats.moveSpeed * sprint * (locked ? 0 : 1) - this.playerVel.z) * k;
    this.playerPos.x += this.playerVel.x * dt;
    this.playerPos.z += this.playerVel.z * dt;
    if (this.moving) {
      this.facing = Math.atan2(mv.x, mv.z);
      this.bobT += dt * sprint;
      if (this.trait !== 'runandgun') {
        this.fireCd = Math.max(this.fireCd, 0.12); // brief settle before firing resumes
      }
      this.stepT -= dt;
      if (this.stepT <= 0) {
        this.stepT = 0.3 / sprint;
        sfx.footstep(this.room <= 2); // dirt outside, deck plating inside
      }
    }
    this.recoil *= Math.exp(-11 * dt);
    this.playerPos.x = THREE.MathUtils.clamp(this.playerPos.x, -HALF_W + 0.6, HALF_W - 0.6);
    this.playerPos.z = THREE.MathUtils.clamp(this.playerPos.z, -HALF_D + 0.6, HALF_D - 0.6);
    this.pushOut(this.playerPos, 0.55);

    // firing (only while still — unless the Run & Gun doctrine says otherwise);
    // targets need line of sight
    this.fireCd -= dt;
    const canFire = (!this.moving || this.trait === 'runandgun') && !locked;
    if (canFire && this.fireCd <= 0) {
      const target = this.nearestVisibleEnemy(this.playerPos);
      if (target) {
        this.firePlayerVolley(target);
        this.fireCd = 1 / this.stats.fireRate;
      }
    }

    // ultimate activation — the one sacred click
    const clicked = this.input.consumeUltimate();
    if (clicked && this.ultReady) {
      this.ultWindupT = 0.4;
      sfx.windup();
    }
    if (this.ultWindupT > 0) {
      this.ultWindupT -= dt;
      this.invulnT = Math.max(this.invulnT, 0.1);
      if (this.ultWindupT <= 0) {
        this.ultCharge = 0;
        this.stats2.ultUses++;
        if (this.ultOvercharged) {
          this.playerHp = Math.max(1, this.playerHp - this.stats.maxHp * 0.15);
        }
        this.stage.addShake(0.35); // the relic answers
        this.ultRunner.start(this.ultDef.id);
      }
    }

    // door exit
    if (this.roomCleared && this.playerPos.z < -HALF_D + 1 && Math.abs(this.playerPos.x) < 1.6) {
      this.events.onRoomExit();
    }
  }

  private updateEnemies(dt: number) {
    // pairwise separation so crowds read as a crowd, not a stack
    for (let i = 0; i < this.enemies.length; i++) {
      for (let j = i + 1; j < this.enemies.length; j++) {
        const a = this.enemies[i];
        const b = this.enemies[j];
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d = Math.hypot(dx, dz);
        const min = a.radius + b.radius;
        if (d > 0.001 && d < min) {
          // rooted turrets don't budge — the other party does all the yielding
          const aFixed = a.def.behavior === 'turret';
          const bFixed = b.def.behavior === 'turret';
          const push = ((min - d) / d) * (aFixed || bFixed ? 1 : 0.5);
          if (!aFixed) {
            a.pos.x -= dx * push;
            a.pos.z -= dz * push;
          }
          if (!bFixed) {
            b.pos.x += dx * push;
            b.pos.z += dz * push;
          }
        }
      }
    }

    for (const e of [...this.enemies]) {
      e.hitFlashT = Math.max(0, e.hitFlashT - dt);
      e.attackCd = Math.max(0, e.attackCd - dt);

      // knockback integrates for everything, even mid-attack
      if (e.kb.lengthSq() > 0.001) {
        e.pos.addScaledVector(e.kb, dt);
        e.kb.multiplyScalar(Math.exp(-7 * dt));
      }

      // the badly hurt leave a trail — blood, or oil and stray sparks
      if (e.hp < e.maxHp * 0.4 && e.def.behavior !== 'boss') {
        const machine = e.def.gore === 'machine';
        if (this.rng.chance(dt * 3.5)) {
          this.gore.splat(e.pos.x, e.pos.z, () => this.rng.next(), 1, 0.4 * e.def.scale, machine);
        }
        if (this.rng.chance(dt * 1.2)) {
          if (machine) this.particles.sparks(e.pos.clone().setY(0.5 * e.def.scale), 2, undefined, 0.5);
          else this.particles.mist(e.pos.clone().setY(0.5 * e.def.scale), 1);
        }
      }

      // burn DoT — the enemy IS on fire: constant flames, embers, its own light
      if (e.burnT > 0) {
        e.burnT -= dt;
        e.burnTickT -= dt;
        if (!e.fireLight) {
          e.fireLight = this.stage.lendLight(0xff7b24, 9, 6); // pooled; null when the pool is dry
        }
        if (e.fireLight) {
          e.fireLight.position.set(e.pos.x, 0.8 * e.def.scale, e.pos.z);
          e.fireLight.intensity = 8 + Math.sin(this.stats2.timeSec * 21 + e.walkPhase) * 3 + this.rng.next() * 2;
        }
        if (this.rng.chance(dt * 30)) {
          this.particles.fire(e.pos.clone().setY(0.45 * e.def.scale), 1, e.def.scale);
        }
        if (this.rng.chance(dt * 8)) this.particles.ember(e.pos.clone().setY(0.8 * e.def.scale), 1);
        if (this.rng.chance(dt * 4)) {
          this.particles.puff(e.pos.clone().setY(1.0 * e.def.scale), 1, { size: 0.6, dark: true });
        }
        // a burning body wading through spilled oil torches the whole slick
        if (this.rng.chance(dt * 14)) {
          const pools = this.gore.igniteOilNear(e.pos.x, e.pos.z, e.radius + 0.35);
          if (pools.length > 0) {
            sfx.fire();
            for (const p of pools) {
              this.burnZones.push({ x: p.x, z: p.z, r: p.r + 0.15, t: 4.5, dps: 8, hurtsPlayer: true });
              this.particles.fire(new THREE.Vector3(p.x, 0.08, p.z), 5, 1.3);
              this.particles.puff(new THREE.Vector3(p.x, 0.6, p.z), 2, { size: 1.0, dark: true, life: 1.6 });
            }
          }
        }
        if (e.burnTickT <= 0) {
          e.burnTickT = 0.25;
          this.damageEnemy(e, e.burnDps * 0.25, 'ult', { silent: true });
          if (e.hp <= 0) continue;
        }
      } else if (e.fireLight) {
        this.stage.releaseLight(e.fireLight);
        e.fireLight = null;
      }
      // red choir aftermath bleed
      if (e.frenzyDotT > 0) {
        e.frenzyDotT -= dt;
        e.burnTickT -= dt;
        if (e.burnTickT <= 0) {
          e.burnTickT = 0.25;
          this.damageEnemy(e, 1.5, 'ult', { silent: true });
          if (e.hp <= 0) continue;
        }
      }

      if (e.boss) {
        this.updateBoss(e, dt);
        continue;
      }

      switch (e.state) {
        case 'spawn':
          e.stateT -= dt;
          if (e.stateT <= 0) e.state = 'chase';
          break;
        case 'stun':
          e.stateT -= dt;
          if (e.stateT <= 0) e.state = 'chase';
          break;
        case 'doomed': {
          e.stateT -= dt;
          if (e.stateT <= 0) {
            this.damageEnemy(e, e.hp + 1, 'ult', { selfInflicted: true });
          }
          break;
        }
        case 'chase':
          this.enemyChase(e, dt);
          break;
        case 'windup':
          e.stateT -= dt;
          // shocker channels crackle while building
          if (e.def.behavior === 'shocker' && this.rng.chance(dt * 22)) {
            this.particles.electric(e.pos.clone().setY(1.4 * e.def.scale), 1);
          }
          if (e.stateT <= 0) {
            if (e.def.behavior === 'ranged') {
              const tp = this.rangedTargetPos(e);
              if (tp) {
                // deeper decks: spitters volley a three-glob fan — walk BETWEEN them
                if (this.room >= 5) {
                  for (const off of [-0.32, 0, 0.32]) this.fireEnemyGlob(e, tp, e.frenzied, off);
                } else {
                  this.fireEnemyGlob(e, tp, e.frenzied);
                }
              }
              e.state = 'recover';
              e.stateT = 0.6;
            } else if (e.def.behavior === 'turret') {
              const tp = this.acquireTargetPos(e);
              if (tp) this.fireMortar(e, tp);
              e.state = 'recover';
              e.stateT = 0.8;
            } else if (e.def.behavior === 'shocker') {
              this.shockerZap(e);
              e.state = 'recover';
              e.stateT = 1.2;
            } else if (e.def.behavior === 'charger') {
              e.state = 'lunge';
              e.stateT = 0.9;
              e.lungeHit = false;
            } else {
              e.state = 'lunge';
              e.stateT = 0.28;
              e.lungeHit = false;
            }
          }
          break;
        case 'lunge': {
          e.stateT -= dt;
          const isRam = e.def.behavior === 'charger';
          e.pos.addScaledVector(e.lungeDir, e.def.speed * (isRam ? 7 : 3.6) * dt);
          e.walkPhase += dt * 12;
          e.animSpeed = 1;
          this.tryContactHit(e);
          if (isRam) {
            const atWall =
              e.pos.x <= -HALF_W + e.radius + 0.05 || e.pos.x >= HALF_W - e.radius - 0.05 ||
              e.pos.z <= -HALF_D + e.radius + 0.05 || e.pos.z >= HALF_D - e.radius - 0.05;
            const atCover = this.obstacles.some(
              (o) => Math.hypot(e.pos.x - o.x, e.pos.z - o.z) < o.r + e.radius + 0.05,
            );
            if (atWall || atCover) {
              // rammed the ship instead — stunned, sparks everywhere
              e.state = 'stun';
              e.stateT = 1.1;
              this.stage.addShake(0.3);
              this.particles.sparks(e.pos.clone().setY(0.6), 8, undefined, 1.4);
              sfx.slamWarn();
              break;
            }
          }
          if (e.stateT <= 0) {
            e.state = 'recover';
            e.stateT = e.def.behavior === 'elite' ? 0.9 : isRam ? 0.8 : 0.5;
          }
          break;
        }
        case 'recover':
          e.stateT -= dt;
          if (e.stateT <= 0) e.state = 'chase';
          break;
      }

      e.pos.x = THREE.MathUtils.clamp(e.pos.x, -HALF_W + e.radius, HALF_W - e.radius);
      e.pos.z = THREE.MathUtils.clamp(e.pos.z, -HALF_D + e.radius, HALF_D - e.radius);
      this.pushOut(e.pos, e.radius);
    }
  }

  /** where this enemy is trying to hurt something */
  private acquireTargetPos(e: Enemy): THREE.Vector3 | null {
    if (e.frenzied) {
      if (!e.targetEnemy || e.targetEnemy.hp <= 0 || !this.enemies.includes(e.targetEnemy)) {
        e.targetEnemy = this.nearestEnemy(e.pos, e);
      }
      return e.targetEnemy ? e.targetEnemy.pos : null; // last one standing cowers
    }
    if (this.tauntPos && e.pos.distanceTo(this.tauntPos) < 7) return this.tauntPos;
    return this.playerPos;
  }

  private rangedTargetPos(e: Enemy): THREE.Vector3 | null {
    return this.acquireTargetPos(e);
  }

  /**
   * obstacle-aware steering: direct when line of sight is clear (or when the
   * target isn't the player), otherwise follow the flow field around cover
   */
  private navDir(e: Enemy, targetPos: THREE.Vector3, direct: THREE.Vector3): THREE.Vector3 {
    if (targetPos !== this.playerPos) return direct;
    if (this.obstacles.length === 0) return direct;
    if (losClear(e.pos.x, e.pos.z, targetPos.x, targetPos.z, this.obstacles, Math.min(e.radius, 0.5))) {
      return direct;
    }
    const f = this.flow.dirAt(e.pos.x, e.pos.z);
    if (f) return direct.set(f.x, 0, f.z);
    return direct;
  }

  private enemyChase(e: Enemy, dt: number) {
    const targetPos = this.acquireTargetPos(e);
    e.animSpeed += (0 - e.animSpeed) * Math.min(1, dt * 6); // decays unless movement bumps it
    if (!targetPos) {
      // frenzied survivor with no one left to kill: twitch in place
      e.pos.x += (this.rng.next() - 0.5) * dt;
      e.pos.z += (this.rng.next() - 0.5) * dt;
      return;
    }
    const dir = new THREE.Vector3().subVectors(targetPos, e.pos).setY(0);
    const dist = dir.length();
    if (dist > 0.001) dir.divideScalar(dist);
    e.facing = Math.atan2(dir.x, dir.z);
    const speedMult = e.frenzied ? 1.5 : 1;

    // (no aggro leash — the whole room hunts you from the moment you enter)

    // rooted mortar: aim, wait, lob — the whole room is in range
    if (e.def.behavior === 'turret') {
      if (e.attackCd <= 0) {
        e.state = 'windup';
        e.stateT = 0.9;
        e.attackCd = 2.9; // mortars land more often
      }
      return;
    }

    // shocker: close to mid-range, then channel the arc
    if (e.def.behavior === 'shocker' && !e.frenzied) {
      const range = e.def.range ?? 5;
      if (dist > range) {
        const nav = this.navDir(e, targetPos, dir);
        e.pos.addScaledVector(nav, e.def.speed * speedMult * dt);
        e.facing = Math.atan2(nav.x, nav.z);
        e.walkPhase += dt * e.def.speed * 4;
        e.animSpeed = 1;
      } else if (e.attackCd <= 0) {
        e.state = 'windup';
        e.stateT = 0.9;
        e.attackCd = 3.0;
      }
      return;
    }

    // charger: stalk, then wind up a room-crossing ram (aim locks at windup start)
    if (e.def.behavior === 'charger' && !e.frenzied) {
      if (dist > 8 || e.attackCd > 0) {
        const nav = this.navDir(e, targetPos, dir);
        e.pos.addScaledVector(nav, e.def.speed * speedMult * dt);
        e.facing = Math.atan2(nav.x, nav.z);
        e.walkPhase += dt * e.def.speed * 4;
        e.animSpeed = 1;
      } else {
        e.state = 'windup';
        e.stateT = 0.9;
        e.attackCd = 4.2;
        e.lungeDir.copy(dir);
        sfx.slamWarn();
      }
      return;
    }

    if (e.def.behavior === 'ranged' && !e.frenzied) {
      const range = e.def.range ?? 6.5;
      if (dist < range - 1) e.pos.addScaledVector(dir, -e.def.speed * speedMult * dt);
      else if (dist > range + 1.5) {
        const nav = this.navDir(e, targetPos, dir);
        e.pos.addScaledVector(nav, e.def.speed * speedMult * dt);
        e.facing = Math.atan2(nav.x, nav.z);
      } else {
        // strafe
        e.pos.x += -dir.z * e.def.speed * 0.4 * dt;
        e.pos.z += dir.x * e.def.speed * 0.4 * dt;
      }
      e.walkPhase += dt * e.def.speed * 3;
      e.animSpeed = 0.7;
      if (e.attackCd <= 0 && dist < range + 2) {
        e.state = 'windup';
        e.stateT = 0.55;
        e.attackCd = 1.9; // spitters keep the air busy
      }
      return;
    }

    const reach = e.radius + 0.45 + 0.35;
    if (dist > reach) {
      let sp = e.def.speed * speedMult;
      if (e.def.behavior === 'swarm') {
        // skittering jitter
        e.pos.x += (this.rng.next() - 0.5) * 2.2 * dt;
        e.pos.z += (this.rng.next() - 0.5) * 2.2 * dt;
      }
      const nav = this.navDir(e, targetPos, dir);
      e.pos.addScaledVector(nav, sp * dt);
      e.facing = Math.atan2(nav.x, nav.z);
      e.walkPhase += dt * sp * 4;
      e.animSpeed = 1;
    } else if (e.attackCd <= 0) {
      e.state = 'windup';
      e.stateT = e.def.behavior === 'swarm' ? 0.55 : e.def.behavior === 'elite' ? 0.7 : 0.5;
      e.attackCd = e.def.behavior === 'swarm' ? 1.1 : 1.6;
      e.lungeDir.copy(dir);
    }
  }

  /** shocker discharge: instant arc to its target if still in range — outrange it during the channel */
  private shockerZap(e: Enemy) {
    const range = (e.def.range ?? 5) + 1.5;
    const from = e.pos.clone().setY(1.4 * e.def.scale);
    const targetPos = this.acquireTargetPos(e);
    if (!targetPos) return;
    const dist = e.pos.distanceTo(targetPos);
    if (dist > range) {
      // discharge into the deck — you dodged it
      const miss = e.pos.clone().addScaledVector(new THREE.Vector3().subVectors(targetPos, e.pos).normalize(), 1.5);
      this.stage.zap(from, miss.setY(0.1), 0x9adfff);
      this.particles.electric(miss, 4);
      sfx.zap();
      return;
    }
    this.stage.zap(from, targetPos.clone().setY(0.8), 0x9adfff);
    this.particles.electric(targetPos.clone().setY(0.8), 8);
    this.particles.puff(targetPos.clone().setY(0.9), 2, { size: 0.6, dark: true, life: 1.1 }); // ozone scorch
    sfx.zap();
    if (e.frenzied && e.targetEnemy) {
      this.damageEnemy(e.targetEnemy, e.damage * 2, 'enemy');
    } else if (this.tauntPos && targetPos === this.tauntPos) {
      this.tauntDamage(e.damage);
    } else {
      this.damagePlayer(e.damage);
    }
  }

  private tryContactHit(e: Enemy) {
    if (e.lungeHit) return;
    const dmg = e.damage * (e.frenzied ? 2 : 1);
    if (e.frenzied) {
      const t = e.targetEnemy;
      if (t && t.hp > 0 && e.pos.distanceTo(t.pos) < e.radius + t.radius + 0.2) {
        e.lungeHit = true;
        const dirV = new THREE.Vector3().subVectors(t.pos, e.pos).setY(0).normalize();
        this.damageEnemy(t, dmg, 'enemy', { dir: dirV, kbForce: 4.5 });
        this.gore.splat(t.pos.x, t.pos.z, () => this.rng.next(), 3, 0.9);
        this.particles.mist(t.pos.clone().setY(0.6), 2);
      }
      return;
    }
    if (this.tauntPos && e.pos.distanceTo(this.tauntPos) < e.radius + 0.9) {
      e.lungeHit = true;
      this.tauntDamage(dmg);
      return;
    }
    if (e.pos.distanceTo(this.playerPos) < e.radius + 0.5) {
      e.lungeHit = true;
      this.damagePlayer(dmg);
    }
  }

  private updateBoss(e: Enemy, dt: number) {
    const b = e.boss!;
    if (e.state === 'spawn') {
      e.stateT -= dt;
      if (e.stateT <= 0) e.state = 'chase';
      return;
    }
    if (e.state === 'stun' || e.state === 'doomed') {
      e.stateT -= dt;
      if (e.stateT <= 0) e.state = 'chase';
      return;
    }

    // phase 2: the machine stops pretending to follow safety regulations
    if (!b.phase2 && e.hp < e.maxHp * 0.5) {
      b.phase2 = true;
      sfx.bossRoar();
      this.stage.addShake(0.7);
    }
    // add waves earned at 66% / 33% — but delivered TWO SECONDS later, never
    // in the same breath as the blow that crossed the threshold
    if (!b.addsSpawned[0] && e.hp < e.maxHp * 0.66) {
      b.addsSpawned[0] = true;
      b.addsPending++;
    }
    if (!b.addsSpawned[1] && e.hp < e.maxHp * 0.33) {
      b.addsSpawned[1] = true;
      b.addsPending++;
    }
    if (b.addsPending > 0) {
      b.addsDelayT += dt;
      if (b.addsDelayT >= 2) {
        b.addsDelayT = 0;
        b.addsPending--;
        this.spawnBossAdds();
      }
    }

    const speedMult = b.phase2 ? 1.45 : 1;
    const toPlayer = new THREE.Vector3().subVectors(this.playerPos, e.pos).setY(0);
    const dist = toPlayer.length();
    const dir = dist > 0.001 ? toPlayer.clone().divideScalar(dist) : new THREE.Vector3(0, 0, 1);
    e.facing = Math.atan2(dir.x, dir.z);

    switch (b.attack) {
      case 'idle': {
        e.pos.addScaledVector(dir, e.def.speed * speedMult * dt);
        b.cooldown -= dt;
        if (b.cooldown <= 0) {
          if (dist > 4.5) {
            b.attack = 'charge-warn';
            b.attackT = 0.7;
            b.chargeDir.copy(dir);
            sfx.bossRoar();
          } else {
            b.attack = 'slam-warn';
            b.attackT = 0.8;
            this.stage.ring(e.pos, 4.6, 0xff5030, 0.8);
            sfx.slamWarn();
          }
        }
        // walking contact
        if (dist < e.radius + 0.6) this.damagePlayer(e.damage * 0.6);
        break;
      }
      case 'charge-warn':
        b.attackT -= dt;
        b.chargeDir.copy(dir); // tracks until launch
        if (b.attackT <= 0) {
          b.attack = 'charging';
          b.attackT = 1.1;
          b.chargeHit = false;
        }
        break;
      case 'charging': {
        b.attackT -= dt;
        e.pos.addScaledVector(b.chargeDir, 9 * dt);
        if (!b.chargeHit && e.pos.distanceTo(this.playerPos) < e.radius + 0.7) {
          b.chargeHit = true;
          this.damagePlayer(e.damage * 1.4);
        }
        const hitWall =
          e.pos.x <= -HALF_W + e.radius || e.pos.x >= HALF_W - e.radius ||
          e.pos.z <= -HALF_D + e.radius || e.pos.z >= HALF_D - e.radius;
        if (hitWall || b.attackT <= 0) {
          this.stage.addShake(0.5);
          sfx.slamWarn();
          b.attack = 'idle';
          b.cooldown = b.phase2 ? 1.6 : 2.6;
        }
        break;
      }
      case 'slam-warn':
        b.attackT -= dt;
        if (b.attackT <= 0) {
          this.stage.ring(e.pos, 4.6, 0xffa060, 0.3);
          this.stage.addShake(0.6);
          sfx.slamWarn();
          this.gore.burst(e.pos.clone().setY(0.4), () => this.rng.next(), 8, 1.2, 'ash');
          if (this.playerPos.distanceTo(e.pos) < 4.6) {
            this.damagePlayer(e.damage * 1.2);
          }
          b.attack = 'idle';
          b.cooldown = b.phase2 ? 1.4 : 2.4;
        }
        break;
    }

    e.pos.x = THREE.MathUtils.clamp(e.pos.x, -HALF_W + e.radius, HALF_W - e.radius);
    e.pos.z = THREE.MathUtils.clamp(e.pos.z, -HALF_D + e.radius, HALF_D - e.radius);
  }

  private spawnBossAdds() {
    for (let i = 0; i < 3; i++) {
      this.spawnEnemy(ENEMIES.crawler, this.rng.range(-8, 8), this.rng.range(-6, -2));
    }
    this.spawnEnemy(ENEMIES.husk, this.rng.range(-8, 8), this.rng.range(-6, -2));
  }

  private updateProjectiles(dt: number) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      p.pos.addScaledVector(p.vel, dt);
      // breakables take the hit before generic cover does — but only from the
      // PLAYER's fire: enemy globs and mortars sail over everything
      if (p.fromPlayer) {
        for (const d of this.destructibles) {
          if (p.pos.distanceTo(d.pos) < d.r + 0.15) {
            this.damageDestructible(d, p.damage);
            p.life = -1;
            break;
          }
        }
      }
      let dead = p.life <= 0 ||
        Math.abs(p.pos.x) > HALF_W - 0.2 || Math.abs(p.pos.z) > HALF_D - 0.2 ||
        (p.fromPlayer && this.hitsObstacle(p.pos)); // cover blocks bolts, not bile

      if (!dead && (p.fromPlayer || p.targetEnemies)) {
        for (const e of this.enemies) {
          if (e.state === 'spawn' || p.hit.has(e)) continue;
          if (p.pos.distanceTo(e.pos) < e.radius + 0.18) {
            p.hit.add(e);
            const impactDir = p.vel.clone().setY(0).normalize();
            const isCrit = p.fromPlayer && p.damage > this.stats.damage;
            if (isCrit) this.stage.addShake(0.08); // big hits rumble
            this.damageEnemy(e, p.damage, p.fromPlayer ? 'player' : 'enemy', {
              dir: impactDir,
              kbForce: isCrit ? 5.2 : 3.2, // crits shove HARD
            });
            if (p.burnDps > 0 && e.hp > 0) {
              e.burnT = 3;
              e.burnDps = Math.max(e.burnDps, p.burnDps);
            }
            const wound = e.pos.clone().setY(0.7 * e.def.scale);
            if (e.def.gore === 'machine') {
              // armor-piercing impact (sparks come from damageEnemy): parts, oil
              this.gore.burst(wound, () => this.rng.next(), 3, 0.6, 'metal', impactDir);
              this.gore.splat(e.pos.x, e.pos.z, () => this.rng.next(), 1, 0.6, true);
            } else {
              // wet impact: meat chips off, mist hangs, spatter walks away from the wound
              this.gore.burst(wound, () => this.rng.next(), 5, 0.65, 'meat', impactDir);
              this.particles.mist(wound, 3);
              this.gore.splat(e.pos.x, e.pos.z, () => this.rng.next(), 2, 0.7);
              if (this.rng.chance(0.35)) {
                this.gore.spray(e.pos.x, e.pos.z, impactDir.x, impactDir.z, 3, 0.6);
              }
            }
            if (p.pierceLeft > 0) {
              p.pierceLeft--;
            } else if (p.ricochetLeft > 0) {
              const next = this.nearestEnemy(p.pos, p.hit);
              if (next && p.pos.distanceTo(next.pos) < 9) {
                p.ricochetLeft--;
                const d = new THREE.Vector3().subVectors(next.pos, p.pos).setY(0).normalize();
                p.vel.copy(d.multiplyScalar(p.vel.length()));
                p.mesh.rotation.y = Math.atan2(d.x, d.z);
              } else {
                dead = true;
              }
            } else {
              dead = true;
            }
            break;
          }
        }
      } else if (!dead && !p.fromPlayer) {
        if (p.pos.distanceTo(this.playerPos) < p.hitRadius) {
          this.damagePlayer(p.damage);
          dead = true;
        }
      }

      if (p.light) p.light.position.set(p.pos.x, 0.85, p.pos.z);
      if (dead) {
        this.stage.releaseLight(p.light);
        // metal impacts spark — walls, crates, spent bolts
        if (p.fromPlayer && p.life > 0) {
          this.particles.sparks(p.pos.clone().setY(0.6), 4, undefined, 0.8);
        }
        this.stage.scene.remove(p.mesh);
        disposeGroup(p.mesh);
        this.projectiles.splice(i, 1);
      } else {
        p.mesh.position.set(p.pos.x, 0.85, p.pos.z);
      }
    }
  }

  private updateXpMotes(dt: number) {
    for (let i = this.xpMotes.length - 1; i >= 0; i--) {
      const m = this.xpMotes[i];
      m.t += dt;
      if (!m.flying) {
        // idle glitter where it fell
        m.mesh.position.set(m.pos.x, 0.3 + Math.sin(m.t * 3) * 0.06, m.pos.z);
        m.mesh.rotation.y += dt * 2;
        continue;
      }
      // direct homing — no inertia, so nothing can end up orbiting the player;
      // speed ramps with flight time and a timeout hard-collects stragglers
      m.flyT += dt;
      const dir = new THREE.Vector3(this.playerPos.x - m.pos.x, 0.8 - m.pos.y, this.playerPos.z - m.pos.z);
      const dist = dir.length();
      const speed = 7 + m.flyT * 26;
      const step = speed * dt;
      if (dist < Math.max(1.1, step) || m.flyT > 2.5) {
        this.grantXp(m.xp);
        this.moteCombo++;
        this.moteGraceT = 0.45;
        sfx.mote(this.moteCombo);
        this.stage.scene.remove(m.mesh);
        this.xpMotes.splice(i, 1);
        continue;
      }
      m.pos.addScaledVector(dir.normalize(), step);
      m.mesh.position.copy(m.pos);
      m.mesh.rotation.y += dt * 10;
    }
    if (this.xpMotes.length === 0) this.moteCombo = 0;
  }

  private updateOrbs(dt: number) {
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      o.t += dt;
      const d = o.pos.distanceTo(this.playerPos);
      if (d < 2.6) {
        const dir = new THREE.Vector3().subVectors(this.playerPos, o.pos).normalize();
        o.pos.addScaledVector(dir, 8 * dt);
      }
      o.mesh.position.set(o.pos.x, 0.35 + Math.sin(o.t * 4) * 0.1, o.pos.z);
      if (d < 0.6) {
        this.playerHp = Math.min(this.stats.maxHp, this.playerHp + 15);
        sfx.pickup();
        this.stage.scene.remove(o.mesh);
        disposeGroup(o.mesh);
        this.orbs.splice(i, 1);
      }
    }
  }

  /** ambient zone emitters: burning wrecks, steam manifolds, sparking cables */
  private updateVents(dt: number) {
    for (let i = this.stage.vents.length - 1; i >= 0; i--) {
      const v = this.stage.vents[i];
      if (v.ttl !== undefined) {
        v.ttl -= dt;
        if (v.ttl <= 0) {
          this.stage.vents.splice(i, 1);
          continue;
        }
      }
      if (!this.rng.chance(dt * v.rate)) continue;
      switch (v.kind) {
        case 'fire':
          this.particles.fire(v.pos, 1, 1.2);
          if (this.rng.chance(0.3)) this.particles.ember(v.pos, 1);
          if (this.rng.chance(0.2)) this.particles.puff(v.pos.clone().setY(v.pos.y + 0.5), 1, { size: 0.9, dark: true });
          break;
        case 'steam':
          this.particles.puff(v.pos, 1, { size: 0.7, rise: 2, life: 1.1 });
          break;
        case 'spark':
          this.particles.sparks(v.pos, 2, undefined, 0.7);
          if (this.rng.chance(0.3)) this.particles.electric(v.pos, 1);
          if (this.rng.chance(0.25)) this.particles.puff(v.pos, 1, { size: 0.5, dark: true, life: 0.9 }); // scorched wiring smolders
          break;
        case 'smoke':
          // rising column — tall, dark, slow
          this.particles.puff(v.pos, 1, { size: 1.6, dark: true, rise: 2.2, life: 2.6 });
          break;
      }
    }
  }

  private updateBurnZones(dt: number) {
    for (let i = this.burnZones.length - 1; i >= 0; i--) {
      const z = this.burnZones[i];
      z.t -= dt;
      if (z.t <= 0) {
        this.burnZones.splice(i, 1);
        continue;
      }
      if (this.rng.chance(dt * 9)) {
        const a = this.rng.range(0, Math.PI * 2);
        const r = this.rng.range(0, z.r);
        this.particles.fire(
          new THREE.Vector3(z.x + Math.cos(a) * r, 0.05, z.z + Math.sin(a) * r),
          1,
          1.1,
        );
      }
      for (const e of this.enemies) {
        if (e.state === 'spawn') continue;
        if (Math.hypot(e.pos.x - z.x, e.pos.z - z.z) < z.r + e.radius) {
          e.burnT = Math.max(e.burnT, 0.3);
          e.burnDps = Math.max(e.burnDps, z.dps);
        }
      }
      // ignited oil doesn't care whose boots are in it
      if (z.hurtsPlayer && Math.hypot(this.playerPos.x - z.x, this.playerPos.z - z.z) < z.r + 0.4) {
        this.damagePlayer(6); // hurt cooldown gates this to grazing ticks
        if (this.rng.chance(dt * 18)) this.particles.fire(this.playerPos.clone().setY(0.9), 2, 0.9);
      }
    }
  }

  private syncMeshes(dt: number) {
    // player: bob while marching, kick backward on recoil, rig animation
    const pm = this.playerMesh.root;
    const bob = this.moving ? Math.abs(Math.sin(this.bobT * 9)) * 0.06 : 0;
    const backX = -Math.sin(this.facing) * this.recoil;
    const backZ = -Math.cos(this.facing) * this.recoil;
    pm.position.set(this.playerPos.x + backX, bob, this.playerPos.z + backZ);
    const targetRot = this.facing;
    let dr = targetRot - pm.rotation.y;
    while (dr > Math.PI) dr -= Math.PI * 2;
    while (dr < -Math.PI) dr += Math.PI * 2;
    pm.rotation.y += dr * Math.min(1, dt * 14);
    animatePlayer(this.playerMesh.rig, {
      moving: this.moving,
      bobT: this.bobT,
      recoil: this.recoil,
      windup: this.ultWindupT,
      time: this.stats2.timeSec,
    });
    // relic glow tracks dread charge; at full charge it arcs and smokes
    const frac = this.ultCharge / this.ultChargeNeed;
    this.playerMesh.relicMat.opacity = 0.2 + frac * 0.8;
    const back = new THREE.Vector3(-Math.sin(this.facing) * 0.45, 1.05, -Math.cos(this.facing) * 0.45).add(this.playerPos);
    if (frac >= 1 && this.rng.chance(dt * 7)) {
      this.particles.electric(back, 2, this.ultDef.color);
    }
    if (this.rng.chance(dt * 0.8)) {
      this.particles.puff(back.clone().setY(1.5), 1, { size: 0.4, life: 0.9 }); // exhaust stacks breathe
    }
    if (this.ultWindupT > 0) {
      pm.scale.setScalar(1 + Math.sin(this.ultWindupT * 40) * 0.04);
      this.particles.electric(back, 1, this.ultDef.color);
    } else {
      pm.scale.setScalar(1);
    }

    // enemies
    const time = this.stats2.timeSec;
    for (const e of this.enemies) {
      const r = e.mesh.root;
      let y = 0;
      if (e.state === 'spawn') {
        y = -1.2 * (e.stateT / 0.8);
      }
      let jx = 0;
      let jz = 0;
      if (e.state === 'doomed') {
        jx = (this.rng.next() - 0.5) * 0.12;
        jz = (this.rng.next() - 0.5) * 0.12;
      }
      r.position.set(e.pos.x + jx, y, e.pos.z + jz);
      r.rotation.y = e.facing;
      animateEnemy(e, time);
      // hit flash
      const flash = e.hitFlashT > 0 ? 1 : 0;
      for (const m of e.mesh.flashMats) {
        m.emissive.setRGB(flash * 0.9, flash * 0.85, flash * 0.8);
      }
      // windup telegraph: eyes flare white (≥0.5s readable, DESIGN.md §6.2)
      const winding = e.state === 'windup';
      for (const m of e.mesh.eyeMats) {
        if (e.frenzied) m.color.setHex(0xff1010);
        else if (winding) m.color.setHex(0xffffff);
        else m.color.setHex(e.def.eyeColor);
      }
      const sac = r.userData.sac as THREE.Mesh | undefined;
      if (sac) {
        sac.scale.setScalar(winding ? 1 + Math.sin((0.7 - e.stateT) * 20) * 0.25 : 1);
      }
      // the Foreman's stacks belch smoke; charging grinds sparks off the deck
      if (e.def.behavior === 'boss') {
        for (const key of ['stackL', 'stackR'] as const) {
          const off = r.userData[key] as THREE.Vector3 | undefined;
          if (off && this.rng.chance(dt * 4)) {
            const world = off.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), e.facing).add(e.pos);
            this.particles.puff(world, 1, { size: 0.8, dark: true, rise: 1.4 });
          }
        }
        if (e.boss?.attack === 'charging' && this.rng.chance(dt * 30)) {
          this.particles.sparks(e.pos.clone().setY(0.25), 2, undefined, 1.2);
        }
      }
    }
  }
}

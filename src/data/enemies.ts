// Act 1 bestiary — the Grafted (DESIGN.md §6.1).
// All stats are base values; per-room scaling is applied at spawn time.
// Damage tuning: every hit must matter — the weakest kill the crusader
// (100 hp) in 5 hits, the bulkiest in ~3. Bigger and tougher hits harder.

export type EnemyBehavior =
  | 'melee' // closes distance, lunges
  | 'swarm' // fast, weak, skittering
  | 'ranged' // kites and spits
  | 'turret' // rooted, lobs slow dodgeable mortars
  | 'shocker' // approaches mid-range, channels an electric arc
  | 'charger' // winds up, rams across the room
  | 'elite'
  | 'boss';

export interface EnemyDef {
  id: string;
  name: string;
  behavior: EnemyBehavior;
  hp: number;
  speed: number;
  damage: number;
  radius: number;
  xp: number;
  /** spawn-budget cost when composing a room */
  cost: number;
  /** ranged only: preferred firing distance */
  range?: number;
  bodyColor: number;
  eyeColor: number;
  scale: number;
  /** what comes out when it breaks: meat bleeds, machines shed oil and parts */
  gore: 'meat' | 'machine';
}

export const ENEMIES: Record<string, EnemyDef> = {
  husk: {
    id: 'husk',
    gore: 'meat',
    name: 'Сращенец',
    behavior: 'melee',
    hp: 26,
    speed: 1.89,
    damage: 25,
    radius: 0.42,
    xp: 4,
    cost: 1,
    bodyColor: 0x6b8556,
    eyeColor: 0xff7b1c,
    scale: 1,
  },
  crawler: {
    id: 'crawler',
    gore: 'meat',
    name: 'Ползун',
    behavior: 'swarm',
    hp: 9,
    speed: 3.28,
    damage: 20,
    radius: 0.28,
    xp: 2,
    cost: 0.5,
    bodyColor: 0x5c7a48,
    eyeColor: 0xffa040,
    scale: 0.55,
  },
  spitter: {
    id: 'spitter',
    gore: 'meat',
    name: 'Желчный плевун',
    behavior: 'ranged',
    hp: 20,
    speed: 1.58,
    damage: 24,
    radius: 0.44,
    xp: 6,
    cost: 1.5,
    range: 6.5,
    bodyColor: 0x6f9448,
    eyeColor: 0xa8ff3c,
    scale: 1,
  },
  polyp: {
    id: 'polyp',
    gore: 'meat',
    name: 'Полип-мортира',
    behavior: 'turret',
    hp: 40,
    speed: 0,
    damage: 28,
    radius: 0.55,
    xp: 7,
    cost: 2,
    range: 12,
    bodyColor: 0x7a8f54,
    eyeColor: 0xff8038,
    scale: 1.1,
  },
  wretch: {
    id: 'wretch',
    gore: 'meat',
    name: 'Проводник',
    behavior: 'shocker',
    hp: 24,
    speed: 1.4,
    damage: 26,
    radius: 0.42,
    xp: 7,
    cost: 2,
    range: 5,
    bodyColor: 0x6e8a64,
    eyeColor: 0x9adfff,
    scale: 1,
  },
  ram: {
    id: 'ram',
    gore: 'machine',
    name: 'Таран',
    behavior: 'charger',
    hp: 48,
    speed: 1.4,
    damage: 32,
    radius: 0.55,
    xp: 9,
    cost: 2.5,
    bodyColor: 0x5f7a4e,
    eyeColor: 0xffc23c,
    scale: 1.15,
  },
  bulwark: {
    id: 'bulwark',
    gore: 'meat',
    name: 'Переборщик',
    behavior: 'elite',
    hp: 170,
    speed: 1.09,
    damage: 34,
    radius: 0.8,
    xp: 25,
    cost: 6,
    bodyColor: 0x74905a,
    eyeColor: 0xff3c1c,
    scale: 1.9,
  },
  foreman: {
    id: 'foreman',
    gore: 'machine',
    name: 'ПРОРАБ',
    behavior: 'boss',
    hp: 1500,
    speed: 1.64,
    damage: 20,
    radius: 1.25,
    xp: 0,
    cost: 0,
    bodyColor: 0x7d9146,
    eyeColor: 0xffc23c,
    scale: 3.2,
  },
};

/** per-room stat scaling. The 1.25 factor = enemies effectively take 20% less
 * damage (buffing HP instead of resisting damage keeps executions working). */
export function scaleHp(base: number, room: number): number {
  return Math.round(base * 1.25 * (1 + (room - 1) * 0.13));
}
export function scaleDamage(base: number, room: number): number {
  return Math.round(base * (1 + (room - 1) * 0.05));
}

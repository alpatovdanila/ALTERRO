// Ultimate definitions (DESIGN.md §5.5). Runtime behavior lives in game/ultimates.ts;
// this module is pure data so the roster can grow without engine changes.

export type UltimateId =
  | 'gravelight'
  | 'quiet-word'
  | 'red-choir'
  | 'deadhand'
  | 'waltz'
  | 'grasp'
  | 'casket'
  | 'pyre';

export interface UltimateDef {
  id: UltimateId;
  name: string;
  epithet: string;
  desc: string;
  /** one punchy line for the casual select screen */
  short: string;
  flavor: string;
  /** dread points needed at tier 1 (damage dealt ≈ points) */
  chargeNeed: number;
  /** relic glow + VFX identity color */
  color: number;
  cssColor: string;
  /** armor livery: the trim/accent color the crusader wears for this relic */
  accent: number;
  /** locked relics show as teasers — full roster unlocks via meta-progression */
  locked?: boolean;
}

export function chargeLabel(u: UltimateDef): string {
  return u.chargeNeed <= 750 ? 'ЗАРЯД: БЫСТРЫЙ' : u.chargeNeed <= 1000 ? 'ЗАРЯД: СРЕДНИЙ' : 'ЗАРЯД: ДОЛГИЙ';
}

export const ULTIMATES: UltimateDef[] = [
  {
    id: 'gravelight',
    name: 'Гравилайт',
    epithet: 'THE RELIC CANNON',
    desc: 'Fire a colossal slow-moving orb that lashes lethal filaments into every enemy near its path, detonating against the far wall.',
    short: 'Огромный шар испепеляет всё на своём пути.',
    flavor: 'It was cut from the heart of a dead star. It is still angry about it.',
    chargeNeed: 700,
    color: 0x66ff88,
    cssColor: '#66ff88',
    accent: 0x2f6096, // cobalt livery
  },
  {
    id: 'quiet-word',
    name: 'Тихое слово',
    epithet: 'FORBIDDEN SERMON',
    desc: 'Speak the sentence. A silent wave crosses the room and every lesser enemy it touches turns its claws on itself. Bosses are wounded and stunned.',
    short: 'Одно слово — и каждый младший враг убивает себя.',
    locked: true,
    flavor: 'No one knows the word. Everyone obeys it.',
    chargeNeed: 1000,
    color: 0xb8c4ff,
    cssColor: '#b8c4ff',
    accent: 0x2f6096,
  },
  {
    id: 'red-choir',
    name: 'Красный хор',
    epithet: 'FRENZY PLAGUE',
    desc: 'For 8 seconds all enemies turn on each other with doubled damage and frothing speed. Survivors keep bleeding after the song ends.',
    short: 'Враги сходят с ума и рвут друг друга.',
    locked: true,
    flavor: 'Teach them the hymn. Watch the congregation eat itself.',
    chargeNeed: 650,
    color: 0xff2222,
    cssColor: '#ff4444',
    accent: 0x8a2a1e,
  },
  {
    id: 'deadhand',
    name: 'Орбитальный удар',
    epithet: 'ORBITAL DELETION',
    desc: 'Klaxons. A shadow. Then the arena is deleted — everything lesser dies, bosses lose a quarter of their vitality, and the floor burns.',
    short: 'Удар с орбиты накрывает всю арену.',
    flavor: 'Somewhere above, a machine keeps a promise made before you were born.',
    chargeNeed: 1200,
    color: 0xffe9a8,
    cssColor: '#ffe9a8',
    accent: 0xa8841e, // hazard yellow — the orbital strike liveries
  },
  {
    id: 'waltz',
    name: 'Вальс мясника',
    epithet: 'EXECUTION CHAIN',
    desc: 'Blink between up to 12 enemies, executing each in a single stroke. You cannot be touched while the dance lasts.',
    short: 'Мгновенные казни — от врага к врагу.',
    locked: true,
    flavor: 'Twelve partners. One song. No encore.',
    chargeNeed: 800,
    color: 0xff9a3c,
    cssColor: '#ff9a3c',
    accent: 0xa8841e,
  },
  {
    id: 'grasp',
    name: 'Хватка Полого короля',
    epithet: 'SINGULARITY',
    desc: 'Open a black sphere at the heart of the room: it drags everything in, crushes it, and ejects the remains as a shockwave of gore.',
    short: 'Чёрная дыра пожирает зал.',
    locked: true,
    flavor: 'The King reaches up through the floor of the world.',
    chargeNeed: 950,
    color: 0x9a4ae0,
    cssColor: '#b06af0',
    accent: 0x5a3c8a,
  },
  {
    id: 'casket',
    name: 'Гроб-часовой',
    epithet: 'WAR ENGINE',
    desc: 'A coffin-shaped engine falls from orbit and fights beside you for 20 seconds, drawing fury and answering it with twin cannons.',
    short: 'Боевая машина падает с орбиты и дерётся рядом.',
    locked: true,
    flavor: 'They buried it armed. On purpose.',
    chargeNeed: 850,
    color: 0x8adfff,
    cssColor: '#8adfff',
    accent: 0x2f6096,
  },
  {
    id: 'pyre',
    name: 'Огненная проповедь',
    epithet: 'FLAME PURGE',
    desc: 'A ring of white fire expands from your feet, igniting all it touches. The burning spread, and the burning ground, remain.',
    short: 'Кольцо огня сжигает всё, чего коснётся.',
    locked: true,
    flavor: 'Light the room the only honest way.',
    chargeNeed: 750,
    color: 0xfff3c4,
    cssColor: '#fff3c4',
    accent: 0xa8841e,
  },
];

export function ultimateById(id: UltimateId): UltimateDef {
  const def = ULTIMATES.find((u) => u.id === id);
  if (!def) throw new Error(`unknown ultimate: ${id}`);
  return def;
}

/** tier scaling (Awakened / Sanctified / Apotheosis) */
export const TIER_MULT = [1, 1.6, 2.5];
export const TIER_NAME = ['ПРОБУЖДЁН', 'ОСВЯЩЁН', 'АПОФЕОЗ'];

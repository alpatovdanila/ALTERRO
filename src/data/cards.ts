// The Rite Wheel card pool (DESIGN.md §3.3, §5.4).
// Cards mutate a CardContext — the slice of run state upgrades may touch.

export type Rarity = 'common' | 'honed' | 'consecrated' | 'forbidden';

export const RARITY_LABEL: Record<Rarity, string> = {
  common: 'ОБЫЧНАЯ',
  honed: 'ЗАТОЧЕННАЯ',
  consecrated: 'ОСВЯЩЁННАЯ',
  forbidden: 'ЗАПРЕТНАЯ',
};

const RARITY_WEIGHT: Record<Rarity, number> = {
  common: 100,
  honed: 55,
  consecrated: 22,
  forbidden: 10,
};

export interface PlayerStats {
  maxHp: number;
  damage: number;
  /** shots per second while stationary */
  fireRate: number;
  moveSpeed: number;
  multishot: number;
  pierce: number;
  ricochet: number;
  /** damage per second for 3s, 0 = off */
  burnDps: number;
  lifesteal: number;
  critChance: number;
}

export interface CardContext {
  stats: PlayerStats;
  ult: {
    tier: number; // 1..3
    chargeRateBonus: number; // additive, capped +0.6 (DESIGN.md §5.6)
    potency: number;
    overcharged: boolean;
  };
  heal(amount: number): void;
  loseMaxHpPct(pct: number): void;
}

export interface CardDef {
  id: string;
  name: string;
  desc: string;
  flavor: string;
  rarity: Rarity;
  /** hide the card when it no longer applies */
  available?: (c: CardContext) => boolean;
  apply: (c: CardContext) => void;
}

export const CARDS: CardDef[] = [
  {
    id: 'sharpened',
    name: 'Заточенные снаряды',
    desc: '+25% урона.',
    flavor: 'Each shell is etched with a name. None of them yours.',
    rarity: 'common',
    apply: (c) => { c.stats.damage *= 1.25; },
  },
  {
    id: 'litany',
    name: 'Чистка оружия',
    desc: '+20% скорострельности.',
    flavor: 'Pray faster.',
    rarity: 'common',
    apply: (c) => { c.stats.fireRate *= 1.2; },
  },
  {
    id: 'sabatons',
    name: 'Лёгкие сабатоны',
    desc: '+15% скорости.',
    flavor: 'The dead are slow. Be less dead.',
    rarity: 'common',
    apply: (c) => { c.stats.moveSpeed *= 1.15; },
  },
  {
    id: 'plate',
    name: 'Освящённая броня',
    desc: '+20 макс. здоровья. Исцеляет полностью.',
    flavor: 'The armor remembers every wound it closed.',
    rarity: 'common',
    apply: (c) => { c.stats.maxHp += 20; c.heal(99999); },
  },
  {
    id: 'whetted',
    name: 'Отточенный ужас',
    desc: '+20% скорости заряда ульты.',
    flavor: 'It wants to be used. Let it.',
    rarity: 'common',
    available: (c) => c.ult.chargeRateBonus < 0.6,
    apply: (c) => { c.ult.chargeRateBonus = Math.min(0.6, c.ult.chargeRateBonus + 0.2); },
  },
  {
    id: 'pierce',
    name: 'Бронебойный снаряд',
    desc: 'Выстрелы пробивают +1 врага.',
    flavor: 'Through the first. Into the second.',
    rarity: 'honed',
    apply: (c) => { c.stats.pierce += 1; },
  },
  {
    id: 'ricochet',
    name: 'Могильный рикошет',
    desc: 'Выстрелы отскакивают в +1 врага.',
    flavor: 'The bullet is not finished with this room.',
    rarity: 'honed',
    apply: (c) => { c.stats.ricochet += 1; },
  },
  {
    id: 'burn',
    name: 'Зажигательные снаряды',
    desc: 'Поджигает: 6 урона/с на 3 сек.',
    flavor: 'Fire is the only honest sacrament.',
    rarity: 'honed',
    apply: (c) => { c.stats.burnDps += 6; },
  },
  {
    id: 'leech',
    name: 'Кровавый оброк',
    desc: 'Лечение — 4% от нанесённого урона.',
    flavor: 'Take back what they took.',
    rarity: 'honed',
    apply: (c) => { c.stats.lifesteal += 0.04; },
  },
  {
    id: 'crit',
    name: 'Глаз палача',
    desc: '+15% шанс двойного урона.',
    flavor: 'See the seam in everything.',
    rarity: 'honed',
    apply: (c) => { c.stats.critChance += 0.15; },
  },
  {
    id: 'split',
    name: 'Расщеплённая реликвия',
    desc: '+1 снаряд в залпе.',
    flavor: 'One barrel was never enough for this much grief.',
    rarity: 'consecrated',
    apply: (c) => { c.stats.multishot += 1; },
  },
  {
    id: 'tier-rite',
    name: 'Обряд возвышения',
    desc: 'Ульта +1 ранг. Больше. Злее.',
    flavor: 'The relic drinks, and grows heavier on your back.',
    rarity: 'consecrated',
    available: (c) => c.ult.tier < 3,
    apply: (c) => { c.ult.tier += 1; },
  },
  {
    id: 'overcharge',
    name: 'Перегрузка',
    desc: 'Ульта бьёт на 50% сильнее. Выстрел стоит 15% макс. здоровья.',
    flavor: 'It asked for more. You said yes.',
    rarity: 'forbidden',
    available: (c) => !c.ult.overcharged,
    apply: (c) => { c.ult.overcharged = true; c.ult.potency *= 1.5; },
  },
  {
    id: 'adrenal',
    name: 'Адреналиновая подпитка',
    desc: '+40% скорострельности. −20% макс. здоровья.',
    flavor: 'The armor injects. You stop asking what.',
    rarity: 'forbidden',
    apply: (c) => { c.stats.fireRate *= 1.4; c.loseMaxHpPct(0.2); },
  },
];

/** roll `n` distinct cards, rarity-weighted, honoring availability */
export function rollCards(
  n: number,
  ctx: CardContext,
  rand: () => number,
): CardDef[] {
  const pool = CARDS.filter((c) => !c.available || c.available(ctx));
  const out: CardDef[] = [];
  while (out.length < n && pool.length > 0) {
    const total = pool.reduce((s, c) => s + RARITY_WEIGHT[c.rarity], 0);
    let r = rand() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= RARITY_WEIGHT[pool[i].rarity];
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}

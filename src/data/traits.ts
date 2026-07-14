// Permanent combat doctrines — chosen once before the descent, never traded.

export type TraitId = 'runandgun' | 'twinbarrel';

export interface TraitDef {
  id: TraitId;
  name: string;
  short: string;
  cssColor: string;
}

export const TRAITS: TraitDef[] = [
  {
    id: 'runandgun',
    name: 'Огонь на бегу',
    short: 'Стреляй на бегу. Никогда не останавливайся.',
    cssColor: '#e8a13c',
  },
  {
    id: 'twinbarrel',
    name: 'Два ствола',
    short: 'Два снаряда на выстрел. Главное — попади.',
    cssColor: '#c8503c',
  },
];

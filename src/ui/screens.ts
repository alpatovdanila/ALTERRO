import type { CardDef } from '../data/cards';
import { RARITY_LABEL } from '../data/cards';
import { sfx } from '../core/sfx';
import { ULTIMATES, type UltimateDef, chargeLabel } from '../data/ultimates';
import { TRAITS, type TraitId } from '../data/traits';
import type { RunStats } from '../game/game';
import { kbd, padBtn } from './glyphs';

// Modal screens: reliquary (start / ultimate select), the Rite Wheel,
// death, victory. Pure DOM — the 3D scene keeps rendering underneath.

const screen = () => document.getElementById('screen')!;

/** debug toggles set on the start screen, read by the run when it begins */
export const cheats = { fullUlt: false };

export function clearScreen() {
  const el = screen();
  el.innerHTML = '';
  el.classList.remove('reliquary');
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Reliquary: pick a relic (ultimate) and a doctrine (permanent trait).
 * `onChange` fires on every selection so the menu hero can re-dress. */
export function showStart(
  onBegin: (ult: UltimateDef, trait: TraitId) => void,
  onChange?: (ult: UltimateDef | null, trait: TraitId | null) => void,
) {
  const el = screen();
  el.classList.add('reliquary'); // menu shifts right; the hero owns the left
  // cheats are for the dev server or an explicit ?cheats — hidden in the wild
  const showCheats = import.meta.env.DEV || new URLSearchParams(location.search).has('cheats');
  el.innerHTML = `
    <div class="title">ALTERRO</div>
    <div class="subtitle">АКТ 1 — НЕЗАПЛАНИРОВАННОЕ ВТОРЖЕНИЕ</div>
    <div class="screen-head">ВЫБЕРИ РЕЛИКВИЮ</div>
    <div class="card-row" id="ult-row"></div>
    <div class="screen-head">ВЫБЕРИ УМЕНИЕ</div>
    <div class="card-row" id="trait-row"></div>
    <button class="btn" id="begin-btn" disabled>НАЧАТЬ СПУСК</button>
    ${showCheats ? `
    <label class="cheat-toggle" id="cheat-ult">
      <input type="checkbox" ${cheats.fullUlt ? 'checked' : ''} />
      <span>ЧИТ: УЛЬТА ВСЕГДА ГОТОВА</span>
    </label>` : ''}
    <div class="hint-line kb-line">
      WASD — ДВИЖЕНИЕ &nbsp;·&nbsp; СТОЙ НА МЕСТЕ — ОГОНЬ &nbsp;·&nbsp; ${kbd('ПРОБЕЛ', true)} — УЛЬТА, КОГДА КОЛЬЦО ГОРИТ
    </div>
    <div class="hint-line gp-line">
      СТИК — ДВИЖЕНИЕ &nbsp;·&nbsp; ${padBtn('A')} / RT — УЛЬТА &nbsp;·&nbsp; START — ПАУЗА<br/>
      ${padBtn('A')} — ВЫБОР
    </div>
  `;
  const cheatBox = el.querySelector('#cheat-ult input') as HTMLInputElement | null;
  cheatBox?.addEventListener('change', () => {
    cheats.fullUlt = cheatBox.checked;
    sfx.uiSelect();
  });
  let selectedUlt: UltimateDef | null = null;
  let selectedTrait: TraitId | null = null;
  const beginBtn = el.querySelector('#begin-btn') as HTMLButtonElement;
  const refresh = () => {
    beginBtn.disabled = !(selectedUlt && selectedTrait);
  };

  const row = el.querySelector('#ult-row')!;
  for (const u of ULTIMATES.filter((x) => !x.locked)) {
    const card = document.createElement('div');
    card.className = 'card ult-card';
    card.innerHTML = `
      <div class="c-name" style="color:${u.cssColor}">${u.name}</div>
      <div class="c-desc">${u.short}</div>
      <div class="c-charge">${chargeLabel(u)}</div>
    `;
    card.addEventListener('click', () => {
      sfx.uiSelect();
      el.querySelectorAll('.ult-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedUlt = u;
      onChange?.(selectedUlt, selectedTrait);
      refresh();
    });
    row.appendChild(card);
  }

  const traitRow = el.querySelector('#trait-row')!;
  for (const t of TRAITS) {
    const card = document.createElement('div');
    card.className = 'card trait-card';
    card.innerHTML = `
      <div class="c-name" style="color:${t.cssColor}">${t.name}</div>
      <div class="c-desc">${t.short}</div>
    `;
    card.addEventListener('click', () => {
      sfx.uiSelect();
      el.querySelectorAll('.trait-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedTrait = t.id;
      onChange?.(selectedUlt, selectedTrait);
      refresh();
    });
    traitRow.appendChild(card);
  }

  beginBtn.addEventListener('click', () => {
    if (selectedUlt && selectedTrait) onBegin(selectedUlt, selectedTrait);
  });
}

/** The Rite Wheel: pick 1 of 3 (DESIGN.md §3.3) */
export function showWheel(cards: CardDef[], onPick: (c: CardDef) => void) {
  const el = screen();
  el.innerHTML = `
    <div class="screen-head">НОВЫЙ УРОВЕНЬ — НОВАЯ СПОСОБНОСТЬ</div>
    <div class="card-row" id="wheel-row"></div>
    <div class="hint-line kb-line">${kbd('1')} / ${kbd('2')} / ${kbd('3')} — ВЫБОР</div>
    <div class="hint-line gp-line">${padBtn('A')} — ВЫБОР &nbsp;·&nbsp; СТИК — НАВИГАЦИЯ</div>
  `;
  const row = el.querySelector('#wheel-row')!;
  const chosen: (() => void)[] = [];
  let done = false;

  const pick = (c: CardDef) => {
    if (done) return;
    done = true;
    window.removeEventListener('keydown', onKey);
    sfx.uiSelect();
    onPick(c);
  };
  const onKey = (e: KeyboardEvent) => {
    const idx = ['Digit1', 'Digit2', 'Digit3', 'Numpad1', 'Numpad2', 'Numpad3'].indexOf(e.code) % 3;
    if (idx >= 0 && chosen[idx]) {
      e.preventDefault();
      chosen[idx]();
    }
  };
  window.addEventListener('keydown', onKey);

  cards.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = `card wheel-card r-${c.rarity}`;
    // a keycap badge showing the number key that picks this card
    card.innerHTML = `
      <div class="keycap">${i + 1}</div>
      <div class="c-rarity">${RARITY_LABEL[c.rarity]}</div>
      <div class="c-name">${c.name}</div>
      <div class="c-desc">${c.desc}</div>
    `;
    chosen[i] = () => pick(c);
    card.addEventListener('click', () => pick(c));
    row.appendChild(card);
  });
}

/** Esc pause menu: resume, music toggle, restart the current hall, quit to menu */
export function showPause(
  musicOn: boolean,
  onToggleMusic: () => boolean,
  onRestart: () => void,
  onResume: () => void,
  onQuit: () => void,
) {
  const el = screen();
  el.innerHTML = `
    <div class="title" style="font-size:64px">ПАУЗА</div>
    <div class="card-row">
      <button class="btn" id="resume-btn">ПРОДОЛЖИТЬ</button>
      <button class="btn" id="music-btn">МУЗЫКА: ${musicOn ? 'ВКЛ' : 'ВЫКЛ'}</button>
      <button class="btn" id="restart-btn">НАЧАТЬ ЗАЛ ЗАНОВО</button>
      <button class="btn" id="quit-btn">В ГЛАВНОЕ МЕНЮ</button>
    </div>
    <div class="hint-line gp-line">${padBtn('A')} — ОК &nbsp;·&nbsp; ${padBtn('B')} — НАЗАД &nbsp;·&nbsp; СТИК — ВЫБОР</div>
  `;
  el.querySelector('#music-btn')!.addEventListener('click', () => {
    sfx.uiSelect();
    const on = onToggleMusic();
    (el.querySelector('#music-btn') as HTMLElement).textContent = `МУЗЫКА: ${on ? 'ВКЛ' : 'ВЫКЛ'}`;
  });
  el.querySelector('#restart-btn')!.addEventListener('click', onRestart);
  el.querySelector('#resume-btn')!.addEventListener('click', onResume);
  el.querySelector('#quit-btn')!.addEventListener('click', onQuit);
}

/** the fall: one paid return per run (free for now), or the long walk back */
export function showDeath(
  stats: RunStats,
  canResurrect: boolean,
  onResurrect: () => void,
  onSurrender: () => void,
) {
  const el = screen();
  el.innerHTML = `
    <div class="title death-title">ПРОВАЛ</div>
    <div class="stats">
      ДОСТИГНУТ ЗАЛ — <b>${stats.room}</b> ИЗ 15<br/>
      УБИЙСТВ — <b>${stats.kills}</b> · УРОНА — <b>${Math.round(stats.damageDealt)}</b><br/>
      УЛЬТА — <b>${stats.ultUses}</b> РАЗ · ВРЕМЯ — <b>${fmtTime(stats.timeSec)}</b>
    </div>
    <div class="card-row">
      ${canResurrect ? '<button class="btn" id="res-btn">ВОССТАТЬ (ПОКА БЕСПЛАТНО)</button>' : ''}
      <button class="btn" id="surrender-btn">СДАТЬСЯ</button>
    </div>
    <div class="hint-line gp-line">${padBtn('A')} — ОК &nbsp;·&nbsp; СТИК — ВЫБОР</div>
  `;
  el.querySelector('#res-btn')?.addEventListener('click', onResurrect);
  el.querySelector('#surrender-btn')!.addEventListener('click', onSurrender);
}

export function showVictory(stats: RunStats, onRestart: () => void, onRelic: () => void) {
  const el = screen();
  el.innerHTML = `
    <div class="title victory-title">ПРОРАБ ПОВЕРЖЕН</div>
    <div class="stats">
      АКТ 1 ПРОЙДЕН ЗА <b>${fmtTime(stats.timeSec)}</b><br/>
      УБИЙСТВ — <b>${stats.kills}</b> · УРОНА — <b>${Math.round(stats.damageDealt)}</b><br/>
      УЛЬТА — <b>${stats.ultUses}</b> РАЗ
    </div>
    <div class="card-row">
      <button class="btn" id="restart-btn">СПУСТИТЬСЯ ВНОВЬ</button>
      <button class="btn" id="relic-btn">СМЕНИТЬ РЕЛИКВИЮ</button>
    </div>
    <div class="hint-line gp-line">${padBtn('A')} — ОК &nbsp;·&nbsp; СТИК — ВЫБОР</div>
  `;
  el.querySelector('#restart-btn')!.addEventListener('click', onRestart);
  el.querySelector('#relic-btn')!.addEventListener('click', onRelic);
}

import type { Game } from '../game/game';
import { FINAL_ROOM } from '../game/game';
import { zoneForRoom } from '../render/zones';
import { sfx } from '../core/sfx';

// HUD: integrity, rite (level/xp), room, boss vitality, and the Dread ring.
// The ring ignites when charged — low choir drone until spent (DESIGN.md §8).

const RING_CIRC = 263.9;

export class Hud {
  private root = document.getElementById('hud')!;
  private hpFill = document.getElementById('hp-fill')!;
  private xpFill = document.getElementById('xp-fill')!;
  private levelNum = document.getElementById('level-num')!;
  private roomLabel = document.getElementById('room-label')!;
  private bossWrap = document.getElementById('boss-wrap')!;
  private bossFill = document.getElementById('boss-fill')!;
  private bossName = document.getElementById('boss-name')!;
  private dreadWrap = document.getElementById('dread-wrap')!;
  private dreadFill = document.getElementById('dread-fill') as unknown as SVGCircleElement;
  private dreadHint = document.getElementById('dread-hint')!;
  private announceEl = document.getElementById('announce')!;
  private edgeLow = document.getElementById('edge-low')!;
  private edgeUlt = document.getElementById('edge-ult')!;
  private wasCharged = false;
  // last written values — the HUD only touches the DOM (and only reflows) when
  // a value actually changes, not 60× a second
  private lastHp = -1;
  private lastXp = -1;
  private lastLevel = -1;
  private lastRoom = -1;
  private lastBossHp = -2;
  private lastDash = -1;
  private lastLow = false;

  /** big center text, fades on its own — notification only */
  announce(text: string) {
    this.announceEl.textContent = text;
    this.announceEl.classList.remove('show');
    void this.announceEl.offsetWidth; // restart the animation
    this.announceEl.classList.add('show');
  }

  /** the hall introduces itself as you step through the door — name only */
  announceRoom(n: number) {
    this.announce(n === FINAL_ROOM ? 'ЛИТЕЙНЫЙ ДОК' : zoneForRoom(n).name.toUpperCase());
  }

  show(visible: boolean) {
    this.root.classList.toggle('hidden', !visible);
    if (!visible) {
      sfx.setDrone(false);
      this.wasCharged = false;
    }
  }

  setRingColor(css: string) {
    (this.dreadFill.style as CSSStyleDeclaration).stroke = css;
    (this.dreadFill.style as CSSStyleDeclaration).filter = `drop-shadow(0 0 3px ${css})`;
  }

  update(g: Game) {
    const hp = Math.max(0, Math.round((g.playerHp / g.stats.maxHp) * 100));
    if (hp !== this.lastHp) {
      this.hpFill.style.width = `${hp}%`;
      this.lastHp = hp;
    }
    const xp = Math.min(100, Math.round((g.xp / g.xpNext) * 100));
    if (xp !== this.lastXp) {
      this.xpFill.style.width = `${xp}%`;
      this.lastXp = xp;
    }
    if (g.level !== this.lastLevel) {
      this.levelNum.textContent = String(g.level);
      this.lastLevel = g.level;
    }
    if (g.room !== this.lastRoom) {
      this.roomLabel.textContent =
        g.room === FINAL_ROOM ? 'ЛИТЕЙНЫЙ ДОК' : zoneForRoom(g.room).name.toUpperCase();
      this.lastRoom = g.room;
    }

    const boss = g.boss;
    this.bossWrap.classList.toggle('hidden', !boss);
    if (boss) {
      const bhp = Math.max(0, Math.round((boss.hp / boss.maxHp) * 100));
      if (bhp !== this.lastBossHp) {
        this.bossName.textContent = boss.def.name;
        this.bossFill.style.width = `${bhp}%`;
        this.lastBossHp = bhp;
      }
    } else {
      this.lastBossHp = -2;
    }

    const frac = Math.min(1, g.ultCharge / g.ultChargeNeed);
    const dash = Math.round(RING_CIRC * (1 - frac));
    if (dash !== this.lastDash) {
      this.dreadFill.style.strokeDashoffset = String(dash);
      this.lastDash = dash;
    }
    const charged = frac >= 1;
    this.dreadWrap.classList.toggle('charged', charged);
    this.dreadHint.classList.toggle('hidden', !charged);
    if (charged && !this.wasCharged) {
      sfx.ready();
      sfx.setDrone(true);
      this.announce('УЛЬТА ГОТОВА');
    } else if (!charged && this.wasCharged) {
      sfx.setDrone(false);
    }
    this.wasCharged = charged;

    // screen edges: bleeding out / relic burning to be used
    const low = g.playerHp > 0 && g.playerHp < g.stats.maxHp * 0.3;
    if (low !== this.lastLow) {
      this.edgeLow.classList.toggle('on', low);
      this.lastLow = low;
    }
    this.edgeUlt.classList.toggle('on', charged); // toggle is idempotent — cheap
  }
}

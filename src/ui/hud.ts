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
    this.hpFill.style.width = `${Math.max(0, (g.playerHp / g.stats.maxHp) * 100)}%`;
    this.xpFill.style.width = `${Math.min(100, (g.xp / g.xpNext) * 100)}%`;
    this.levelNum.textContent = String(g.level);
    this.roomLabel.textContent =
      g.room === FINAL_ROOM ? 'ЛИТЕЙНЫЙ ДОК' : zoneForRoom(g.room).name.toUpperCase();

    const boss = g.boss;
    this.bossWrap.classList.toggle('hidden', !boss);
    if (boss) {
      this.bossName.textContent = boss.def.name;
      this.bossFill.style.width = `${Math.max(0, (boss.hp / boss.maxHp) * 100)}%`;
    }

    const frac = Math.min(1, g.ultCharge / g.ultChargeNeed);
    this.dreadFill.style.strokeDashoffset = String(RING_CIRC * (1 - frac));
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
    this.edgeLow.classList.toggle('on', g.playerHp > 0 && g.playerHp < g.stats.maxHp * 0.3);
    this.edgeUlt.classList.toggle('on', charged);
  }
}

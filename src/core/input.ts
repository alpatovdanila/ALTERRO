// Keyboard + gamepad. Ultimate fires on SPACE or on A / RT; Start pauses;
// menus navigate with the stick / d-pad and confirm with A.
// The mouse does not aim and does not fire — see DESIGN.md §4.
export class Input {
  private keys = new Set<string>();
  /** set true for one sim tick when the player slams Space / A / RT */
  ultimatePressed = false;
  /** which device the player last actually TOUCHED — drives which button
   * hints (keyboard vs gamepad) the UI shows. Starts on keyboard. */
  lastInput: 'keyboard' | 'gamepad' = 'keyboard';

  // gamepad state (polled once per frame from the main loop)
  private padMove = { x: 0, z: 0 };
  private padUltPrev = false;
  private padStartPrev = false;
  private padConfirmPrev = false;
  private padNavPrev = { x: 0, z: 0 };
  private startPressed = false;
  private navEdge: { x: number; z: number } | null = null;
  private confirmPressed = false;
  private padBackPrev = false;
  private backPressed = false;
  /** a pad talked to us recently — menus auto-focus for it */
  hasPad = false;
  /** the pad we locked onto (from connect events or activity) */
  private padIndex: number | null = null;
  /** diagnostics: what the game currently sees */
  padId: string | null = null;
  /** last axis snapshot per pad — "alive" means MOVED, not merely off-center
   * (wheel pedals rest pinned at ±1 and must never steal the lock) */
  private padAxesPrev = new Map<number, number[]>();

  constructor() {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      this.lastInput = 'keyboard';
      if (e.code === 'Space' && !e.repeat) this.ultimatePressed = true;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    // a mouse gesture on a menu counts as "playing on keyboard" — show kbd hints
    window.addEventListener('pointerdown', () => {
      this.lastInput = 'keyboard';
    });
    // lock onto pads the browser announces (Chrome only lists a pad in
    // getGamepads() after this event has fired for it)
    window.addEventListener('gamepadconnected', (e) => {
      this.padIndex = (e as GamepadEvent).gamepad.index;
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (this.padIndex === (e as GamepadEvent).gamepad.index) this.padIndex = null;
    });
  }

  /** read the active pad — call once per rendered frame. Ghost receivers and
   * idle duplicates are common on Windows, so any pad showing REAL input
   * steals the lock from a silent one. */
  pollGamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    let gp: Gamepad | null = this.padIndex !== null ? (pads[this.padIndex] ?? null) : null;
    if (gp && !gp.connected) gp = null;
    let fallback: Gamepad | null = gp;
    for (const p of pads) {
      if (!p || !p.connected) continue;
      fallback = fallback ?? p;
      const prev = this.padAxesPrev.get(p.index);
      const moved = prev ? p.axes.some((a, i) => Math.abs(a - (prev[i] ?? 0)) > 0.08) : false;
      this.padAxesPrev.set(p.index, [...p.axes]);
      const alive = p.buttons.some((b) => b && b.pressed) || moved;
      if (alive && p !== gp) {
        gp = p; // this one is actually being handled RIGHT NOW
      }
    }
    gp = gp ?? fallback;
    if (!gp) {
      this.padMove.x = 0;
      this.padMove.z = 0;
      this.hasPad = false;
      this.padId = null;
      return;
    }
    this.padIndex = gp.index;
    this.padId = gp.id;
    this.hasPad = true;
    const dead = (v: number) => (Math.abs(v) < 0.18 ? 0 : v);
    let x = dead(gp.axes[0] ?? 0);
    let z = dead(gp.axes[1] ?? 0);
    if (gp.buttons[14]?.pressed) x = -1; // d-pad
    if (gp.buttons[15]?.pressed) x = 1;
    if (gp.buttons[12]?.pressed) z = -1;
    if (gp.buttons[13]?.pressed) z = 1;
    this.padMove.x = x;
    this.padMove.z = z;

    // any REAL pad input (button or a real stick/d-pad push) means the player
    // has both hands on the controller — swap the whole UI to gamepad hints.
    // Merely being connected-but-idle must NOT flip it away from keyboard.
    if (gp.buttons.some((b) => b && b.pressed) || Math.abs(x) > 0.25 || Math.abs(z) > 0.25) {
      this.lastInput = 'gamepad';
    }

    // ultimate: A (0) or right trigger (7), edge-triggered
    const ult = !!(gp.buttons[0]?.pressed || gp.buttons[7]?.pressed);
    if (ult && !this.padUltPrev) this.ultimatePressed = true;
    this.padUltPrev = ult;

    // pause: Start (9)
    const start = !!gp.buttons[9]?.pressed;
    if (start && !this.padStartPrev) this.startPressed = true;
    this.padStartPrev = start;

    // menu navigation edges (stick or d-pad past 0.6) + A to confirm
    const nx = Math.abs(x) > 0.6 ? Math.sign(x) : 0;
    const nz = Math.abs(z) > 0.6 ? Math.sign(z) : 0;
    if ((nx !== 0 && this.padNavPrev.x === 0) || (nz !== 0 && this.padNavPrev.z === 0)) {
      this.navEdge = { x: nx, z: nz };
    }
    this.padNavPrev = { x: nx, z: nz };
    const confirm = !!gp.buttons[0]?.pressed;
    if (confirm && !this.padConfirmPrev) this.confirmPressed = true;
    this.padConfirmPrev = confirm;

    // back: B (1) — closes the pause menu
    const back = !!gp.buttons[1]?.pressed;
    if (back && !this.padBackPrev) this.backPressed = true;
    this.padBackPrev = back;
  }

  /** movement vector, keyboard + analog stick combined (magnitude ≤ 1) */
  move(): { x: number; z: number } {
    let x = this.padMove.x;
    let z = this.padMove.z;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z += 1;
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    return { x, z };
  }

  /** consume the activation edge (call once per sim tick) */
  consumeUltimate(): boolean {
    const v = this.ultimatePressed;
    this.ultimatePressed = false;
    return v;
  }

  consumeStart(): boolean {
    const v = this.startPressed;
    this.startPressed = false;
    return v;
  }

  consumeNav(): { x: number; z: number } | null {
    const v = this.navEdge;
    this.navEdge = null;
    return v;
  }

  consumeConfirm(): boolean {
    const v = this.confirmPressed;
    this.confirmPressed = false;
    return v;
  }

  consumeBack(): boolean {
    const v = this.backPressed;
    this.backPressed = false;
    return v;
  }
}

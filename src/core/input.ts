// Keyboard + gamepad. Ultimate fires on SPACE or on A / RT; Start pauses;
// menus navigate with the stick / d-pad and confirm with A.
// The mouse does not aim and does not fire — see DESIGN.md §4.
export class Input {
  private keys = new Set<string>();
  /** set true for one sim tick when the player slams Space / A / RT */
  ultimatePressed = false;

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

  constructor() {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Space' && !e.repeat) this.ultimatePressed = true;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** read the first connected pad — call once per rendered frame */
  pollGamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    let gp: Gamepad | null = null;
    for (const p of pads) {
      if (p && p.connected) {
        gp = p;
        break;
      }
    }
    if (!gp) {
      this.padMove.x = 0;
      this.padMove.z = 0;
      this.hasPad = false;
      return;
    }
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

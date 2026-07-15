// Tiny HTML snippet helpers for input hints. A `using-gamepad` class on
// <body> (set from Input.lastInput each frame) drives which of a kb/gp pair
// the CSS reveals — so a hint written with `hint()` follows the controller.

/** an inline keyboard key-cap, e.g. `kbd('ПРОБЕЛ', true)` for a wide space bar */
export function kbd(label: string, wide = false): string {
  return `<span class="kbd${wide ? ' kbd-wide' : ''}">${label}</span>`;
}

/** a circled Xbox face button (A green, B red, X blue, Y amber) */
export function padBtn(letter: 'A' | 'B' | 'X' | 'Y' = 'A'): string {
  return `<span class="gp-btn gp-${letter.toLowerCase()}">${letter}</span>`;
}

/** pair a keyboard variant with a gamepad variant; CSS shows the live one */
export function hint(kbHtml: string, gpHtml: string): string {
  return `<span class="kb-only">${kbHtml}</span><span class="gp-only">${gpHtml}</span>`;
}

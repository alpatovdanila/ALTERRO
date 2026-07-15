import * as THREE from 'three';
import { Stage } from './render/scene';
import { Particles, particlesReady } from './render/particles';
import { texturesReady } from './render/textures';
import {
  buildPlayer, buildEnemy, buildCasket, buildGravelightOrb, buildSingularity,
  buildMortarOrb, buildGlob, buildBolt, buildOrb, buildXpMote, buildExplosiveBarrel, buildSmallProp,
} from './render/meshes';
import { ENEMIES } from './data/enemies';
import { Gore } from './game/gore';
import { Game } from './game/game';
import { Input } from './core/input';
import { sfx } from './core/sfx';
import { Rng } from './core/rng';
import { rollCards } from './data/cards';
import { ULTIMATES, type UltimateDef } from './data/ultimates';
import { TRAITS, type TraitId } from './data/traits';
import { Hud } from './ui/hud';
import { showStart, showWheel, showDeath, showVictory, showPause, clearScreen, cheats } from './ui/screens';

// Bootstrap + fixed-timestep loop (DESIGN.md §11: deterministic sim decoupled
// from render). main.ts owns the state machine between screens and the sim.

const stage = new Stage(document.getElementById('canvas-host')!);
const fxRng = new Rng(0x5eed);
const gore = new Gore(stage.scene, () => fxRng.next());
const particles = new Particles(stage.scene, () => fxRng.next());
const input = new Input();
const hud = new Hud();

let game: Game | null = null;
let currentUlt: UltimateDef | null = null;
let currentTrait: TraitId = TRAITS[0].id;
const uiRng = new Rng(Date.now() % 2147483647);

const fade = document.getElementById('fx-fade')!;

function startRun(ult: UltimateDef, trait: TraitId) {
  currentUlt = ult;
  currentTrait = trait;
  game?.destroy();
  clearMenuHero();
  clearScreen();
  sfx.unlock();
  sfx.setMusicMode('normal');
  sfx.startMusic('game');
  hud.setRingColor(ult.cssColor);
  hud.show(true);

  const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  hud.announceRoom(1);
  game = new Game(stage, gore, particles, input, seed, ult, trait, {
    onCeremony() {
      hud.announce('НОВЫЙ УРОВЕНЬ');
    },
    onLevelUp() {
      const g = game!;
      g.paused = true;
      const cards = rollCards(3, g.cardCtx, () => uiRng.next());
      showWheel(cards, (card) => {
        card.apply(g.cardCtx);
        clearScreen();
        g.paused = false;
        // queued level-ups (big xp bursts) re-open the wheel next tick
      });
    },
    onDeath() {
      hud.show(false);
      sfx.setMusicMode('off'); // the ПРОВАЛ screen is silent
      sfx.loseJingle();
      showDeath(
        game!.stats2,
        !game!.resurrectUsed,
        () => {
          // the one free return: same room, same state, full health
          clearScreen();
          hud.show(true);
          sfx.setMusicMode('normal');
          game!.resurrect();
        },
        backToRelicSelect, // СДАТЬСЯ — back to the reliquary
      );
    },
    onVictory() {
      hud.show(false);
      sfx.setMusicMode('low'); // the theme burns down to an ember
      sfx.winJingle();
      showVictory(game!.stats2, () => startRun(currentUlt!, currentTrait), backToRelicSelect);
    },
    onNotify(text, sub) {
      hud.announce(text, sub);
    },
    onRoomExit() {
      const g = game!;
      if (g.paused) return;
      g.paused = true;
      fade.style.opacity = '1';
      setTimeout(() => {
        g.loadRoom(g.room + 1);
        hud.announceRoom(g.room);
        fade.style.opacity = '0';
        g.paused = false;
      }, 380);
    },
  });
  game.cheatFullUlt = cheats.fullUlt;
}

// ------------------------------------------------ reliquary (main menu)
// The menu lives INSIDE the world: the Foreman's foundry burns behind the
// cards, and the crusader stands ready — his gear changes with the loadout.
let menuHero: ReturnType<typeof buildPlayer> | null = null;
function setMenuHero(ult: UltimateDef | null, trait: TraitId | null) {
  clearMenuHero();
  const def = ult ?? ULTIMATES[0];
  menuHero = buildPlayer(def.color, trait ?? undefined, def.accent);
  menuHero.root.position.set(-4.6, 0, 10.2); // the un-dimmed left third is his
  menuHero.root.scale.setScalar(1.6); // parade scale — he IS the menu
  menuHero.root.rotation.y = 0; // eyes on the camera
  menuHero.relicMat.opacity = 1;
  // his own display light, so the loadout reads even over the dark foundry
  const heroLight = new THREE.PointLight(0xffdcb0, 26, 7, 1.8);
  heroLight.position.set(0.8, 2.2, 1.4);
  menuHero.root.add(heroLight);
  stage.scene.add(menuHero.root);
  stage.menuFocus = menuHero.root.position; // camera dollies in on him
}
function clearMenuHero() {
  if (menuHero) {
    stage.scene.remove(menuHero.root);
    menuHero = null;
  }
  stage.menuFocus = null;
}

function showMenu() {
  stage.clearRoom(); // the crusader against the void — no backdrop
  setMenuHero(null, null);
  sfx.setMusicMode('normal');
  sfx.startMusic('menu');
  showStart(startRun, (ult, trait) => setMenuHero(ult, trait));
}

function backToRelicSelect() {
  game?.destroy();
  game = null;
  hud.show(false);
  showMenu();
}

// ------------------------------------------------ boot: load EVERYTHING
// behind a loader — audio decode, shader compile, the menu backdrop — so
// the first fight never hitches.
async function boot() {
  const loader = document.getElementById('loader')!;
  const loaderText = document.getElementById('loader-text')!;
  loaderText.textContent = 'ЗАГРУЗКА ТЕКСТУР…';
  await Promise.all([texturesReady, particlesReady]);
  loaderText.textContent = 'ДЕКОДИРОВАНИЕ ЗВУКА…';
  await sfx.preload();
  loaderText.textContent = 'КОМПИЛЯЦИЯ ШЕЙДЕРОВ…';
  // task-boundary yield so the label paints — a MessageChannel hop is NOT
  // throttled in hidden/embedded tabs the way setTimeout is
  await new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r(undefined);
    ch.port2.postMessage(0);
  });
  warmup();
  loader.classList.add('hidden');
  showMenu();
}
void boot();
// unlock audio on the first gesture anywhere
window.addEventListener('pointerdown', () => sfx.unlock(), { once: true });
// make pad detection VISIBLE — no guessing whether the browser sees it
window.addEventListener('gamepadconnected', (e) => {
  hud.announce('ГЕЙМПАД ПОДКЛЮЧЁН');
  console.info('gamepad connected:', (e as GamepadEvent).gamepad.id, 'mapping:', (e as GamepadEvent).gamepad.mapping);
});
window.addEventListener('gamepaddisconnected', () => hud.announce('ГЕЙМПАД ОТКЛЮЧЁН'));

/**
 * Boot warmup: build one of everything at a hidden position, prime every
 * particle/gore pool, and force the renderer to compile every shader program
 * NOW — behind the start screen — instead of hitching mid-fight on first use.
 */
function warmup() {
  const dummies: THREE.Object3D[] = [];
  const hide = (o: THREE.Object3D) => {
    o.position.set(0, -80, 0);
    stage.scene.add(o);
    dummies.push(o);
  };
  for (const def of Object.values(ENEMIES)) hide(buildEnemy(def).root);
  hide(buildPlayer(0x66ff88).root);
  hide(buildCasket().root);
  hide(buildGravelightOrb(1));
  hide(buildSingularity(1));
  hide(buildMortarOrb());
  hide(buildGlob());
  hide(buildBolt());
  hide(buildOrb());
  hide(buildXpMote());
  hide(buildExplosiveBarrel());
  hide(buildSmallProp('crate'));
  const deep = new THREE.Vector3(0, -80, 0);
  particles.sparks(deep, 2);
  particles.puff(deep, 2);
  particles.mist(deep, 2);
  particles.fire(deep, 2);
  particles.electric(deep, 2);
  particles.ember(deep, 1);
  for (const kind of ['meat', 'ash', 'bone', 'brass', 'metal'] as const) {
    gore.burst(deep, () => 0.5, 1, 0.1, kind);
  }
  stage.zap(deep, deep.clone().setX(1), 0xffffff);
  particles.setCamera(stage.camera);
  particles.update(1 / 60);
  gore.update(1 / 60);
  stage.renderer.compile(stage.scene, stage.camera);
  stage.render();
  for (const d of dummies) stage.scene.remove(d);
  gore.clear();
}

// Dev/test hook: lets tooling step the sim and grab frames even when the
// document is hidden (rAF throttled). Stripped by tree-shaking in prod builds
// only if DEV; harmless otherwise.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__alterro = {
    get game() {
      return game;
    },
    sfx,
    stage,
    input,
    beginRun(id: string, trait: TraitId = 'twinbarrel') {
      const u = ULTIMATES.find((x) => x.id === id);
      if (u) startRun(u, trait);
      return !!u;
    },
    step(n = 1) {
      for (let i = 0; i < n; i++) {
        game?.update(1 / 60);
        particles.update(1 / 60);
        if (game) stage.update(1 / 60, game.playerPos.x, game.playerPos.z);
        else stage.update(1 / 60, 0, 8);
      }
      if (game) hud.update(game);
      gore.update((n * 1) / 60);
      particles.setCamera(stage.camera);
      stage.render();
    },
    /** downscaled jpeg frame for headless visual checks */
    shot(w = 960): string {
      stage.render();
      const src = stage.renderer.domElement;
      const c = document.createElement('canvas');
      const scale = w / src.width;
      c.width = w;
      c.height = Math.round(src.height * scale);
      c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.85);
    },
  };
}

// -------------------------------------------------- perf monitor (F3)
// render fps, sim tick rate, CPU/GPU frame cost, and the headroom left in the
// 60 Hz budget. GPU time needs EXT_disjoint_timer_query_webgl2 (else "n/a").
const perfEl = document.getElementById('perf')!;
const glCtx = stage.renderer.getContext() as WebGL2RenderingContext;
const timerExt = glCtx.getExtension('EXT_disjoint_timer_query_webgl2') as {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
} | null;
const gpuQueries: WebGLQuery[] = [];
let cpuMs = 0;
let gpuMs = 0;
let fpsFrames = 0;
let simTicks = 0;
let perfWindowT = performance.now();

function pollGpuQueries() {
  if (!timerExt) return;
  if (glCtx.getParameter(timerExt.GPU_DISJOINT_EXT)) {
    // timer state is garbage after a disjoint event — throw the batch away
    for (const q of gpuQueries.splice(0)) glCtx.deleteQuery(q);
    return;
  }
  while (gpuQueries.length > 0) {
    const q = gpuQueries[0];
    if (!glCtx.getQueryParameter(q, glCtx.QUERY_RESULT_AVAILABLE)) break;
    const ns = glCtx.getQueryParameter(q, glCtx.QUERY_RESULT) as number;
    gpuMs = gpuMs * 0.85 + (ns / 1e6) * 0.15;
    glCtx.deleteQuery(q);
    gpuQueries.shift();
  }
}

function updatePerfText() {
  const now = performance.now();
  const winMs = now - perfWindowT;
  if (winMs < 500) return;
  const fps = (fpsFrames / winMs) * 1000;
  const tps = (simTicks / winMs) * 1000;
  fpsFrames = 0;
  simTicks = 0;
  perfWindowT = now;
  const budget = 1000 / 60;
  const worst = Math.max(cpuMs, timerExt ? gpuMs : 0);
  const headroom = Math.max(0, (1 - worst / budget) * 100);
  perfEl.textContent =
    `FPS  ${fps.toFixed(0)}\n` +
    `SIM  ${tps.toFixed(0)} tps\n` +
    `CPU  ${cpuMs.toFixed(2)} ms\n` +
    `GPU  ${timerExt ? gpuMs.toFixed(2) + ' ms' : 'n/a'}\n` +
    `FREE ${headroom.toFixed(0)}% of ${budget.toFixed(1)} ms\n` +
    `PAD  ${input.padId ? input.padId.slice(0, 24) : '—'}`;
}

// -------------------------------------------------- GTAO tuning panel (F4)
interface GtaoParams { intensity: number; radius: number; thickness: number; scale: number }
const GTAO_DEFAULT: GtaoParams = { intensity: 0.9, radius: 0.25, thickness: 1, scale: 1 };
const gtaoPanel = document.getElementById('gtao-panel')!;
const gtaoParams: GtaoParams = (() => {
  try {
    return { ...GTAO_DEFAULT, ...JSON.parse(localStorage.getItem('alterro-gtao') ?? '{}') };
  } catch {
    return { ...GTAO_DEFAULT };
  }
})();
stage.setGtao(gtaoParams);
{
  const title = document.createElement('div');
  title.id = 'gtao-title';
  title.textContent = 'GTAO — НАСТРОЙКА (F4)';
  gtaoPanel.appendChild(title);
  const addSlider = (key: keyof GtaoParams, label: string, min: number, max: number, step: number) => {
    const lab = document.createElement('label');
    lab.textContent = label;
    const val = document.createElement('span');
    val.textContent = gtaoParams[key].toFixed(2);
    lab.appendChild(val);
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(gtaoParams[key]);
    range.addEventListener('input', () => {
      gtaoParams[key] = parseFloat(range.value);
      val.textContent = gtaoParams[key].toFixed(2);
      stage.setGtao(gtaoParams);
      localStorage.setItem('alterro-gtao', JSON.stringify(gtaoParams));
    });
    gtaoPanel.appendChild(lab);
    gtaoPanel.appendChild(range);
  };
  addSlider('intensity', 'ИНТЕНСИВНОСТЬ', 0, 2, 0.05);
  addSlider('radius', 'РАДИУС', 0.05, 1.2, 0.01);
  addSlider('thickness', 'ТОЛЩИНА', 0.1, 4, 0.05);
  addSlider('scale', 'МАСШТАБ', 0.25, 3, 0.05);
}

// -------------------------------------------------- Esc pause menu
let menuOpen = false;
function closePauseMenu() {
  if (!menuOpen) return;
  menuOpen = false;
  clearScreen();
  sfx.setMusicMode('normal');
  if (game) game.paused = false;
}
function togglePauseMenu() {
  const g = game;
  if (!g || g.over) return;
  if (menuOpen) {
    closePauseMenu();
    return;
  }
  if (g.paused) return; // the wheel or a room transition owns the pause
  menuOpen = true;
  g.paused = true;
  sfx.setMusicMode('off'); // full silence while paused
  showPause(
    sfx.musicEnabled,
    () => {
      const on = !sfx.musicEnabled;
      sfx.setMusicEnabled(on);
      return on;
    },
    () => {
      // restart the current hall from its door
      menuOpen = false;
      clearScreen();
      sfx.setMusicMode('normal');
      g.loadRoom(g.room);
      hud.announceRoom(g.room);
      g.paused = false;
    },
    closePauseMenu,
    () => {
      // abandon the run and return to the reliquary
      menuOpen = false;
      sfx.setMusicMode('normal');
      backToRelicSelect();
    },
  );
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'F3') {
    e.preventDefault();
    perfEl.classList.toggle('hidden');
  } else if (e.code === 'F4') {
    e.preventDefault();
    gtaoPanel.classList.toggle('hidden');
  } else if (e.code === 'Escape') {
    togglePauseMenu();
  }
});

// ---------------------------------------------------------------- main loop
const DT = 1 / 60;
const MAX_FRAME = 0.1;
let last = performance.now();
let acc = 0;

/** stick/d-pad moves the highlight across menu cards and buttons; A clicks,
 * B backs out of the pause menu. Every screen auto-focuses its first item
 * the moment a pad is present, so A always has a target. */
function handleMenuGamepad() {
  const nav = input.consumeNav();
  const confirm = input.consumeConfirm();
  const back = input.consumeBack();
  if (back && menuOpen) closePauseMenu();
  const focusables = [...document.querySelectorAll('#screen .card, #screen .btn')] as HTMLElement[];
  if (focusables.length === 0) return;
  let idx = focusables.findIndex((el) => el.classList.contains('gp-focus'));
  if (idx === -1 && input.hasPad) {
    idx = 0;
    focusables[0].classList.add('gp-focus');
  }
  if (nav && idx >= 0) {
    const step = nav.x !== 0 ? nav.x : nav.z;
    idx = (idx + (step > 0 ? 1 : -1) + focusables.length) % focusables.length;
    focusables.forEach((el, i) => el.classList.toggle('gp-focus', i === idx));
    sfx.uiSelect();
  }
  if (confirm && idx >= 0) {
    // A both confirms a menu AND arms the ultimate. When it's used to pick a
    // card/button (which unpauses the game this same frame), swallow the ult
    // edge so the selection doesn't also fire a charged ultimate.
    input.consumeUltimate();
    focusables[idx].click();
  }
}

function frame(now: number) {
  requestAnimationFrame(frame);
  const frameStart = performance.now();
  acc += Math.min(MAX_FRAME, (now - last) / 1000);
  last = now;

  input.pollGamepad();
  // one body class drives every kbd-vs-gamepad hint in the CSS
  document.body.classList.toggle('using-gamepad', input.lastInput === 'gamepad');
  if (input.consumeStart()) togglePauseMenu();
  handleMenuGamepad();

  while (acc >= DT) {
    acc -= DT;
    game?.update(DT);
    simTicks++;
  }
  // consume stray presses so a click during a menu doesn't fire the ultimate later
  if (!game || game.paused || game.over) input.consumeUltimate();

  if (game) {
    stage.update(DT, game.playerPos.x, game.playerPos.z);
    hud.update(game);
  } else {
    stage.update(DT, 0, 8);
  }
  gore.update(DT);
  particles.setCamera(stage.camera);
  particles.update(DT);

  let gpuQ: WebGLQuery | null = null;
  if (timerExt) {
    gpuQ = glCtx.createQuery();
    if (gpuQ) glCtx.beginQuery(timerExt.TIME_ELAPSED_EXT, gpuQ);
  }
  stage.render();
  if (timerExt && gpuQ) {
    glCtx.endQuery(timerExt.TIME_ELAPSED_EXT);
    gpuQueries.push(gpuQ);
  }

  cpuMs = cpuMs * 0.85 + (performance.now() - frameStart) * 0.15;
  fpsFrames++;
  pollGpuQueries();
  updatePerfText();
}
requestAnimationFrame(frame);

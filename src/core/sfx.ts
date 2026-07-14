// Sample-based audio engine. Every sound comes from the licensed pack in
// public/audio (no synthesis). ALL buffers are fetched and decoded up front —
// nothing loads mid-fight, so nothing hitches. The master chain keeps the
// lowpass "muffle" bus for the nuke deafness effect; music and ambience run
// through it too.

interface SoundDef {
  files: string[];
  vol: number;
  rate?: number;
  rateVar?: number;
  /** minimum ms between triggers — protects the mix from machine-gun spam */
  throttle?: number;
}

const hits = (from: number, to: number) => {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`hit${String(i).padStart(2, '0')}.flac`);
  return out;
};
const nums = (base: string, from: number, to: number, ext: string) => {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${base}${i}${ext}`);
  return out;
};

const LIB: Record<string, SoundDef> = {
  shot: { files: ['shot.wav'], vol: 0.32, rate: 1.12, rateVar: 0.09, throttle: 60 },
  cannon: { files: ['cannon.wav'], vol: 0.35, rate: 1.05, rateVar: 0.1, throttle: 90 },
  glob: { files: ['glob.wav'], vol: 0.5, rateVar: 0.12 },
  mortar: { files: ['mortar.wav'], vol: 0.55, rateVar: 0.08 },
  biglaunch: { files: ['biglaunch.wav'], vol: 0.65 },
  hitLight: { files: hits(20, 37), vol: 0.5, rateVar: 0.18, throttle: 45 },
  hitHeavy: { files: hits(1, 5), vol: 0.85, rate: 0.88, rateVar: 0.12, throttle: 60 },
  hitWet: { files: hits(6, 15), vol: 0.7, rate: 0.85, rateVar: 0.15, throttle: 50 },
  hitTear: { files: hits(16, 19), vol: 0.85, rate: 0.62, rateVar: 0.1, throttle: 70 },
  execute: { files: hits(21, 30), vol: 0.75, rate: 1.08, rateVar: 0.12, throttle: 80 },
  scream: { files: nums('scream', 0, 4, '.wav'), vol: 0.42, rateVar: 0.2, throttle: 120 },
  roar: { files: nums('roar', 0, 1, '.wav'), vol: 0.8, rate: 0.92, rateVar: 0.1, throttle: 300 },
  spellWindup: { files: ['spell0.wav'], vol: 0.6 },
  spellSting: { files: ['spell1.wav'], vol: 0.5, rateVar: 0.08 },
  spellZap: { files: ['spell1.wav'], vol: 0.32, rate: 1.35, rateVar: 0.2, throttle: 130 },
  spellDark: { files: ['spell2.wav'], vol: 0.6 },
  spellBig: { files: ['spell3.wav'], vol: 0.65 },
  spellWhisper: { files: ['spell4.wav'], vol: 0.55, rate: 0.8 },
  clank: { files: nums('clank', 0, 2, '.wav'), vol: 0.55, rateVar: 0.12, throttle: 100 },
  levelup: { files: ['levelup.wav'], vol: 0.5 },
  pickup: { files: nums('pickup', 0, 4, '.wav'), vol: 0.45, rateVar: 0.1 },
  door: { files: ['door.wav'], vol: 0.6 },
  select: { files: ['select.wav'], vol: 0.5 },
  win: { files: ['win.wav'], vol: 0.65 },
  lose: { files: ['lose.wav'], vol: 0.65 },
  // the crusader's pain vocal — the scream set pitched WAY down reads as a
  // low human "ooh"; its own entry so enemy screams can't throttle it away
  grunt: { files: nums('scream', 0, 4, '.wav'), vol: 0.65, rate: 0.58, rateVar: 0.07, throttle: 260 },
  // heavy: power armor, not sneakers — loud, pitched down
  stepDirt: { files: nums('stepdirt', 0, 9, '.wav'), vol: 0.62, rate: 0.8, rateVar: 0.1, throttle: 180 },
  stepStone: { files: nums('stepstone', 0, 2, '.ogg'), vol: 0.7, rate: 0.75, rateVar: 0.1, throttle: 180 },
};

const STREAMS = ['theme.mp3', 'menu.mp3', 'ambience.wav'];

class SfxEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private lowpass!: BiquadFilterNode;
  private musicGain!: GainNode;
  private buffers = new Map<string, AudioBuffer>();
  private lastPlay = new Map<string, number>();
  private droneNodes: { src: AudioBufferSourceNode; g: GainNode } | null = null;
  private musicStarted = false;
  private currentTrack = '';
  private muffleT = 0;
  private loaded = false;
  private loading = false;
  /** music dynamics: swells in combat, settles between fights */
  private combat = false;
  private musicOn = true;
  /** screen state: 'off' on death/pause, 'low' on victory, 'normal' otherwise */
  private musicMode: 'normal' | 'low' | 'off' = 'normal';
  /** whole-mix duck window (ultimate windup owns the soundstage) */
  private duckT = 0;

  private ensure(): AudioContext | null {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.lowpass = this.ctx.createBiquadFilter();
        this.lowpass.type = 'lowpass';
        this.lowpass.frequency.value = 18000;
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.85;
        this.master.connect(this.lowpass);
        this.lowpass.connect(this.ctx.destination);
        this.musicGain = this.ctx.createGain();
        this.musicGain.gain.value = 0.38; // louder base — tick() rides it from here
        this.musicGain.connect(this.lowpass);
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** fetch + decode EVERYTHING up front — call once at boot */
  async preload() {
    if (this.loading) return;
    this.loading = true;
    const ctx = this.ensure();
    if (!ctx) return;
    const names = new Set<string>();
    for (const def of Object.values(LIB)) for (const f of def.files) names.add(f);
    for (const f of STREAMS) names.add(f);
    await Promise.all(
      [...names].map(async (f) => {
        try {
          const res = await fetch(`audio/${f}`);
          const buf = await res.arrayBuffer();
          this.buffers.set(f, await ctx.decodeAudioData(buf));
        } catch {
          // a missing variant shouldn't kill the whole mix
        }
      }),
    );
    this.loaded = true;
  }

  unlock() {
    this.ensure();
    if (!this.loading) void this.preload();
  }

  private play(name: string, volMul = 1, rateMul = 1) {
    const ctx = this.ctx;
    const def = LIB[name];
    if (!ctx || !def || !this.loaded) return;
    const now = performance.now();
    if (def.throttle && now - (this.lastPlay.get(name) ?? -9999) < def.throttle) return;
    this.lastPlay.set(name, now);
    const file = def.files[Math.floor(Math.random() * def.files.length)];
    const buffer = this.buffers.get(file);
    if (!buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const base = def.rate ?? 1;
    const varr = def.rateVar ?? 0;
    src.playbackRate.value = (base + (Math.random() * 2 - 1) * varr) * rateMul;
    const g = ctx.createGain();
    g.gain.value = def.vol * volMul;
    src.connect(g);
    g.connect(this.master);
    src.start();
  }

  /** live looping sources by file — lets us prove exactly what is playing */
  private activeLoops = new Map<AudioBufferSourceNode, string>();

  get playingLoops(): string[] {
    return [...this.activeLoops.values()];
  }

  private loop(file: string, gainNode: GainNode): AudioBufferSourceNode | null {
    const ctx = this.ctx;
    const buffer = this.buffers.get(file);
    if (!ctx || !buffer) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(gainNode);
    src.onended = () => this.activeLoops.delete(src);
    this.activeLoops.set(src, file);
    src.start();
    return src;
  }

  /** menu plays Ashen Tides; the descent itself runs Iron Pulse.
   * Sweeps ALL music loops, not just the remembered one — a stop issued while
   * the context is still resuming from the first gesture can be dropped by
   * the browser, and no path may leak a second track. */
  startMusic(track: 'menu' | 'game') {
    if (!this.loaded || !this.ctx) return;
    const file = track === 'menu' ? 'menu.mp3' : 'theme.mp3';
    let alreadyPlaying = false;
    for (const [src, f] of [...this.activeLoops.entries()]) {
      if (f !== 'menu.mp3' && f !== 'theme.mp3') continue;
      if (f === file) {
        alreadyPlaying = true;
        continue;
      }
      this.activeLoops.delete(src);
      try { src.stop(); } catch { /* already ended */ }
    }
    this.currentTrack = file;
    if (!alreadyPlaying) this.loop(file, this.musicGain);
    if (!this.musicStarted) {
      this.musicStarted = true;
      const ambGain = this.ctx.createGain();
      ambGain.gain.value = 0.14;
      ambGain.connect(this.lowpass);
      this.loop('ambience.wav', ambGain);
    }
  }

  // ---------------- combat ----------------
  shot() { this.play('shot'); }
  casketShot() { this.play('cannon'); }
  enemyShot() { this.play('glob'); }
  mortarShot() { this.play('mortar'); }
  hit() { this.play('hitLight'); }
  hurt() {
    // telegraphed pain: armor thud + a low "ooh" under it
    this.play('hitHeavy');
    this.play('grunt');
  }
  splat(big = false) {
    if (big) {
      this.play('hitHeavy', 1, 0.85);
      if (Math.random() < 0.6) this.play('scream');
    } else {
      this.play('hitWet');
      if (Math.random() < 0.25) this.play('scream', 0.8);
    }
  }
  tear() {
    this.play('hitTear');
    if (Math.random() < 0.4) this.play('scream', 0.9, 0.9);
  }
  execute() { this.play('execute'); }
  explosion() {
    this.play('hitHeavy', 1.2, 0.5);
    this.play('clank', 1, 0.7);
    this.play('roar', 0.55, 0.65);
  }
  zap() { this.play('spellZap'); }
  fire() { this.play('mortar', 0.8, 0.8); }
  slamWarn() { this.play('clank'); }
  propBreak() { this.play('hitLight', 0.7, 1.7); }
  bossRoar() { this.play('roar'); }
  frenzy() { this.play('roar', 0.9, 1.15); }
  whisper() { this.play('spellWhisper'); }
  windup() {
    // everything else steps back so the relic's intake is unmissable
    this.duck(0.95, 0.3);
    this.play('spellWindup', 3);
  }
  ready() { this.play('spellSting'); }
  bigLaunch() { this.play('biglaunch'); }
  darkSpell() { this.play('spellDark'); }
  ultLaunch() { this.play('spellBig'); }
  klaxon() {
    this.play('clank', 1.1, 1.2);
    setTimeout(() => this.play('clank', 1.1, 1.25), 480);
    setTimeout(() => this.play('clank', 1.1, 1.3), 960);
  }
  nuke() {
    this.explosion();
    this.muffle(3.0);
  }

  // ---------------- world / ui ----------------
  footstep(dirt: boolean) { this.play(dirt ? 'stepDirt' : 'stepStone'); }
  pickup() { this.play('pickup'); }
  /** XP mote tick — pitch climbs with the collection streak */
  mote(combo: number) {
    this.play('pickup', 0.8, Math.min(2.1, 1 + combo * 0.07));
  }
  /**
   * the level-up moment — layered samples standing in for a power chord
   * (no guitar riff in the pack; this is the heaviest combination we own)
   */
  levelUpRiff() {
    this.play('roar', 0.55, 1.35);
    this.play('spellSting', 1.0, 0.65);
    setTimeout(() => this.play('clank', 1.1, 0.7), 120);
    setTimeout(() => this.play('spellSting', 0.8, 1.0), 260);
  }
  door() { this.play('door'); }
  levelUp() {
    // heavy machine-shop clank, not a fanfare — the armor ratchets tighter
    this.play('clank', 1.1, 0.75);
    setTimeout(() => this.play('clank', 0.9, 1.05), 140);
  }
  uiSelect() { this.play('select'); }
  winJingle() {
    // no fanfare on a dead ship — heavy machinery seals the kill
    this.play('clank', 1.1, 0.6);
    setTimeout(() => this.play('roar', 0.5, 0.7), 150);
    setTimeout(() => this.play('clank', 1.0, 0.8), 420);
  }
  loseJingle() { this.play('lose'); }

  /** combat state drives the music level: louder in the fight, quiet after */
  setCombat(on: boolean) { this.combat = on; }
  setMusicEnabled(on: boolean) { this.musicOn = on; }
  get musicEnabled(): boolean { return this.musicOn; }

  private musicTarget(): number {
    if (!this.musicOn || this.musicMode === 'off') return 0;
    let t = this.combat ? 0.48 : 0.28;
    if (this.musicMode === 'low') t *= 0.35;
    if (this.duckT > 0) t *= 0.35;
    return t;
  }

  /** death and pause silence the music; victory turns it down to an ember.
   * Applied immediately — the sim (and its tick) may be frozen on a screen. */
  setMusicMode(mode: 'normal' | 'low' | 'off') {
    this.musicMode = mode;
    if (this.ctx && this.musicGain) {
      const g = this.musicGain.gain;
      g.cancelScheduledValues(this.ctx.currentTime);
      g.setValueAtTime(g.value, this.ctx.currentTime);
      g.linearRampToValueAtTime(this.musicTarget(), this.ctx.currentTime + 0.5);
    }
  }

  /** briefly pull the whole mix down so one hero sound can own the moment */
  duck(dur = 0.9, level = 0.3) {
    const ctx = this.ensure();
    if (!ctx) return;
    this.duckT = dur;
    const g = this.master.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(0.85 * level, ctx.currentTime);
    g.linearRampToValueAtTime(0.85, ctx.currentTime + dur);
  }

  /** low arcane hum while the dread meter is full */
  setDrone(on: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.loaded) return;
    if (on && !this.droneNodes) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.gain.linearRampToValueAtTime(0.11, ctx.currentTime + 1.0);
      g.connect(this.master);
      const src = this.loop('spell2.wav', g);
      if (src) {
        src.playbackRate.value = 0.6;
        this.droneNodes = { src, g };
      }
    } else if (!on && this.droneNodes) {
      const { src, g } = this.droneNodes;
      g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);
      src.stop(ctx.currentTime + 0.4);
      this.droneNodes = null;
    }
  }

  /** duck the whole mix behind a lowpass, recovering over `dur` seconds */
  muffle(dur: number) {
    const ctx = this.ensure();
    if (!ctx) return;
    this.muffleT = dur;
    this.lowpass.frequency.cancelScheduledValues(ctx.currentTime);
    this.lowpass.frequency.setValueAtTime(320, ctx.currentTime);
    this.lowpass.frequency.exponentialRampToValueAtTime(18000, ctx.currentTime + dur);
  }

  get muffled(): boolean {
    return this.muffleT > 0;
  }
  tick(dt: number) {
    if (this.muffleT > 0) this.muffleT -= dt;
    if (this.duckT > 0) this.duckT -= dt;
    // enforcement: any music loop that isn't the current track dies here —
    // catches stops the browser lost during a suspended-context transition
    if (this.currentTrack) {
      for (const [src, f] of this.activeLoops) {
        if ((f === 'menu.mp3' || f === 'theme.mp3') && f !== this.currentTrack) {
          this.activeLoops.delete(src);
          try { src.stop(); } catch { /* already ended */ }
        }
      }
    }
    // music rides the fight: 0.48 in combat, 0.28 in the quiet, 0 when off,
    // and it steps aside with everything else while the relic winds up
    if (this.musicGain && this.ctx) {
      const target = this.musicTarget();
      const cur = this.musicGain.gain.value;
      this.musicGain.gain.value = cur + (target - cur) * Math.min(1, dt * 2.2);
    }
  }
}

export const sfx = new SfxEngine();

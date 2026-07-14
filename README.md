# ALTERRO — Hollow Crusade

Grimdark arena roguelite (Archero-style loop) with manually-triggered spectacle Ultimates.
Full design document: [DESIGN.md](DESIGN.md).

Three.js + TypeScript + Vite. True 3D scenes, fixed camera angle, browser-first.

## Run

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production build to dist/
```

## Controls

| Input | Action |
|---|---|
| WASD / arrows | Move — moving suspends fire |
| (stand still) | Auto-fire at the nearest enemy |
| **Mouse click** | **Unleash the Ultimate when the dread ring ignites** |

## What's implemented (v0 vertical slice)

- **Core loop (DD §3):** move/stop auto-fire, 15-room Act 1 descent, door progression, HP orb drops. Rooms are **two screens tall** (24×30) with a smooth follow camera clamped to the walls — the far half stays unseen until you push north. An **aggro leash** (14u, broken by damage) keeps the unseen half from converging early.
- **Pathfinding:** BFS flow-field over a 1u grid, recomputed 4×/s toward the player — every chaser gets obstacle-aware routing for free. Enemies with clear line of sight steer directly; blocked ones follow the field through gaps and around cover (verified: a husk threads three coolant-pipe walls to reach the player).
- **Themed shells & doors:** outdoor rooms have no artificial walls — the crash site is an open horizon bounded by rock outcrops and dead trees over a ground skirt, with glowing coals for light. Room 1 exits through a fire-lit canyon pass blocked by a wedged hull slab; room 2 ends at the ship itself — a towering ribbed hull with a recessed airlock between orange guide strips. Interior exits are themed per zone: bulkhead doors, heavy ribbed freight blast doors with piston towers (cargo/fire control/foundry), sealed containment locks with portholes and warning rings (coolant/reactor), and crew hatches with window slits and handle wheels (quarters/mess/hydroponics).
- **Deliberate level design:** the descent reads as a journey through 12 authored zones — Crash Site and Debris Field on the burning surface (cracked earth, corpses, burning wreckage, the dying ship on the horizon) → Hull Breach (peeled plates, sparking cables, emergency strobes) → Cargo Hold (container stacks, an east–west gantry crane with swaying hook) → Living Quarters (bunks, lockers, a guttering lamp) → Mess Hall (set tables, a swinging light) → Hydroponics (pulsing green vats, overgrown troughs) → Engine Row (hammering pistons, spinning flywheels, steam) → Coolant Ducts (trunk pipes with frost-glow strips and crawl-through gaps) → Reactor Chamber (a caged, pulsing core column with radial conduits) → Control Deck (a blinking console horseshoe, indicator walls, holo plot table) → Fire Control (torpedo tubes, ordnance racks, launch strobes) → the Foundry Dock boss arena (molten slag channels, crucibles, idle crane). Zones own surfaces (5 texture families), palette, fog, cover layout, ambient vents (fire/steam/sparks), and animated set dressing (blink/pulse/spin/sway/piston registries).
- **XP (Archero-style):** enemies drop experience motes where they die; nothing is collected until the room falls silent — then every mote lifts off and streaks home to the crusader. Auto-fire only targets enemies with clear line of sight; machine enemies (Hull Ram, the Foreman) shed sparks, metal parts, and oil instead of blood.
- **Rite Wheel (DD §3.3):** level-ups pause the sim and offer 1-of-3 rarity-weighted cards — weapon mods (multishot, pierce, ricochet, burn, crit, lifesteal), defense, mobility, and Ultimate cards (charge rate, Tier Rite, Overcharge, Adrenal Feed).
- **Ultimate system (DD §5):** Dread Meter (charged by damage dealt, 3× by damage taken, holds indefinitely), one sacred click to fire with 0.4s windup + invulnerability, 3 tiers via Tier Rite cards. All 8 launch Ultimates:
  Gravelight · The Quiet Word · Red Choir · Deadhand Protocol · Butcher's Waltz · Hollow King's Grasp · Sentinel Casket · Pyre Sermon.
- **Gore (DD §6.2, M2):** true dismemberment — actual rig limbs tear off (on death, on heavy hits to the living, heads on executions) and tumble with physics, bleeding where they bounce and settle. Instanced gib pool (768) with landing splats, blood decals (1400) with widening kill-pools and directional spray streaks, blood trails on badly wounded enemies, overkill states with hit-stop and kill-flash, per-Ultimate death states (vaporize/ash, head-pop self-inflictions, executions), scorched floors, wet tear/splat audio layers.
- **Act 1 bestiary (DD §6.1):** Grafted Husk (melee), Vent Crawler (swarm), Bile Spitter (kiting ranged), Mortar Polyp (rooted turret, slow dodgeable orbs), Conduit Wretch (mid-range electric channeler), Hull Ram (room-crossing charger that stuns itself on walls), Bulkhead Bulwark (elite), THE FOREMAN (boss: charge + slam attacks, add spawns, phase 2 enrage, smoking exhaust stacks).
- **Rendering:** GTAO + bloom post chain (MSAA render target), IBL environment, per-room lighting themes, glowing floor grates and flickering consoles. Textures are noise-synthesized (FBM + domain warping + Worley cellular, `render/noise.ts`): the crash-site crust is a cracked Worley network with ember-glow emissive veins, metal surfaces carry warped-FBM grime. A lit ground-fog billboard layer (Lambert material) drifts through rooms and picks up light from the reactor core, fires, and muzzle flashes; player bolts carry their own point lights and paint the deck as they fly.
- **Particles:** pooled billboard system — muzzle sparks + smoke, blood mist at wounds, flames on burning enemies and ground fire, electric arcs (shocker channel, relic at full charge), embers, exhaust smoke.
- **Animation:** procedural rigs — walk cycles on pivoted limbs, windup poses (huskers rear back, chargers crouch, mortars recoil), boss claw pistons, player march/recoil/brace, no keyframe assets.
- **Horror lighting (DD §7):** grim ≠ dim — readable arena, mood from materials and colored practicals, per-Ultimate mood shifts.
- **Audio (DD §8):** fully sample-based from the licensed pack in `public/audio` (sourced from `/resources`) — 37 hit/punch variants for impacts and gore, screams on kills and dismemberments, distinct shot/mortar/glob launches, spell stings for ultimates, roars for the boss and Red Choir, footsteps (dirt outside, deck inside), UI clicks, level-up/win/lose jingles, looping main theme (*Ashen Tides*) plus cave ambience, and the lowpass "deafened" muffle after the nuke. **Everything is fetched and decoded at boot** — nothing loads mid-fight. Per-sound volume/pitch-variance/throttle live in one table in `src/core/sfx.ts`.
- Deterministic seeded sim (mulberry32), fixed timestep, data-driven enemies/cards/ultimates.

## Not yet implemented (per DD)

- Dark Shrines (mid-run Ultimate swap), Mutations (Sanctified branches)
- Acts 2–3, meta-progression (Marrow, Reliquary hub, mastery), Vigils, Daily Descent
- Accessibility toggles (gore reduction, photosensitivity)

## Dev notes

- `window.__alterro` (dev builds only): `beginRun(id)`, `step(n)`, `shot()` — headless sim stepping and frame capture for automated playtesting.
- `POST /__shot?name=x` (dev server only): saves a posted data-URL frame to `shots/x.jpg`.
- Stress-test scene per DD §11: Deadhand whiteout over a room full of gibs.

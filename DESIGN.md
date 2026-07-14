# PROJECT ALTERRO — Game Design Document

**Working title:** Alterro (candidates: *Last Rites*, *Gravebound*, *Purge Protocol*, *Hollow Crusade*)
**Genre:** Top-down arena roguelite (Archero-like) with grimdark military sci-fi horror aesthetic
**Platform:** PC (browser dev builds; Steam via desktop wrapper), gamepad supported
**Tech:** Three.js / TypeScript — full 3D, fixed camera angle (see §11)
**Rating target:** M / PEGI 18 (intense violence, gore, horror)
**Document version:** 0.3 — 2026-07-14 (playtest round 1 incorporated)

---

## 1. High Concept

You are the last armored crusader of a dead order, descending through derelict void-ships, plague-worlds, and heretic warrens infested with things that should not exist. Combat is the proven Archero loop — move to dodge, stand still to fire — but soaked in blood and dread. The signature addition: **Ultimates** — rare, screen-shattering superweapons and psychic atrocities that you select, upgrade, and mutate across a run, then unleash manually with a mouse click when charged.

**One-liner:** *Archero's flow, DOOM's brutality, a horror film's nerves — and a big red button.*

---

## 2. Design Pillars

1. **One input to master, one button to earn.** Movement is the whole skill ceiling (Archero DNA). The Ultimate is the single deliberate action the player takes — everything else is automatic. Charging it, timing it, and choosing it *is* the strategy layer.
2. **Violence with weight.** Every kill should feel wet and heavy. Gibs, decals that persist, screen shake, sound design that punches. The arena should look like a slaughterhouse by the time the door opens. Weight is physical, not just visual: every hit shoves (knockback scaled by bulk), overkills freeze the frame for an instant, the crusader accelerates and coasts like armor should, firing recoils the body, ejects brass, and throws light. Enemies are deliberate and slow — dread comes from being cornered, not outrun.
3. **Horror, not just darkness.** Enemies are disturbing, not merely "evil aliens." Silhouettes should be readable but wrong — too many joints, human parts where they shouldn't be, sounds that make players turn the volume down.
4. **Ultimates are events.** An Ultimate firing should be the most spectacular thing on screen all run — a full audiovisual set piece lasting 2–6 seconds, never a stat buff.

---

## 3. Core Gameplay Loop

### 3.1 Moment-to-moment (the Archero contract)

- **Move** with WASD / left stick. While moving, you do not fire.
- **Stop** and your weapon auto-fires at the nearest / targeted enemy.
- The entire micro-game is deciding *when you can afford to stand still*.
- Rooms are single-screen (or lightly scrolling) arenas. Clear all enemies → door opens → choose exit → next room.
- Rooms contain **cover obstacles** (crates, pillars, drums) that block projectiles for both sides, plus seeded prop clutter and a per-room **lighting theme** (sodium / bile / coolant / emergency-red for elites and bosses) so no two rooms read identical. Boss arenas stay clean for charge attacks.

### 3.2 Run structure

- A run = one **Descent**: 3 acts × ~15 rooms, each act ending in a boss.
- Room types: combat (majority), elite combat, shrine (see §6.4), armory cache (gear/consumable), reliquary (lore + resource), boss.
- Death is permanent for the run. Meta-currency ("Marrow") persists.
- Target run length: 25–40 minutes full clear; first boss reachable in ~8 minutes.

### 3.3 In-run leveling (the wheel)

- Killing enemies grants XP. On level-up, time slows and the **Rite Wheel** appears: choose 1 of 3 upgrade cards.
- Card pool: weapon mods (ricochet, piercing, multishot, burn), defensive (ward, lifesteal, thorns), movement (phase-step, blood trail), and — critically — **Ultimate cards** (see §5.4).
- Rarities: Common / Honed / Consecrated / Forbidden. Forbidden cards are powerful with a drawback (classic devil's bargain).

---

## 4. Controls

| Input | Action |
|---|---|
| WASD / left stick | Move (suspends firing) |
| — (automatic) | Fire at nearest enemy while stationary |
| **Left mouse click / RT** | **Activate Ultimate (when charged)** |
| Right click / LB (optional, late-game unlock) | Consumable (stim, grenade) |
| Tab / Select | Run summary & build overview |
| Esc | Pause |

Design note: the mouse does **not** aim. Keeping auto-aim preserves the Archero purity and makes the single click sacred — the only "verb" the player consciously performs is the Ultimate. On mobile (future), Ultimate = tap the charge ring.

---

## 5. The Ultimate System (signature feature)

### 5.1 Rules

- Exactly **one Ultimate equipped** at a time.
- Charges via a **Dread Meter** filled by dealing damage, taking damage (small bonus — desperation fuel), and kill streaks.
- When full, the meter ignites (UI + audio sting: a low choir swell and the weapon on the character's back starts glowing/screaming). It **holds charge indefinitely** — no decay — so timing is a real decision, not a use-it-or-lose-it panic.
- Activation is a manual click. There is a deliberate ~0.4s windup (animation: the crusader plants their feet / the relic unfolds) — interruptible only by death. During the effect the player is invulnerable.
- Base charge time target: ~90 seconds of active combat; tunable per Ultimate (a nuke charges slower than a turret).

### 5.2 Acquisition & swapping

- **Pre-run:** choose your equipped Ultimate in the **Reliquary** (meta hub). New Ultimates are unlocked by meta-progression: boss first-kills, act completions, and secret rites (see §9).
- **Mid-run:** *Dark Shrines* (rare room type, ~1–2 per act) offer a choice: swap your Ultimate for one of 2 random alternatives (keeping your current upgrade tier), or bank a large charge refill. Swapping mid-run supports adaptation — took a crowd-heavy act? Trade the single-target lance for the Madness plague.

### 5.3 Upgrade tiers & mutations

Each Ultimate has 3 tiers (**Awakened → Sanctified → Apotheosis**) plus branch **Mutations**:

- Tiers raise raw numbers and visual scale (a Tier 1 nuke cracks the floor; Tier 3 whites out the screen and leaves a burning crater for the rest of the room).
- At Sanctified, choose 1 of 2 **Mutations** that change behavior, not just numbers (examples below).
- Tiers/Mutations are bought with **Rite Wheel cards** in-run (see §5.4) and permanently discounted by meta-progression.

### 5.4 Ultimate cards on the Rite Wheel

Ultimate-related cards appear in the level-up pool alongside normal upgrades, competing for the same picks (a real build tension: power now vs. a bigger button later):

- **Whetted Dread** — +20% charge rate.
- **Tier Rite** — upgrade the equipped Ultimate one tier (Consecrated rarity).
- **Mutation Rite** — unlock/switch a Mutation (appears only at Sanctified+).
- **Twin Reliquary** (Forbidden) — carry a second Ultimate at −40% charge rate for both.
- **Overcharge** (Forbidden) — Ultimate fires at 150% potency, but activating it costs 15% max HP.

### 5.5 The Ultimates (launch roster: 8)

Every Ultimate is a set piece: unique camera behavior, unique audio, unique aftermath decals. Placeholder names are thematic; final naming pass later.

**Roster staging (playtest round 1):** only 4 relics are offered at the start — Gravelight, The Quiet Word, Red Choir, Deadhand Protocol — the rest unlock via meta-progression. Selection UI stays casual: name, one punchy line, a FAST/STEADY/SLOW charge label. Long descriptions and flavor live in codex/tooltips, never on the pick screen.

| # | Name | Fantasy | Effect | Spectacle notes |
|---|---|---|---|---|
| 1 | **Gravelight** (the BFG) | Relic energy cannon | Fires a slow, colossal green-black orb that arcs lethal filaments to every enemy near its path; detonates at the far wall. | Screen desaturates except the orb; filaments whip-crack with individual sound hits; bodies it kills are vaporized to skeletons that hold pose for a beat, then collapse. |
| 2 | **The Quiet Word** (psycho) | Forbidden psychic sermon | Every non-boss enemy in the room turns its weapon/claws on itself and commits suicide over 2s. Bosses take heavy damage and are stunned, clawing at their own head. | All audio drops to a single whispering voice; enemies freeze, shudder, then self-destruct one by one in a wave radiating from the player. The silence is the spectacle. |
| 3 | **Red Choir** (madness) | Frenzy plague | For 8s all enemies target each other with +100% damage and frothing speed. Survivors of the brawl take the plague as a DoT. | Enemy eyes/lenses flare red; the HUD gains a subtle red vignette; combat log sounds become wet and frantic. Player can walk untouched through the massacre. |
| 4 | **Deadhand Protocol** (nuke) | Orbital deletion | 1.5s of klaxon + targeting pillar, then the entire arena is wiped. Everything non-boss dies; bosses lose 25% max HP. Floor is scorched for the rest of the room (minor burn zone for later spawns). | The one Ultimate with a delay — sirens, a shadow growing at the player's feet, then whiteout and a muffled-hearing aftermath (audio ducks for 3s, high-pitch ring). |
| 5 | **Butcher's Waltz** | Execution dash | The crusader chains dash-executions: teleports between up to 12 enemies, one melee kill-animation each (0.15s cadence), invulnerable throughout. | Camera pulls in slightly; each kill is a different snap animation; ends with the crusader still, then all 12 bodies fall at once. |
| 6 | **Hollow King's Grasp** | Singularity | A black sphere opens at the room's center: drags all enemies in, crushes them over 3s, then ejects a shockwave of gore and shrapnel that damages anything that survived. | Physics pull on gibs/decals/projectiles too; light bends around the sphere; the ejection paints the whole room red. |
| 7 | **Sentinel Casket** | Summoned ally | A coffin-shaped war engine slams down from orbit and fights beside you for 20s with twin cannons and a stomp aura, taunting enemies. | Landing craters the floor; the casket's lid opens to reveal something half-machine, half-corpse; it screams when it expires. |
| 8 | **Pyre Sermon** | Flame purge | Expanding ring of white fire from the player; enemies ignite, panic, and spread fire to each other. Burning ground persists 10s. | Fire is the room's only light source for its duration — the ambient lighting cuts out and the ring illuminates the horror around you. |

**Mutation examples** (Sanctified tier, choose 1 of 2):
- *Gravelight*: orb splits into 3 seeking orblets on detonation ⟂ orb moves slower but filaments execute (<20% HP instantly killed).
- *The Quiet Word*: suicides explode, damaging neighbors ⟂ 20% of victims rise as briefly allied husks.
- *Red Choir*: duration doubles but bosses also frenzy ⟂ each frenzy-kill extends duration 0.5s.
- *Deadhand Protocol*: no siren delay ⟂ leaves permanent radiation zone that also damages enemies in the next 2 rooms of this act.

### 5.6 Balance guardrails

- Ultimates must never trivialize bosses: all room-clear effects have explicit reduced boss interactions (stun, %-damage caps).
- Charge-rate stacking is capped at +60% total.
- Anti-hoarding nudge: rooms cleared *with* an Ultimate active grant +10% Marrow — spending is rewarded, hoarding is permitted.

---

## 6. Enemies

### 6.1 Bestiary direction

Three corruption strains, escalating per act. All designs follow the pillar: readable silhouette, wrong details.

- **Act 1 — The Drowned Hulk (wrecked void-ship): the Grafted.** Crew fused with the ship. Maintenance servitors with human screaming faces, crawling torso-swarms in the vents, a boarding sergeant whose armor grew into his flesh. Industrial horror, flickering light. **Zone progression (playtest round 2):** the 15 rooms are authored as a legible journey — Crash Site → Debris Field → Hull Breach → Cargo Hold ×2 → Living Quarters → Mess Hall → Hydroponics → Engine Row ×2 → Coolant Ducts → Reactor Chamber → Control Deck → Fire Control → Foundry Dock (boss). Each zone owns its surfaces, palette, cover layout, and animated set dressing; overhead structures never cross the fighting lane.
- **Act 2 — Ossuary World: the Risen Choir.** A planet-wide grave that started singing. Bone-armored revenants, floating cantors whose hymns buff other enemies (kill priority), grave-tides (slow swarm walls that force movement). Gothic horror, fog, candle-light.
- **Act 3 — The Throat (heretic warren): the Meat.** The source. Architecture is tissue. Walls spawn enemies, floors digest decals, enemies here are pieces of one organism — killing them makes the *room itself* react (spasms, new spawn pores). Biological horror, wet audio.

### 6.2 Enemy design rules

- Every enemy telegraphs with animation + audio ≥0.5s before any attack (Archero fairness).
- Roster per act: ~8 basics, 2 elites, 1 boss. Elites are basics "gone worse" — a Grafted servitor elite drags a whole bulkhead as a shield.
- **Gore feedback tiers:** normal kill → wound decals + collapse; overkill (damage ≥2× remaining HP) → gib burst; Ultimate kill → unique per-Ultimate death (vaporized skeleton, self-inflicted, crushed, burned husk). Overkill states are the player's damage meter — you *see* your build getting stronger.

### 6.3 Bosses

One per act, multi-phase, arena-altering:
1. **The Foreman** (Act 1) — a loader-exoskeleton with its pilot liquefied inside, still issuing work orders over the PA. Phase 2 tears open the floor: fight continues on catwalks.
2. **Cantor Maximal** (Act 2) — a cathedral-sized revenant conductor; its choir shields it, and its hymn reverses your controls in phase 3 (short bursts, heavily telegraphed).
3. **The Wound** (Act 3) — you fight the room. Walls, pillars, and floor are all targetable organs; killing organs opens the core. The final phase attacks with everything you've killed all run (recycled corpses).

### 6.4 Dark Shrines

Flesh-altar rooms, no combat. Offer the Ultimate swap/refill choice (§5.2). The shrine *watches* the player (eyes track). Using one three times in a run has a secret consequence (see §9).

---

## 7. Art Direction

- **Palette:** near-monochrome environments (steel, bone, ash) so blood reads maximally red and Ultimate VFX own the screen. Each act has one accent hue (Act 1 sodium-orange, Act 2 candle-gold, Act 3 vein-purple).
- **Camera:** top-down ~50°, slight dynamic zoom (out in swarms, punch-in on Ultimates and boss kills).
- **The player character:** hulking powered armor, battered and over-adorned — purity seals, chains, trophy bones. Readable at small size by silhouette (massive shoulders, backpack relic that visually IS the equipped Ultimate — swapping Ultimates visibly changes your back-mounted weapon/reliquary).
- **Gore tech:** persistent decals per room (budget-capped, oldest fade), gib physics, blood pooling that spreads over ~2s. A "Cathedral of Violence" test: after a hard room, a screenshot should look like a crime scene.
- **Horror lighting — grim ≠ dim (playtest round 1):** the arena is readable everywhere; mood comes from desaturated PBR materials (procedurally generated deck plating, grime, wear), colored practicals, and contrast — never from underexposure. IBL + one shadowed key light + player-carried warm fill. Special fully-dark rooms are a deliberate rare setpiece, not the default.
- Accessibility toggle: gore reduction mode (decals off, gibs → ash), photosensitivity mode (no whiteouts/strobes), arachnophobia-adjacent toggle if any skittering enemy tests poorly.

## 8. Audio Direction

- Dynamic mix: combat layers build with kill streaks; full Dread Meter adds a low choir drone until spent.
- Every Ultimate has an exclusive audio moment where the normal mix ducks entirely (see spectacle notes, §5.5).
- Horror sound design budget priority: enemy idle sounds (heard before seen) > death sounds > music.

---

## 9. Meta-Progression

- **Marrow** (main currency): permanent talent tree — HP, damage, charge rate, starting card rarity, revive (1/run, expensive).
- **Ultimate unlocks:** each boss first-kill unlocks one; 2 launch Ultimates are secret-gated (e.g., *The Quiet Word* unlocks by using Dark Shrines 3× in one run and surviving what that summons).
- **Ultimate mastery:** per-Ultimate kill counters unlock permanent perks (e.g., Gravelight 500 kills → starts each run at 25% charge) and cosmetic evolutions of the back-mounted relic.
- **Reliquary hub:** a ruined chapel-armory between runs. NPCs arrive as you progress (a blind armorer, a chained "consultant" from Act 3). Lore delivered via reliquary items, not cutscenes.

## 10. Difficulty & Session Design

- Base difficulty tuned so a first full clear takes a typical player 8–15 runs.
- Post-clear: **Vigils** (ascension-style modifiers, 10 levels) — e.g., Vigil 3: Ultimates cost HP to fire; Vigil 7: Dark Shrines always demand a price.
- Daily Descent: fixed-seed run with a forced random Ultimate, leaderboard by clear time.

---

## 11. Technical Notes

- **Engine: Three.js (WebGL2, WebGPU when stable), TypeScript.** Full 3D scenes rendered from a **fixed camera angle** (~50° top-down, perspective projection with tight FOV so it reads near-orthographic). "2.5D" means the camera never rotates — but environments, characters, gibs, and VFX are all true 3D, so we get real dynamic lighting (critical for §7 horror lighting), 3D physics for gibs, and volumetric-feeling Ultimate VFX cheaply.
- **Distribution:** runs in browser during development (instant playtest links); ships on Steam via a desktop wrapper (Tauri preferred over Electron for footprint). PC-first per §13.
- **Rendering strategy for the gore budget:**
  - Gibs: `InstancedMesh` pools with a simple impulse-physics tick (no full physics engine needed for debris; a lightweight step — gravity, bounce, settle, freeze — is enough).
  - Blood/scorch decals: texture-atlas decals projected onto floor geometry, drawn into a per-room render-target that accumulates over the fight ("crime scene" persistence at near-zero per-frame cost).
  - Enemies: skinned meshes with instancing where variants allow; hard cap ~60 active.
  - Ultimate VFX: custom shaders per Ultimate (fullscreen passes allowed — desaturation for Gravelight, whiteout for Deadhand); these are the showpieces, budget accordingly.
- **Simulation:** fixed-timestep deterministic sim (seeded PRNG, no `Math.random`) decoupled from render — needed for Daily Descent and keeps gameplay stable at any framerate.
- **Architecture:** lightweight ECS or component-store pattern; enemies, cards, and Ultimates defined in data (JSON/TS const modules), so balance and new Ultimates don't require engine-code changes.
- Performance target: 60 fps minimum during Deadhand Protocol whiteout with a full room of gibs — this is the stress-test scene; build it early. Guard the draw-call count from day one (instancing, merged static room geometry).

## 12. MVP / Milestone Plan

1. **M0 — Toy (2–3 wks):** one room, move/stop/auto-fire, 2 enemy types, XP + 6-card wheel. *Validates: is the core loop fun without any theme?*
2. **M1 — The Button (2 wks):** Dread Meter + 2 Ultimates (Gravelight, Deadhand Protocol) with placeholder VFX. *Validates: does manual Ultimate timing add real decisions?*
3. **M2 — Blood (3 wks):** gore/decal/overkill system, audio pass on kills. *Validates: violence-with-weight pillar.*
4. **M3 — Vertical slice:** Act 1 complete (8 enemies, elite, Foreman boss, shrines, 4 Ultimates, meta hub stub).
5. **M4 — Content build-out:** Acts 2–3, full roster of 8 Ultimates, meta tree, Vigils.

## 13. Decisions & Open Questions

**Resolved (2026-07-14):**
1. ✅ **PC-only** until vertical slice; mobile deferred (would reshape §3.2 sessions and §9 monetization if revisited).
2. ✅ **Mouse does not aim.** Auto-aim stays; the click is reserved for the Ultimate. No twin-stick variant will be prototyped.
3. ✅ **Original IP.** Grimdark aesthetic with original order/mythology (the Hollow Crusade, the Meat, etc.); naming/lore pass with fresh eyes before any public material.
4. ✅ **Tech: Three.js, full 3D with fixed camera angle** ("2.5D") — see §11.

**Open:**
1. **Second currency** for in-run shop rooms (gold vs. Marrow-only) — decide at M3.
2. Co-op: out of scope for v1; architecture shouldn't preclude it (deterministic sim helps).

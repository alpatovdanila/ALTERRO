import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { getTexLib, texturedStd, spriteTex, type TexSet } from './textures';
import { zoneForRoom, type FxReg, type ZoneVent, type RoomBuild } from './zones';
import { boxGeo, cylGeo, rockGeo, torusGeo } from './geocache';
import type { Rng } from '../core/rng';

export type { Collider } from './zones';

// The fixed-angle 3D stage (DESIGN.md §7, §11). Lighting principle: grim ≠ dim —
// the arena stays readable everywhere; mood comes from palette, materials and
// colored practicals, not underexposure. IBL + one shadowed key light,
// player-carried warm fill, flickering per-room accent lights.

export const ARENA_W = 24; // x: -12..12
export const ARENA_D = 30; // z: -15..15 — two screens tall; the camera follows
export const WALL_H = 2.2;

/**
 * Effect sprites (particles, fog, rings, zaps) live on this layer. They are
 * excluded from the main render AND from GTAO's depth/normal prepass, then
 * drawn by FxOverlayPass AFTER the AO composite — so ambient occlusion can
 * never darken their edges (the old "dark smudge around effects" artifact).
 */
export const FX_LAYER = 1;

/** GTAO with its internal targets at half resolution. EffectComposer forces
 * pass.setSize(fullW, fullH) on add and on every resize, so the scale must
 * live in the override — constructor args alone do not survive. */
class HalfResGTAOPass extends GTAOPass {
  resolutionScale = 0.5;
  setSize(width: number, height: number) {
    super.setSize(
      Math.max(1, Math.round(width * this.resolutionScale)),
      Math.max(1, Math.round(height * this.resolutionScale)),
    );
  }
}

/** bloom with its mip chain one octave lower — bloom is blur by definition */
class HalfResBloomPass extends UnrealBloomPass {
  setSize(width: number, height: number) {
    super.setSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
  }
}

/**
 * Copies the AO-composited image into writeBuffer (whose depth attachment
 * still holds the world depth from RenderPass — GTAO never touches it), then
 * renders the FX layer on top with that depth. Effects stay occluded by
 * walls/props but are untouched by AO, and they draw over floor decals.
 */
class FxOverlayPass extends Pass {
  private copyQuad: FullScreenQuad;

  constructor(
    private sceneRef: THREE.Scene,
    private cameraRef: THREE.Camera,
  ) {
    super();
    this.needsSwap = true;
    this.copyQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
        vertexShader: CopyShader.vertexShader,
        fragmentShader: CopyShader.fragmentShader,
        blending: THREE.NoBlending,
        depthTest: false,
        depthWrite: false,
      }),
    );
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const oldAutoClear = renderer.autoClear;
    const oldMask = this.cameraRef.layers.mask;
    const oldBackground = this.sceneRef.background;
    // BEFORE the copy: any renderer.render() clears the bound target while
    // autoClear is on, which would wipe the world depth we depend on
    renderer.autoClear = false;
    // a Color background force-clears even with autoClear off
    this.sceneRef.background = null;

    (this.copyQuad.material as THREE.ShaderMaterial).uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(writeBuffer);
    this.copyQuad.render(renderer);

    this.cameraRef.layers.set(FX_LAYER);
    renderer.render(this.sceneRef, this.cameraRef);

    this.cameraRef.layers.mask = oldMask;
    this.sceneRef.background = oldBackground;
    renderer.autoClear = oldAutoClear;
  }

  dispose() {
    (this.copyQuad.material as THREE.ShaderMaterial).dispose();
    this.copyQuad.dispose();
  }
}

interface Zap {
  line: THREE.Line;
  t: number;
}

interface Ring {
  mesh: THREE.Mesh;
  t: number;
  dur: number;
  maxR: number;
  mat: THREE.MeshBasicMaterial;
  /** live position to follow (e.g. the player) — read every frame */
  track?: THREE.Vector3;
}

const tmpV = new THREE.Vector3();

/** animated set-dressing registries, rebuilt per room */
interface BlinkEntry { mat: THREE.MeshBasicMaterial; on: THREE.Color; off: THREE.Color; speed: number; phase: number }
interface PulseLightEntry { light: THREE.PointLight; base: number; amp: number; speed: number; phase: number }
interface SpinEntry { o: THREE.Object3D; axis: 'x' | 'y' | 'z'; speed: number }
interface SwayEntry { o: THREE.Object3D; amp: number; speed: number }
interface PistonEntry { o: THREE.Object3D; baseY: number; amp: number; speed: number; phase: number }

export class Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  private composer!: EffectComposer;
  gtao!: GTAOPass;

  private ambient: THREE.AmbientLight;
  private hemi: THREE.HemisphereLight;
  private key: THREE.DirectionalLight;
  private muzzle: THREE.PointLight;
  private muzzleT = 0;
  private cornerLights: { light: THREE.PointLight; lamp: THREE.MeshBasicMaterial; base: number; phase: number }[] = [];
  private floorMat!: THREE.MeshStandardMaterial;
  private doorSlab!: THREE.Mesh;
  private doorFrameMat!: THREE.MeshStandardMaterial;
  private doorGlow!: THREE.PointLight;
  private doorLampMat!: THREE.MeshBasicMaterial;
  private roomGroup: THREE.Group | null = null;
  /** walls / perimeter / door — rebuilt per room to match the zone's theme */
  private shellGroup: THREE.Group | null = null;
  private wallMat!: THREE.MeshStandardMaterial;
  private skirtMat!: THREE.MeshStandardMaterial;

  // zone texture library (generated once at boot)
  private floorSets!: Record<'ground' | 'deck' | 'tile', TexSet>;
  private wallSets!: Record<'rock' | 'panel', TexSet>;
  private zoneFloorTint = 0x777a80;

  /** ambient emitter points for the current room (game spawns the particles) */
  vents: ZoneVent[] = [];

  // per-room animation registries
  private blinks: BlinkEntry[] = [];
  private pulseLights: PulseLightEntry[] = [];
  private spins: SpinEntry[] = [];
  private sways: SwayEntry[] = [];
  private pistons: PistonEntry[] = [];

  // cheap volumetrics: lit fog billboards drifting near the floor
  private fogMesh!: THREE.InstancedMesh;
  private fogData: { x: number; z: number; y: number; s: number; phase: number }[] = [];

  /** fixed-size pool of transient point lights — constant scene light count */
  private lightPool: THREE.PointLight[] = [];

  private zaps: Zap[] = [];
  private rings: Ring[] = [];

  private trauma = 0;
  private mood: { color: THREE.Color; amb: number; t: number } | null = null;

  private baseAmbColor = new THREE.Color(0x3a3d46);
  // brighter and PUNCHIER: the key climbs faster than the ambient, so the
  // scene gains contrast, not just exposure (playtest rounds 14/16)
  private readonly AMB_BASE = 0.56;
  private readonly KEY_BASE = 2.15;
  private camBase = new THREE.Vector3(0, 17.5, 12.8);
  /** menu close-up: when set, the camera dollies in on the hero instead */
  menuFocus: THREE.Vector3 | null = null;
  /** smoothed camera focus — follows the player down the long rooms */
  private camFocusZ = ARENA_D / 2 - 5;

  constructor(host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // hidden/embedded documents can report 0×0 at boot — never size to zero
    this.renderer.setSize(Math.max(window.innerWidth, 640), Math.max(window.innerHeight, 360));
    this.renderer.shadowMap.enabled = true;
    // PCF (not soft): the map is baked and static, and soft filtering costs
    // extra taps on every full-screen floor fragment
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.32;
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x08080a);
    this.scene.fog = new THREE.FogExp2(0x0a0908, 0.011);

    // image-based lighting so PBR materials have something to reflect
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.19;
    pmrem.dispose();

    // guard the aspect too: a hidden/embedded document can report 0×0 at
    // boot, and 0/0 = NaN poisons the projection matrix → black frame forever
    this.camera = new THREE.PerspectiveCamera(
      38,
      Math.max(window.innerWidth, 640) / Math.max(window.innerHeight, 360),
      1,
      80,
    );
    this.camera.position.copy(this.camBase);
    this.camera.lookAt(0, 0, -0.6);

    this.ambient = new THREE.AmbientLight(this.baseAmbColor, this.AMB_BASE);
    this.scene.add(this.ambient);
    this.hemi = new THREE.HemisphereLight(0x454a58, 0x14130f, 0.68);
    this.scene.add(this.hemi);

    // single shadowed key light — cold overhead work-lighting.
    // Shadows are BAKED: rendered once per room (static geometry only), then
    // frozen. Moving things use blob shadows — no per-frame shadow pass.
    this.key = new THREE.DirectionalLight(0x9fb0cc, this.KEY_BASE);
    this.key.position.set(7, 18, 6);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.camera.left = -ARENA_W / 2 - 2;
    this.key.shadow.camera.right = ARENA_W / 2 + 2;
    this.key.shadow.camera.top = ARENA_D / 2 + 4;
    this.key.shadow.camera.bottom = -ARENA_D / 2 - 4;
    this.key.shadow.camera.far = 40;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.autoUpdate = false;
    this.scene.add(this.key);
    this.scene.add(this.key.target);

    // fixed pool of transient point lights (bolts, fires, ult glows).
    // The scene's light COUNT never changes mid-room — adding/removing lights
    // forces three.js to recompile every shader, which was the big freeze.
    // Kept SMALL on purpose: every pooled light costs a full per-fragment
    // evaluation on every lit pixel even while parked at intensity 0.
    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 6, 2);
      l.position.set(0, -50, 0);
      l.userData.free = true;
      this.scene.add(l);
      this.lightPool.push(l);
    }

    this.muzzle = new THREE.PointLight(0xffb040, 0, 8, 2);
    this.muzzle.position.set(0, 1.2, 0);
    this.scene.add(this.muzzle);

    this.buildArena();
    this.initFog();

    // post chain: render (world only) → GTAO at half res (contact shadows in
    // every seam — world geometry only) → FX overlay (sprites drawn after the
    // AO composite, depth-tested against the world) → bloom → output.
    const w0 = Math.max(window.innerWidth, 640);
    const h0 = Math.max(window.innerHeight, 360);
    // 2x MSAA: the composer ping-pongs this target through every pass, so 4x
    // HalfFloat was pure bandwidth; 2x keeps edges acceptable at half the cost
    const rt = new THREE.WebGLRenderTarget(w0, h0, { samples: 2, type: THREE.HalfFloatType });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = new HalfResGTAOPass(this.scene, this.camera, w0, h0);
    this.gtao.blendIntensity = 0.9;
    this.composer.addPass(this.gtao);
    this.composer.addPass(new FxOverlayPass(this.scene, this.camera));
    const bloom = new HalfResBloomPass(new THREE.Vector2(w0, h0), 0.4, 0.55, 0.82);
    this.composer.addPass(bloom);
    this.composer.addPass(new OutputPass());
    this.tagLightsForFx();

    window.addEventListener('resize', () => {
      const w = Math.max(window.innerWidth, 640);
      const h = Math.max(window.innerHeight, 360);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this.composer.setSize(w, h);
    });
  }

  private buildArena() {
    const g = new THREE.Group();

    // shared texture library — floors, walls, and props all draw from it
    const lib = getTexLib();
    this.floorSets = { deck: lib.deck, tile: lib.tile, ground: lib.ground };
    this.wallSets = { panel: lib.panel, rock: lib.rock };

    const deck = this.floorSets.deck;
    this.floorMat = new THREE.MeshStandardMaterial({
      map: deck.map,
      roughnessMap: deck.roughnessMap,
      normalMap: deck.normalMap,
      aoMap: deck.aoMap,
      normalScale: new THREE.Vector2(0.4, 0.4),
      color: 0x777a80, // darken the albedo — worn steel, not clean tile
      roughness: 1,
      metalness: 0.45,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_W, ARENA_D), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    g.add(floor);

    const wallTex = this.wallSets.panel;
    const wallMat = new THREE.MeshStandardMaterial({
      map: wallTex.map,
      roughnessMap: wallTex.roughnessMap,
      normalMap: wallTex.normalMap,
      aoMap: wallTex.aoMap,
      normalScale: new THREE.Vector2(0.5, 0.5),
      color: 0x6e7076,
      roughness: 1,
      metalness: 0.5,
    });
    this.wallMat = wallMat;

    // dusty ground skirt for outdoor rooms — the world doesn't end at the
    // arena edge. Texture clones with repeat/offset chosen so the pattern is
    // PHASE-ALIGNED with the 24×30 floor (same texel density, matching phase
    // at the shared origin): ground floor repeat (3.2, 4.0) on 24×30 ⇒
    // skirt 72×84 needs (9.6, 11.2) with offset (0.8, 0.4).
    const gt = this.floorSets.ground;
    const skirtMaps = [gt.map.clone(), gt.roughnessMap.clone(), gt.normalMap.clone()];
    for (const t of skirtMaps) {
      t.repeat.set(9.6, 11.2);
      t.offset.set(0.8, 0.4);
      t.needsUpdate = true;
    }
    this.skirtMat = new THREE.MeshStandardMaterial({
      map: skirtMaps[0],
      roughnessMap: skirtMaps[1],
      normalMap: skirtMaps[2],
      color: 0x5c5044,
      roughness: 1,
      metalness: 0.05,
    });

    this.scene.add(g);
  }

  // ------------------------------------------------------------- room shell
  /**
   * Perimeter + door, themed per zone. Interiors get bulkhead walls; outdoor
   * rooms get open horizons bounded by rocks and dead trees, with the ship's
   * hull (and its airlock) as the far wall when the descent enters it.
   */
  private buildShell(zone: ReturnType<typeof zoneForRoom>, rng: Rng) {
    if (this.shellGroup) this.scene.remove(this.shellGroup);
    const g = new THREE.Group();
    this.shellGroup = g;
    this.scene.add(g);
    this.cornerLights = [];

    const t = 0.8;
    const doorW = 3.2;
    const HD = ARENA_D / 2;
    const HW = ARENA_W / 2;

    if (zone.outdoor) {
      // -------- open world: no artificial walls --------
      // out-of-bounds terrain matches the room exactly — no artificial darkening
      this.skirtMat.color.setHex(zone.floorTint);
      const skirt = new THREE.Mesh(Stage.skirtGeo, this.skirtMat);
      skirt.rotation.x = -Math.PI / 2;
      skirt.position.y = -0.02;
      skirt.receiveShadow = true;
      g.add(skirt);

      const rockMat = texturedStd('rock', 0x8f8d88, 0.95, 0.05, 1.2);
      const placeRock = (x: number, z: number, s: number) => {
        const rk = new THREE.Mesh(rockGeo(rng.int(0, 5)), rockMat);
        rk.scale.set(s * rng.range(0.8, 1.3), s * rng.range(0.6, 1.0), s * rng.range(0.8, 1.3));
        rk.position.set(x, s * 0.3, z);
        rk.rotation.set(rng.next() * 3, rng.next() * 3, rng.next() * 3);
        rk.castShadow = true;
        rk.receiveShadow = true;
        g.add(rk);
      };
      const placeTree = (x: number, z: number) => {
        const wood = texturedStd('rock', 0x2b2018, 0.95, 0, 2.5);
        const h = rng.range(2.6, 4.2);
        const trunk = new THREE.Mesh(cylGeo(0.07, 0.18, h, 7), wood);
        trunk.position.set(x, h / 2, z);
        trunk.rotation.z = rng.range(-0.15, 0.15);
        trunk.castShadow = true;
        g.add(trunk);
        for (let b = 0; b < rng.int(2, 4); b++) {
          const bl = rng.range(0.7, 1.5);
          const branch = new THREE.Mesh(cylGeo(0.025, 0.05, bl, 5), wood);
          branch.position.set(x + rng.range(-0.3, 0.3), h * rng.range(0.5, 0.9), z + rng.range(-0.3, 0.3));
          branch.rotation.set(rng.range(-0.6, 0.6), rng.next() * 6.28, rng.range(0.7, 1.5));
          branch.castShadow = true;
          g.add(branch);
        }
      };
      // perimeter: rocks + the dead orchard, just outside the play bounds
      for (let i = 0; i < 22; i++) {
        const side = rng.int(0, 3);
        let x = 0;
        let z = 0;
        if (side === 0) { x = -HW - rng.range(0.8, 3.5); z = rng.range(-HD - 2, HD + 2); }
        else if (side === 1) { x = HW + rng.range(0.8, 3.5); z = rng.range(-HD - 2, HD + 2); }
        else if (side === 2) { z = HD + rng.range(0.9, 3.5); x = rng.range(-HW - 2, HW + 2); }
        else { z = -HD - rng.range(0.9, 3); x = rng.range(-HW - 2, HW + 2); if (Math.abs(x) < 3.4) continue; }
        placeRock(x, z, rng.range(0.7, 2.0));
      }
      for (let i = 0; i < 8; i++) {
        const side = rng.chance(0.5) ? -1 : 1;
        placeTree(side * (HW + rng.range(1.2, 4)), rng.range(-HD, HD));
      }
      for (let i = 0; i < 3; i++) placeTree(rng.range(-HW, HW), HD + rng.range(1.5, 4));

      // no artificial light fixtures outdoors — the burning wrecks and the
      // ship's glow carry the scene

      if (zone.doorStyle === 'airlock') this.buildAirlockDoor(g, rng, doorW);
      else this.buildCanyonPass(g, rng, doorW);
      return;
    }

    // -------- interior: bulkhead walls --------
    // every wall gets texels locked to WORLD scale (~one tile per 3m) — a
    // 24m bulkhead must never stretch a single texture across its length
    const mkWall = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(boxGeo(w, WALL_H, d), this.wallFitMat(Math.max(w, d)));
      m.position.set(x, WALL_H / 2, z);
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
    };
    mkWall((ARENA_W - doorW) / 2 + t, t, -(doorW / 2 + (ARENA_W - doorW) / 4 + t / 2), -HD - t / 2);
    mkWall((ARENA_W - doorW) / 2 + t, t, doorW / 2 + (ARENA_W - doorW) / 4 + t / 2, -HD - t / 2);
    mkWall(ARENA_W + t * 2, t, 0, HD + t / 2);
    mkWall(t, ARENA_D + t * 2, -HW - t / 2, 0);
    mkWall(t, ARENA_D + t * 2, HW + t / 2, 0);

    // corner work lights (mid-wall pair cut — four cover the room, and every
    // extra point light taxes every lit fragment on screen). Some zones kill
    // them entirely: the control deck is lit by its screens alone.
    const corners: [number, number][] = zone.noCornerLights
      ? []
      : [
          [-HW + 1.2, -HD + 1.2], [HW - 1.2, -HD + 1.2],
          [-HW + 1.2, HD - 1.2], [HW - 1.2, HD - 1.2],
        ];
    for (let i = 0; i < corners.length; i++) {
      const [x, z] = corners[i];
      // interiors run brighter: the work lights actually work
      const light = new THREE.PointLight(0xff7b1c, 25, 13, 1.7);
      light.position.set(x, 2.4, z);
      g.add(light);
      const post = new THREE.Mesh(boxGeo(0.18, 2.4, 0.18), new THREE.MeshStandardMaterial({ color: 0x1a1b1f, roughness: 0.8, metalness: 0.6 }));
      post.position.set(x, 1.2, z);
      post.castShadow = true;
      g.add(post);
      const lampMat = new THREE.MeshBasicMaterial({ color: 0xffa04a });
      const lamp = new THREE.Mesh(boxGeo(0.3, 0.22, 0.3), lampMat);
      lamp.position.set(x, 2.45, z);
      g.add(lamp);
      this.cornerLights.push({ light, lamp: lampMat, base: 25, phase: i * 1.7 });
    }

    switch (zone.doorStyle) {
      case 'blast': this.buildBlastDoor(g, doorW); break;
      case 'containment': this.buildContainmentDoor(g, doorW); break;
      case 'crew': this.buildCrewDoor(g, doorW); break;
      default: this.buildBulkheadDoor(g, doorW); break;
    }
  }

  /** wall material clone with tiling fit to the wall's world length */
  private wallFitMat(length: number): THREE.MeshStandardMaterial {
    const m = this.wallMat.clone();
    const rx = Math.max(1, Math.round(length / 3));
    for (const key of ['map', 'roughnessMap', 'normalMap', 'aoMap'] as const) {
      const src = this.wallMat[key];
      if (src) {
        const c = src.clone();
        c.repeat.set(rx, 1);
        c.needsUpdate = true;
        m[key] = c;
      }
    }
    return m;
  }

  /** shared slab + glow wiring every door style needs */
  private doorCore(g: THREE.Group, doorW: number, slabMat: THREE.MeshStandardMaterial, slabH = WALL_H, slabD = 0.8) {
    this.doorFrameMat = slabMat;
    this.doorSlab = new THREE.Mesh(boxGeo(doorW, slabH, slabD), slabMat);
    this.doorSlab.position.set(0, slabH / 2, -ARENA_D / 2 - 0.4);
    this.doorSlab.castShadow = true;
    g.add(this.doorSlab);
    this.doorGlow = new THREE.PointLight(0x66ff88, 0, 8, 2);
    this.doorGlow.position.set(0, 1.6, -ARENA_D / 2 + 0.6);
    g.add(this.doorGlow);
    this.doorLampMat = new THREE.MeshBasicMaterial({ color: 0x5a1410 });
  }

  private buildBulkheadDoor(g: THREE.Group, doorW: number) {
    const HD = ARENA_D / 2;
    this.doorCore(g, doorW, new THREE.MeshStandardMaterial({ color: 0x2c2f36, roughness: 0.55, metalness: 0.7 }));
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x383b42, roughness: 0.5, metalness: 0.75 });
    const hazardMat = new THREE.MeshStandardMaterial({ color: 0x9a7a1e, roughness: 0.6, metalness: 0.4 });
    for (const sx of [-1, 1]) {
      const col = new THREE.Mesh(boxGeo(0.5, WALL_H + 0.5, 1.1), frameMat);
      col.position.set(sx * (doorW / 2 + 0.25), (WALL_H + 0.5) / 2, -HD - 0.4);
      col.castShadow = true;
      g.add(col);
      const stripe = new THREE.Mesh(boxGeo(0.52, 0.3, 1.12), hazardMat);
      stripe.position.set(sx * (doorW / 2 + 0.25), 0.6, -HD - 0.4);
      g.add(stripe);
    }
    // lintel is a hair deeper than the columns it crosses — coplanar overlap
    // between the two was the door z-fighting
    const lintel = new THREE.Mesh(boxGeo(doorW + 1.5, 0.45, 1.16), frameMat);
    lintel.position.set(0, WALL_H + 0.28, -HD - 0.4);
    lintel.castShadow = true;
    g.add(lintel);
    const doorLamp = new THREE.Mesh(boxGeo(0.5, 0.16, 0.16), this.doorLampMat);
    doorLamp.position.set(0, WALL_H + 0.28, -HD + 0.05);
    g.add(doorLamp);
  }

  /** heavy freight blast door — cargo bays, fire control, the foundry */
  private buildBlastDoor(g: THREE.Group, doorW: number) {
    const HD = ARENA_D / 2;
    const slabMat = new THREE.MeshStandardMaterial({ color: 0x3a352a, roughness: 0.5, metalness: 0.75 });
    this.doorCore(g, doorW, slabMat, WALL_H + 0.6, 1.0);
    const hazard = new THREE.MeshStandardMaterial({ color: 0x9a7a1e, roughness: 0.6, metalness: 0.4 });
    // horizontal armor ribs on the slab
    for (const ry of [0.5, 1.2, 1.9]) {
      const rib = new THREE.Mesh(boxGeo(doorW + 0.1, 0.18, 1.06), slabMat);
      rib.position.set(0, ry, -HD - 0.4);
      g.add(rib);
    }
    // wide chevron lintel + piston towers
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2e3138, roughness: 0.5, metalness: 0.8 });
    for (const sx of [-1, 1]) {
      const tower = new THREE.Mesh(boxGeo(0.9, WALL_H + 1.4, 1.3), frameMat);
      tower.position.set(sx * (doorW / 2 + 0.5), (WALL_H + 1.4) / 2, -HD - 0.4);
      tower.castShadow = true;
      g.add(tower);
      const piston = new THREE.Mesh(cylGeo(0.09, 0.09, 1.1, 8), new THREE.MeshStandardMaterial({ color: 0x55595f, roughness: 0.35, metalness: 0.9 }));
      piston.position.set(sx * (doorW / 2 + 0.5), WALL_H + 1.0, -HD + 0.2);
      piston.rotation.x = 0.9;
      g.add(piston);
    }
    // deeper than the piston towers it crosses — kills the z-fight
    const lintel = new THREE.Mesh(boxGeo(doorW + 2.2, 0.6, 1.36), hazard);
    lintel.position.set(0, WALL_H + 0.9, -HD - 0.4);
    lintel.castShadow = true;
    g.add(lintel);
    const doorLamp = new THREE.Mesh(boxGeo(0.7, 0.18, 0.18), this.doorLampMat);
    doorLamp.position.set(0, WALL_H + 0.9, -HD + 0.28);
    g.add(doorLamp);
  }

  /** sealed containment lock — coolant ducts, the reactor */
  private buildContainmentDoor(g: THREE.Group, doorW: number) {
    const HD = ARENA_D / 2;
    const slabMat = new THREE.MeshStandardMaterial({ color: 0x2e3a34, roughness: 0.45, metalness: 0.8 });
    this.doorCore(g, doorW, slabMat);
    // porthole in the slab
    const port = new THREE.Mesh(cylGeo(0.32, 0.32, 0.85, 14), new THREE.MeshBasicMaterial({ color: 0x184a2a }));
    port.rotation.x = Math.PI / 2;
    port.position.set(0, 1.25, -HD - 0.4);
    this.doorSlab.add(port);
    port.position.set(0, 1.25 - WALL_H / 2, 0);
    // rounded pylons + warning ring lamps
    const pylonMat = new THREE.MeshStandardMaterial({ color: 0x3a443e, roughness: 0.5, metalness: 0.75 });
    for (const sx of [-1, 1]) {
      const py = new THREE.Mesh(cylGeo(0.42, 0.5, WALL_H + 0.8, 10), pylonMat);
      py.position.set(sx * (doorW / 2 + 0.4), (WALL_H + 0.8) / 2, -HD - 0.4);
      py.castShadow = true;
      g.add(py);
      const ring = new THREE.Mesh(torusGeo(0.44, 0.05, 6, 14), new THREE.MeshBasicMaterial({ color: 0x5adc9a }));
      ring.rotation.x = Math.PI / 2;
      ring.position.set(sx * (doorW / 2 + 0.4), WALL_H + 0.5, -HD - 0.4);
      g.add(ring);
    }
    const lintel = new THREE.Mesh(boxGeo(doorW + 1.8, 0.4, 1.0), pylonMat);
    lintel.position.set(0, WALL_H + 0.4, -HD - 0.4);
    g.add(lintel);
    const doorLamp = new THREE.Mesh(boxGeo(0.5, 0.16, 0.16), this.doorLampMat);
    doorLamp.position.set(0, WALL_H + 0.4, -HD + 0.05);
    g.add(doorLamp);
  }

  /** plain crew hatch — quarters, mess, hydroponics */
  private buildCrewDoor(g: THREE.Group, doorW: number) {
    const HD = ARENA_D / 2;
    const slabMat = new THREE.MeshStandardMaterial({ color: 0x4a4640, roughness: 0.6, metalness: 0.5 });
    this.doorCore(g, doorW, slabMat);
    // window slit + handle wheel
    const slit = new THREE.Mesh(boxGeo(0.8, 0.18, 0.86), new THREE.MeshBasicMaterial({ color: 0x2a2416 }));
    slit.position.set(0, 1.45 - WALL_H / 2, 0);
    this.doorSlab.add(slit);
    const wheel = new THREE.Mesh(torusGeo(0.22, 0.045, 6, 12), new THREE.MeshStandardMaterial({ color: 0x6a3025, roughness: 0.5, metalness: 0.7 }));
    wheel.position.set(0, 0.95 - WALL_H / 2, 0.46);
    this.doorSlab.add(wheel);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x54504a, roughness: 0.6, metalness: 0.55 });
    for (const sx of [-1, 1]) {
      const col = new THREE.Mesh(boxGeo(0.35, WALL_H + 0.3, 1.0), frameMat);
      col.position.set(sx * (doorW / 2 + 0.18), (WALL_H + 0.3) / 2, -HD - 0.4);
      g.add(col);
    }
    const lintel = new THREE.Mesh(boxGeo(doorW + 1.0, 0.35, 1.06), frameMat);
    lintel.position.set(0, WALL_H + 0.15, -HD - 0.4);
    g.add(lintel);
    // a small home-made sign lamp, still warm
    const doorLamp = new THREE.Mesh(boxGeo(0.34, 0.14, 0.14), this.doorLampMat);
    doorLamp.position.set(0, WALL_H + 0.15, -HD + 0.02);
    g.add(doorLamp);
  }

  /** the ship's hull with its airlock — the entry the whole surface walk leads to */
  private buildAirlockDoor(g: THREE.Group, rng: Rng, doorW: number) {
    const HD = ARENA_D / 2;
    const hullMat = texturedStd('panel', 0x5c5348, 0.55, 0.7, 3, 2.2);
    // the hull towers over the north edge — plates, ribs, scorch
    for (const [w, h, x, tilt] of [
      [9.5, 6.5, -7.4, 0.06], [9.5, 7.5, 7.4, -0.05], [5, 5.6, -2.2, 0.02], [5, 6.2, 2.2, -0.03],
    ] as [number, number, number, number][]) {
      if (Math.abs(x) < doorW / 2 + 1 && h < 6) continue;
      const plate = new THREE.Mesh(boxGeo(w, h, 1.2), hullMat);
      plate.position.set(x, h / 2 - 0.3, -HD - 0.7);
      plate.rotation.z = tilt;
      plate.castShadow = true;
      plate.receiveShadow = true;
      g.add(plate);
    }
    // ribs
    for (let i = 0; i < 5; i++) {
      const rx = -10 + i * 5 + rng.range(-0.5, 0.5);
      if (Math.abs(rx) < doorW / 2 + 0.8) continue;
      const rib = new THREE.Mesh(boxGeo(0.5, 7.5, 1.5), hullMat);
      rib.position.set(rx, 3.3, -HD - 0.6);
      rib.castShadow = true;
      g.add(rib);
    }
    // the airlock: recessed frame, heavy hatch, orange guide strips
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a352c, roughness: 0.45, metalness: 0.8 });
    this.doorCore(g, doorW, new THREE.MeshStandardMaterial({ color: 0x33302a, roughness: 0.5, metalness: 0.75 }), WALL_H + 0.8, 1.0);
    for (const sx of [-1, 1]) {
      const jamb = new THREE.Mesh(boxGeo(0.7, WALL_H + 1.6, 1.4), frameMat);
      jamb.position.set(sx * (doorW / 2 + 0.4), (WALL_H + 1.6) / 2, -HD - 0.5);
      jamb.castShadow = true;
      g.add(jamb);
      const strip = new THREE.Mesh(boxGeo(0.12, WALL_H + 1.2, 0.1), new THREE.MeshBasicMaterial({ color: 0xff8a3a }));
      strip.position.set(sx * (doorW / 2 + 0.12), (WALL_H + 1.2) / 2, -HD + 0.12);
      g.add(strip);
      this.pulseLights.push({ light: (() => { const l = new THREE.PointLight(0xff8a3a, 22, 10, 1.8); l.position.set(sx * (doorW / 2 + 0.6), 1.8, -HD + 1.2); g.add(l); return l; })(), base: 22, amp: 5, speed: 1.1, phase: sx });
    }
    const lintel = new THREE.Mesh(boxGeo(doorW + 2.4, 0.7, 1.5), frameMat);
    lintel.position.set(0, WALL_H + 1.15, -HD - 0.5);
    lintel.castShadow = true;
    g.add(lintel);
    const doorLamp = new THREE.Mesh(boxGeo(0.6, 0.18, 0.18), this.doorLampMat);
    doorLamp.position.set(0, WALL_H + 1.15, -HD + 0.3);
    g.add(doorLamp);
  }

  /** a canyon pass blocked by wreck debris — surface-to-surface transitions */
  private buildCanyonPass(g: THREE.Group, rng: Rng, doorW: number) {
    const HD = ARENA_D / 2;
    const rockMat = texturedStd('rock', 0x8a8680, 0.95, 0.05, 1.2);
    // outcrops flanking the pass — pushed apart so the gap reads WIDE
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const s = rng.range(1.6, 3.2) - i * 0.3;
        const rk = new THREE.Mesh(rockGeo(rng.int(0, 5)), rockMat);
        rk.scale.set(s, s * rng.range(0.8, 1.3), s);
        rk.position.set(sx * (doorW / 2 + 2.1 + i * 2.2), s * 0.45, -HD - rng.range(0.4, 1.4));
        rk.rotation.set(rng.next() * 3, rng.next() * 3, rng.next() * 3);
        rk.castShadow = true;
        rk.receiveShadow = true;
        g.add(rk);
      }
    }
    // the gate: a slab of fallen hull wedged across the (wider) gap
    const wreck = new THREE.MeshStandardMaterial({ color: 0x453d35, roughness: 0.6, metalness: 0.65 });
    this.doorCore(g, doorW + 1.6, wreck, WALL_H + 0.7, 0.5);
    this.doorSlab.rotation.z = 0.07;
    // salvage beacon bolted to it + fires burning at the outcrops' feet
    const doorLamp = new THREE.Mesh(boxGeo(0.3, 0.16, 0.16), this.doorLampMat);
    doorLamp.position.set(0.6, WALL_H - 0.4 - WALL_H / 2, 0.3);
    this.doorSlab.add(doorLamp);
    for (const sx of [-1, 1]) {
      const fl = new THREE.PointLight(0xff6a1c, 16, 9, 1.8);
      fl.position.set(sx * (doorW / 2 + 1.6), 1.0, -HD + 0.8);
      g.add(fl);
      this.pulseLights.push({ light: fl, base: 16, amp: 5, speed: 5.5, phase: sx * 2 });
      this.vents.push({ pos: new THREE.Vector3(sx * (doorW / 2 + 1.6), 0.2, -HD + 0.4), kind: 'fire', rate: 5 });
    }
  }

  /**
   * Build the room for a given descent depth. The zone system (zones.ts) owns
   * what each room *is* — surfaces, palette, set dressing, animated lights,
   * ambient vents. Deliberate design, not random clutter.
   */
  buildRoom(rng: Rng, opts: { boss: boolean; elite: boolean; room: number }): RoomBuild {
    if (this.roomGroup) {
      // geometries are cached (geocache.ts), programs are shared — no disposal,
      // no re-upload hitch at the next door
      this.scene.remove(this.roomGroup);
    }
    this.roomGroup = new THREE.Group();
    this.scene.add(this.roomGroup);
    this.blinks = [];
    this.pulseLights = [];
    this.spins = [];
    this.sways = [];
    this.pistons = [];
    this.vents = [];

    const zone = zoneForRoom(opts.room);

    // surfaces
    const fset = this.floorSets[zone.floorTex];
    this.floorMat.map = fset.map;
    this.floorMat.roughnessMap = fset.roughnessMap;
    this.floorMat.normalMap = fset.normalMap;
    // texel density stays square on the 24×30 floor. Ground tiles at half
    // the old tile size — twice the texel density, no more blur (the noise
    // fields tile seamlessly now, so the repetition doesn't show).
    const repX = zone.floorTex === 'ground' ? 3.2 : 2.8;
    const repY = zone.floorTex === 'ground' ? 4.0 : 3.5;
    for (const t of [fset.map, fset.roughnessMap, fset.normalMap, fset.aoMap, fset.emissiveMap]) {
      if (t) t.repeat.set(repX, repY);
    }
    this.floorMat.aoMap = fset.aoMap ?? null;
    this.floorMat.color.setHex(zone.floorTint);
    this.floorMat.metalness = zone.floorTex === 'ground' ? 0.05 : 0.45;
    // per-zone floor finish: 1 = dead matte, lower = worn metal / waxed tile
    // (the roughness map still varies it per-texel — scratches shine first)
    this.floorMat.roughness = zone.floorGloss ?? 1;
    this.floorMat.envMapIntensity = (zone.floorGloss ?? 1) < 1 ? 1.7 : 1;
    // scorched ground glows through its cracks — the mask is distilled from
    // the pack's own color map, so plain white lets its hues through
    if (fset.emissiveMap) {
      this.floorMat.emissiveMap = fset.emissiveMap;
      this.floorMat.emissive.setHex(0xffffff);
      this.floorMat.emissiveIntensity = 1.04; // +15%
    } else {
      this.floorMat.emissiveMap = null;
      this.floorMat.emissive.setHex(0x000000);
      this.floorMat.emissiveIntensity = 0;
    }
    this.floorMat.needsUpdate = true;
    this.zoneFloorTint = zone.floorTint;

    this.seedFog(rng, zone.fogSheets ?? (zone.floorTex === 'ground' ? 1.5 : 1));

    const wset = this.wallSets[zone.wallTex];
    this.wallMat.map = wset.map;
    this.wallMat.roughnessMap = wset.roughnessMap;
    this.wallMat.normalMap = wset.normalMap;
    this.wallMat.aoMap = wset.aoMap ?? null;
    this.wallMat.color.setHex(zone.wallTint);
    this.wallMat.metalness = zone.wallTex === 'rock' ? 0.05 : 0.5;
    this.wallMat.needsUpdate = true;

    // perimeter + themed door (open horizon outdoors, bulkheads indoors)
    this.buildShell(zone, rng);

    // palette
    for (const c of this.cornerLights) {
      c.light.color.setHex(zone.accent);
      c.lamp.color.setHex(zone.lamp);
    }
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.setHex(zone.fog);
    fog.density = zone.fogDensity;

    // set dressing
    const fx: FxReg = {
      blink: (mat, on, off, speed, phase = 0) =>
        this.blinks.push({ mat, on: new THREE.Color(on), off: new THREE.Color(off), speed, phase }),
      pulseLight: (light, base, amp, speed, phase = 0) =>
        this.pulseLights.push({ light, base, amp, speed, phase }),
      spin: (o, axis, speed) => this.spins.push({ o, axis, speed }),
      sway: (o, amp, speed) => this.sways.push({ o, amp, speed }),
      piston: (o, amp, speed, phase = 0) =>
        this.pistons.push({ o, baseY: o.position.y, amp, speed, phase }),
    };
    const build = zone.decorate(this.roomGroup, rng, fx);
    this.vents.push(...build.vents); // shell may have contributed vents already

    this.releaseAllLights();
    this.tagLightsForFx(); // new shell/zone lights must shine on the FX pass too
    // bake the static shadow map exactly once for this room's geometry
    this.key.shadow.needsUpdate = true;

    // elite rooms get a hunting strobe regardless of zone
    if (opts.elite) {
      const strobe = new THREE.PointLight(0xff2a1a, 0, 14, 1.8);
      strobe.position.set(0, 3, 0);
      this.roomGroup.add(strobe);
      this.pulseLights.push({ light: strobe, base: 6, amp: 6, speed: 2.6, phase: 0 });
    }

    return build;
  }


  /**
   * ground-hugging fog billboards on a lit material — point lights push glow
   * into the haze, which is as volumetric as we need to feel volumetric.
   */
  private initFog() {
    // the pack's smoke sprite, linearly upscaled — soft organic haze sheet
    const mat = new THREE.MeshLambertMaterial({
      map: spriteTex('big_smoke_7'),
      transparent: true,
      opacity: 0.2, // more presence — safe now that AO can't touch the sheets
      depthWrite: false,
      color: 0xaab0bc,
      fog: false,
      // ADDITIVE: haze can only brighten — it glows where light hits it and
      // vanishes in darkness. A normal-blended lit quad renders darker than
      // the lit floor behind it, which was the "dark smudge" artifact.
      blending: THREE.AdditiveBlending,
    });
    // 22 sheets, not 36 — the fog layer was the single worst overdraw source
    this.fogMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, 22);
    this.fogMesh.layers.set(FX_LAYER);
    this.fogMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.fogMesh.frustumCulled = false;
    this.fogMesh.renderOrder = 5;
    this.scene.add(this.fogMesh);
  }

  private seedFog(rng: Rng, density: number) {
    this.fogData = [];
    const n = Math.min(22, Math.round(16 * density));
    for (let i = 0; i < n; i++) {
      this.fogData.push({
        x: rng.range(-11, 11),
        z: rng.range(-ARENA_D / 2 + 1, ARENA_D / 2 - 1),
        y: rng.range(0.4, 1.5),
        s: rng.range(3.6, 7.4),
        phase: rng.range(0, Math.PI * 2),
      });
    }
  }

  setDoorOpen(open: boolean) {
    if (!this.doorSlab) return; // shell not built yet (first loadRoom)
    this.doorSlab.visible = !open;
    this.doorGlow.intensity = open ? 14 : 0;
    this.doorFrameMat.emissive.setHex(open ? 0x1a4a26 : 0x000000);
    this.doorLampMat.color.setHex(open ? 0x38e05a : 0x5a1410);
  }


  setScorched(on: boolean) {
    this.floorMat.color.setHex(on ? 0x35302a : this.zoneFloorTint);
  }

  addShake(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** live GTAO tuning (F4 dev panel): blend intensity + material params */
  setGtao(p: { intensity?: number; radius?: number; thickness?: number; scale?: number }) {
    if (p.intensity !== undefined) this.gtao.blendIntensity = p.intensity;
    const mat: Record<string, number> = {};
    if (p.radius !== undefined) mat.radius = p.radius;
    if (p.thickness !== undefined) mat.thickness = p.thickness;
    if (p.scale !== undefined) mat.scale = p.scale;
    if (Object.keys(mat).length > 0) this.gtao.updateGtaoMaterial(mat);
  }

  /** the FX overlay renders with the camera on FX_LAYER only — every light
   * must be enabled there too, so the lit haze still catches the practicals */
  private tagLightsForFx() {
    this.scene.traverse((o) => {
      if ((o as THREE.Light).isLight) o.layers.enable(FX_LAYER);
    });
  }

  /** brief warm flash at the player's weapon — every shot has a light source */
  muzzleFlash(x: number, z: number) {
    this.muzzle.position.set(x, 1.1, z);
    this.muzzleT = 0.06;
  }

  /** borrow a pooled light (returns null when the pool is dry — degrade gracefully) */
  lendLight(color: number, intensity: number, range: number): THREE.PointLight | null {
    for (const l of this.lightPool) {
      if (l.userData.free) {
        l.userData.free = false;
        l.color.setHex(color);
        l.intensity = intensity;
        l.distance = range;
        return l;
      }
    }
    return null;
  }

  releaseLight(l: THREE.PointLight | null) {
    if (!l) return;
    l.intensity = 0;
    l.position.set(0, -50, 0);
    l.userData.free = true;
  }

  releaseAllLights() {
    for (const l of this.lightPool) this.releaseLight(l);
  }

  setMood(color: number, ambScale: number, dur: number) {
    this.mood = { color: new THREE.Color(color), amb: ambScale, t: dur };
  }

  zap(from: THREE.Vector3, to: THREE.Vector3, color: number) {
    const pts: THREE.Vector3[] = [];
    const segs = 7;
    for (let i = 0; i <= segs; i++) {
      const p = from.clone().lerp(to, i / segs);
      if (i > 0 && i < segs) {
        p.x += (Math.random() - 0.5) * 0.7;
        p.y += Math.random() * 0.5;
        p.z += (Math.random() - 0.5) * 0.7;
      }
      pts.push(p);
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1 });
    const line = new THREE.Line(geo, mat);
    line.layers.set(FX_LAYER);
    this.scene.add(line);
    this.zaps.push({ line, t: 0.13 });
  }

  private static ringGeo = new THREE.RingGeometry(0.9, 1, 48);
  private static skirtGeo = new THREE.PlaneGeometry(72, 84);

  ring(pos: THREE.Vector3, maxR: number, color: number, dur: number, track?: THREE.Vector3) {
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
    });
    const mesh = new THREE.Mesh(Stage.ringGeo, mat);
    mesh.layers.set(FX_LAYER); // draws after AO and decals — never buried in blood
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(pos.x, 0.06, pos.z);
    this.scene.add(mesh);
    this.rings.push({ mesh, t: 0, dur, maxR, mat, track });
  }

  update(dt: number, playerX: number, playerZ = 0) {
    const now = performance.now() / 1000;
    for (const c of this.cornerLights) {
      const flick = Math.sin(now * 13 + c.phase) * Math.sin(now * 7.3 + c.phase * 2);
      c.light.intensity = c.base * (0.8 + 0.2 * flick) * (Math.random() > 0.995 ? 0.25 : 1);
    }
    // zone set dressing: blinking indicators, pulsing lights, machinery motion
    for (const b of this.blinks) {
      const s = Math.sin(now * b.speed * Math.PI * 2 + b.phase);
      if (b.speed < 1) {
        // slow entries breathe instead of switching
        b.mat.color.copy(b.off).lerp(b.on, 0.5 + 0.5 * s);
      } else {
        b.mat.color.copy(s > -0.2 ? b.on : b.off);
      }
    }
    for (const pl of this.pulseLights) {
      pl.light.intensity = Math.max(0, pl.base + Math.sin(now * pl.speed + pl.phase) * pl.amp);
    }
    for (const sp of this.spins) {
      sp.o.rotation[sp.axis] += sp.speed * dt;
    }
    for (const sw of this.sways) {
      sw.o.rotation.z = Math.sin(now * sw.speed) * sw.amp;
      sw.o.rotation.x = Math.sin(now * sw.speed * 0.7 + 1) * sw.amp * 0.6;
    }
    for (const pi of this.pistons) {
      pi.o.position.y = pi.baseY + Math.abs(Math.sin(now * pi.speed + pi.phase)) * pi.amp;
    }

    // ground mist: horizontal sheets drifting just above the floor — lying
    // flat means they can never intersect it and depth-clip into hard edges
    if (this.fogData.length > 0) {
      const m = new THREE.Matrix4();
      const pos = new THREE.Vector3();
      const scl = new THREE.Vector3();
      const e = new THREE.Euler();
      const q = new THREE.Quaternion();
      for (let i = 0; i < this.fogMesh.count; i++) {
        const f = this.fogData[i % this.fogData.length];
        if (i >= this.fogData.length) {
          m.compose(pos.set(0, -10, 0), q.identity(), scl.set(0, 0, 0));
        } else {
          pos.set(
            f.x + Math.sin(now * 0.06 + f.phase) * 1.6,
            0.25 + (f.y - 0.4) * 0.35 + Math.sin(now * 0.1 + f.phase * 2) * 0.06,
            f.z + Math.cos(now * 0.05 + f.phase) * 1.1,
          );
          q.setFromEuler(e.set(-Math.PI / 2, 0, f.phase + now * 0.015));
          m.compose(pos, q, scl.set(f.s * 1.3, f.s * 1.1, 1));
        }
        this.fogMesh.setMatrixAt(i, m);
      }
      this.fogMesh.instanceMatrix.needsUpdate = true;
    }

    // muzzle flash decay
    this.muzzleT = Math.max(0, this.muzzleT - dt);
    this.muzzle.intensity = this.muzzleT > 0 ? 55 : 0;

    // mood: tint ambient AND pull the key down so set pieces own the screen
    if (this.mood) {
      this.mood.t -= dt;
      this.ambient.color.copy(this.mood.color);
      this.ambient.intensity = this.mood.amb;
      this.key.intensity += (this.KEY_BASE * 0.3 - this.key.intensity) * Math.min(1, dt * 6);
      if (this.mood.t <= 0) this.mood = null;
    } else {
      this.ambient.color.lerp(this.baseAmbColor, Math.min(1, dt * 3));
      this.ambient.intensity += (this.AMB_BASE - this.ambient.intensity) * Math.min(1, dt * 3);
      this.key.intensity += (this.KEY_BASE - this.key.intensity) * Math.min(1, dt * 3);
    }

    for (let i = this.zaps.length - 1; i >= 0; i--) {
      const z = this.zaps[i];
      z.t -= dt;
      (z.line.material as THREE.LineBasicMaterial).opacity = Math.max(0, z.t / 0.13);
      if (z.t <= 0) {
        this.scene.remove(z.line);
        z.line.geometry.dispose(); // unique point data — safe, doesn't touch programs
        this.zaps.splice(i, 1);
      }
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      if (r.track) r.mesh.position.set(r.track.x, 0.06, r.track.z);
      const k = Math.min(1, r.t / r.dur);
      const scale = 0.05 + k * r.maxR;
      r.mesh.scale.set(scale, scale, 1);
      r.mat.opacity = 0.85 * (1 - k);
      if (k >= 1) {
        this.scene.remove(r.mesh);
        this.rings.splice(i, 1);
      }
    }

    // menu close-up: dolly in on the crusader, ignore the arena rig
    if (this.menuFocus) {
      tmpV.set(this.menuFocus.x + 2.2, 3.4, this.menuFocus.z + 5.8);
      this.camera.position.lerp(tmpV, Math.min(1, dt * 5));
      this.camera.lookAt(this.menuFocus.x + 1.5, 1.1, this.menuFocus.z);
      return;
    }

    // camera follows the player down the long rooms, clamped so we never look
    // past the walls — the far half stays unseen until you walk toward it.
    // Shake is LINEAR in trauma (the old quadratic curve swallowed the small
    // shot/kill rumbles entirely) and decays fast so it reads as impact.
    this.trauma = Math.max(0, this.trauma - dt * 2.6);
    const sh = this.trauma * 0.55;
    const focusTarget = THREE.MathUtils.clamp(playerZ, -ARENA_D / 2 + 5, ARENA_D / 2 - 5);
    this.camFocusZ += (focusTarget - this.camFocusZ) * Math.min(1, dt * 4.5);
    this.camera.position.set(
      this.camBase.x + playerX * 0.12 + (Math.random() - 0.5) * sh * 1.0,
      this.camBase.y + (Math.random() - 0.5) * sh * 0.8,
      this.camBase.z + this.camFocusZ + (Math.random() - 0.5) * sh * 0.6,
    );
    this.camera.lookAt(tmpV.set(playerX * 0.12, 0, this.camFocusZ - 0.6));
  }

  /** menu shows the hero against the void: drop the whole room build */
  clearRoom() {
    if (this.roomGroup) {
      this.scene.remove(this.roomGroup);
      this.roomGroup = null;
    }
    if (this.shellGroup) {
      this.scene.remove(this.shellGroup);
      this.shellGroup = null;
    }
    this.blinks = [];
    this.pulseLights = [];
    this.spins = [];
    this.sways = [];
    this.pistons = [];
    this.vents = [];
    this.fogData = [];
    this.cornerLights = [];
    this.releaseAllLights();
    this.key.shadow.needsUpdate = true;
  }

  /** world → screen-space pixels (for DOM targeting overlays) */
  toScreen(x: number, y: number, z: number): { x: number; y: number } {
    tmpV.set(x, y, z).project(this.camera);
    return {
      x: (tmpV.x * 0.5 + 0.5) * window.innerWidth,
      y: (-tmpV.y * 0.5 + 0.5) * window.innerHeight,
    };
  }

  /** snap the follow camera to the player (room transitions) */
  snapCamera(playerZ: number) {
    this.camFocusZ = THREE.MathUtils.clamp(playerZ, -ARENA_D / 2 + 5, ARENA_D / 2 - 5);
  }

  render() {
    this.composer.render();
  }
}

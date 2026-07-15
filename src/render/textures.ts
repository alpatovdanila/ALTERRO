import * as THREE from 'three';

// Real PBR material sets loaded from the licensed pack in public/pbr — the
// old canvas-synthesized textures are gone entirely. Each set ships
// color / normal_gl / roughness / ambient_occlusion at 1k.
//
// The ground (lava_rocks_01) has no emissive map, so we DERIVE one from the
// pack's own color map: hot orange pixels become the ember mask. Their
// pixels, their glow — nothing hand-drawn.

export interface TexSet {
  map: THREE.Texture;
  roughnessMap: THREE.Texture;
  normalMap: THREE.Texture;
  aoMap?: THREE.Texture;
  /** ember-glow etc. — only some surfaces have one */
  emissiveMap?: THREE.Texture;
}

const manager = new THREE.LoadingManager();
const loader = new THREE.TextureLoader(manager);

let resolveReady: (() => void) | null = null;
let settled = false;
/** resolves once every queued texture finished loading (boot awaits this) */
export const texturesReady = new Promise<void>((r) => {
  resolveReady = r;
});
manager.onLoad = () => {
  if (!settled) {
    settled = true;
    resolveReady?.();
  }
};
manager.onError = (url) => console.error('texture failed:', url);

function tex(path: string, srgb = false, onLoad?: (t: THREE.Texture) => void): THREE.Texture {
  const t = loader.load(path, onLoad);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 2;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * ember mask distilled from the lava set's own color map: everything that
 * isn't glowing-hot goes black, the molten veins stay.
 */
function deriveEmissive(from: string): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4; // placeholder until the color map arrives
  const out = new THREE.CanvasTexture(canvas);
  out.wrapS = THREE.RepeatWrapping;
  out.wrapT = THREE.RepeatWrapping;
  out.colorSpace = THREE.SRGBColorSpace;
  tex(from, false, (src) => {
    const img = src.image as HTMLImageElement;
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      // only the HOTTEST cores keep their glow — embers in the crust, not a
      // standing lava lake
      const hot = r > 208 && r > g * 1.8 && r > b * 2.6 ? Math.min(1, (r - 208) / 45) : 0;
      px[i] = r * hot;
      px[i + 1] = g * hot;
      px[i + 2] = b * hot;
    }
    ctx.putImageData(data, 0, 0);
    out.needsUpdate = true;
  });
  return out;
}

function pbrSet(name: string, opts: { emissiveFromColor?: boolean } = {}): TexSet {
  const base = `pbr/${name}/${name}_`;
  const set: TexSet = {
    map: tex(`${base}color_1k.png`, true),
    roughnessMap: tex(`${base}roughness_1k.png`),
    normalMap: tex(`${base}normal_gl_1k.png`),
    aoMap: tex(`${base}ambient_occlusion_1k.png`),
  };
  if (opts.emissiveFromColor) set.emissiveMap = deriveEmissive(`${base}color_1k.png`);
  return set;
}

// ------------------------------------------------------------ shared library
// Loaded once, used by the stage (floors/walls) AND by prop builders.
let texLib: { deck: TexSet; tile: TexSet; ground: TexSet; panel: TexSet; rock: TexSet } | null = null;

export function getTexLib() {
  if (!texLib) {
    texLib = {
      deck: pbrSet('metal_plates_01'),
      tile: pbrSet('concrete_tiles_01'),
      // smooth monotonous dirt (lowest-variance set in the pack) — busy
      // slab-stone read as noise from the fixed camera
      ground: pbrSet('ground_02'),
      panel: pbrSet('metal_01'),
      rock: pbrSet('cliff_rocks_03'),
    };
  }
  return texLib;
}

/**
 * textured standard material for props: clones the set's maps (cheap — shares
 * image data) so per-prop repeat doesn't fight the floor's.
 *
 * Memoized by every parameter: identical props (same kind/color/finish/tiling)
 * share ONE material AND one clone-set of textures. Cargo rooms alone drop from
 * ~78 texture clones to a handful. Safe — these materials are never mutated.
 */
const texturedCache = new Map<string, THREE.MeshStandardMaterial>();
export function texturedStd(
  kind: 'deck' | 'panel' | 'rock',
  color: number,
  rough: number,
  metal: number,
  repeat = 1,
  repeatY = repeat, // NEVER stretch: big non-square faces tile per-axis
): THREE.MeshStandardMaterial {
  const key = `${kind}|${color}|${rough}|${metal}|${repeat}|${repeatY}`;
  const hit = texturedCache.get(key);
  if (hit) return hit;
  const set = getTexLib()[kind];
  const map = set.map.clone();
  const roughnessMap = set.roughnessMap.clone();
  const normalMap = set.normalMap.clone();
  for (const t of [map, roughnessMap, normalMap]) {
    t.repeat.set(repeat, repeatY);
    t.needsUpdate = true;
  }
  const mat = new THREE.MeshStandardMaterial({
    map,
    roughnessMap,
    normalMap,
    normalScale: new THREE.Vector2(0.5, 0.5),
    color,
    roughness: rough,
    metalness: metal,
  });
  texturedCache.set(key, mat);
  return mat;
}

/** a pack sprite loaded as a plain texture (fog sheets, decal alpha) */
export function spriteTex(name: string, pixelArt = false): THREE.Texture {
  const t = loader.load(`particles/${name}.png`);
  t.colorSpace = THREE.SRGBColorSpace;
  if (pixelArt) {
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
  }
  return t;
}

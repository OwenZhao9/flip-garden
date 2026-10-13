// The 3D garden scene, built with Three.js from geometry in code (no image files). Loaded as its own chunk by
// garden3d-mount.ts, only when a garden panel is on the page. It only draws what the garden view already says; the plot
// cards in the DOM stay the source of truth for every word, number and button.
//
// The look: a small floating island at dusk. A grassy top with wind in the grass, a rocky underside, a lantern, a few
// glowing mushrooms, a moon, stars and two distant islets in the haze. Plants are shaped in code (curved stems, folded
// leaves, cupped petals with colour gradients) and lit by a warm key light and a purple rim light.
import {
  AdditiveBlending,
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Fog,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Points,
  Quaternion,
  Raycaster,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  VSMShadowMap,
  WebGLRenderer,
  type Material,
} from 'three';
import { cameraDistance, clamp01, easeOutBack, elevationFor, sceneParams, squashStretch, type Moment, type PlantParams, type SceneParams } from './garden3d-params.ts';
import type { GardenView } from './garden-view.ts';

export type SceneOptions = {
  still: boolean; // reduced motion: draw single frames on change, never animate
  onPick(id: string): void;
  onFail(): void;
  win: Window;
};

export type GardenScene = {
  update(view: GardenView): void;
  highlight(id: string | null): void;
  play(moments: Moment[]): void;
  setRunning(on: boolean): void; // false while the tab is hidden or the scene is off-screen
  resize(w: number, h: number): void;
  stats(): { frameMs: number; renderMs: number };
  dispose(): void;
};

// --- palette (brand tokens plus warm accents) -----------------------------------------------------------------
const C = {
  lime: 0x9be564,
  purple: 0x836ef9,
  purpleLight: 0xb3a6ff,
  lavender: 0xd9d0ff,
  cream: 0xfff1cf,
  amber: 0xffc857,
  orange: 0xff8a3d,
  mint: 0x5fe3a1,
  grassA: 0x3e8a4c,
  grassB: 0x5aac55,
  grassC: 0x7cc75c,
  grassEdge: 0x2f6a40,
  soil: 0x4a2f26,
  soilDark: 0x3f2620,
  rockTop: 0x6a4256,
  rockMid: 0x4a3270,
  rockLow: 0x2a2152,
  bark: 0x7a4f37,
  barkDark: 0x553423,
  cut: 0xe8c08a,
  cutRing: 0xc99a64,
  stem: 0x6fb64a,
  stemDark: 0x3f7f3a,
  leafBase: 0x4e9e48,
  canopyDark: 0x2c6b4a,
  canopy: 0x4fb064,
  canopyLight: 0x9be564,
  oldLeaf: 0xd0b45a,
  haze: 0x372c6b,
  cloud: 0x7466bd,
  moon: 0xfff0cc,
};

const col = (hex: number): Color => new Color(hex);

const mat = (color: number, extra: Partial<ConstructorParameters<typeof MeshStandardMaterial>[0]> = {}): MeshStandardMaterial =>
  new MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, ...extra });

// A deterministic value in 0..1 for an integer and a channel: decoration only, so every reload looks the same.
const rnd = (i: number, k = 0): number => (((Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1) + 1) % 1;

// --- geometry made in code -----------------------------------------------------------------------------------------

type LeafOpts = { len: number; width: number; fold: number; curl: number; round: number; widest: number; base: number; tip: number; segU?: number; segV?: number };

// A leaf or petal: a strip along +x, flat in xz, folded up along its midrib, curled along its length, coloured from base
// to tip. `widest` moves the widest point (below 1 towards the tip), `round` below 1 rounds the outline.
function leafGeometry(o: LeafOpts): BufferGeometry {
  const su = o.segU ?? 10;
  const sv = o.segV ?? 4;
  const pos: number[] = [];
  const colors: number[] = [];
  const idx: number[] = [];
  const a = col(o.base);
  const b = col(o.tip);
  const c = new Color();
  for (let i = 0; i <= su; i++) {
    const u = i / su;
    const half = o.width * Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(u, o.widest))), o.round);
    for (let j = 0; j <= sv; j++) {
      const v = -1 + (2 * j) / sv;
      pos.push(u * o.len, o.fold * Math.abs(v) * half + o.curl * u * u * o.len, v * half);
      c.copy(a).lerp(b, Math.pow(u, 0.8)).multiplyScalar(1 - 0.16 * (1 - Math.abs(v)) * (1 - u));
      colors.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < su; i++)
    for (let j = 0; j < sv; j++) {
      const p = i * (sv + 1) + j;
      const q = p + sv + 1;
      idx.push(p, q, p + 1, p + 1, q, q + 1);
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// A tube along a smooth curve whose radius tapers from r0 to r1, coloured from c0 to c1.
function taperTube(points: Vector3[], r0: number, r1: number, c0: number, c1: number, seg = 14, radial = 7): BufferGeometry {
  const curve = new CatmullRomCurve3(points);
  const frames = curve.computeFrenetFrames(seg, false);
  const pos: number[] = [];
  const colors: number[] = [];
  const idx: number[] = [];
  const a = col(c0);
  const b = col(c1);
  const c = new Color();
  const p = new Vector3();
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    curve.getPointAt(t, p);
    const r = r0 + (r1 - r0) * t;
    const n = frames.normals[i];
    const bn = frames.binormals[i];
    c.copy(a).lerp(b, t);
    for (let j = 0; j <= radial; j++) {
      const ang = (j / radial) * Math.PI * 2;
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);
      pos.push(p.x + r * (cs * n.x + sn * bn.x), p.y + r * (cs * n.y + sn * bn.y), p.z + r * (cs * n.z + sn * bn.z));
      colors.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < seg; i++)
    for (let j = 0; j < radial; j++) {
      const q = i * (radial + 1) + j;
      const w = q + radial + 1;
      idx.push(q, w, q + 1, q + 1, w, w + 1);
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// A soft lumpy ball (canopy, cloud): a sphere pushed in and out by a few sines, darker underneath, lighter on top.
function blobGeometry(r: number, seed: number, dark: number, light: number, lump = 0.11): BufferGeometry {
  const g = new SphereGeometry(r, 26, 18);
  const p = g.getAttribute('position') as Float32BufferAttribute;
  const colors: number[] = [];
  const a = col(dark);
  const b = col(light);
  const c = new Color();
  const n = new Vector3();
  for (let i = 0; i < p.count; i++) {
    n.set(p.getX(i), p.getY(i), p.getZ(i)).normalize();
    const d = 1 + lump * Math.sin(n.x * 4.1 + seed) * Math.sin(n.y * 3.7 + seed * 1.7) + lump * 0.6 * Math.sin(n.z * 5.3 + seed * 2.3);
    const y = n.y < -0.2 ? n.y * 0.78 : n.y;
    p.setXYZ(i, n.x * r * d, y * r * d, n.z * r * d);
    c.copy(a).lerp(b, clamp01((n.y + 0.7) / 1.6) ** 1.2);
    colors.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

// The floating island for a bed of this width and depth: a slightly domed grass top in a rounded-rectangle outline,
// and a rocky underside that narrows to a point. Returns the two parts so they get different materials.
function islandGeometry(w: number, d: number, seed = 0): { top: BufferGeometry; side: BufferGeometry; radius(theta: number): number; height: number } {
  const a = w / 2;
  const b = d / 2;
  const ex = 3.2;
  const radius = (t: number): number => Math.pow(Math.pow(Math.abs(Math.cos(t) / a), ex) + Math.pow(Math.abs(Math.sin(t) / b), ex), -1 / ex);
  const S = 72;
  const H = 1.25 + 0.3 * Math.min(w, d);

  // top: a fan of rings, vertex-coloured in grassy patches
  const tp: number[] = [0, 0.03, 0];
  const tc: number[] = [];
  const cA = col(C.grassA);
  const cB = col(C.grassB);
  const cC = col(C.grassC);
  const cE = col(C.grassEdge);
  const c = new Color();
  const grassAt = (x: number, z: number, f: number): Color => {
    const k = 0.5 + 0.5 * Math.sin(x * 2.1 + seed) * Math.cos(z * 2.6 - seed * 0.7);
    const k2 = 0.5 + 0.5 * Math.sin(x * 5.3 - z * 4.1 + seed);
    c.copy(cA).lerp(cB, k).lerp(cC, k2 * 0.35);
    return c.lerp(cE, clamp01((f - 0.82) / 0.18) * 0.6);
  };
  grassAt(0, 0, 0);
  tc.push(c.r, c.g, c.b);
  const R = 7;
  for (let k = 1; k <= R; k++) {
    const f = k / R;
    for (let s = 0; s < S; s++) {
      const t = (s / S) * Math.PI * 2;
      const r = radius(t) * f;
      const x = Math.cos(t) * r;
      const z = Math.sin(t) * r;
      tp.push(x, 0.03 * (1 - f * f) - (f > 0.93 ? (f - 0.93) * 0.6 : 0), z);
      grassAt(x, z, f);
      tc.push(c.r, c.g, c.b);
    }
  }
  const ti: number[] = [];
  for (let s = 0; s < S; s++) ti.push(0, 1 + ((s + 1) % S), 1 + s);
  for (let k = 1; k < R; k++)
    for (let s = 0; s < S; s++) {
      const p = 1 + (k - 1) * S + s;
      const q = 1 + (k - 1) * S + ((s + 1) % S);
      ti.push(p, q, p + S, q, q + S, p + S);
    }
  const top = new BufferGeometry();
  top.setAttribute('position', new Float32BufferAttribute(tp, 3));
  top.setAttribute('color', new Float32BufferAttribute(tc, 3));
  top.setIndex(ti);
  top.computeVertexNormals();

  // underside: rings down a profile (fraction of the outline radius, depth as a fraction of H)
  const prof: [number, number][] = [[1.0, -0.004], [1.0, -0.045], [0.985, -0.11], [0.93, -0.22], [0.84, -0.36], [0.72, -0.51], [0.58, -0.66], [0.42, -0.8], [0.26, -0.91], [0.11, -0.99]];
  const sp: number[] = [];
  const sc: number[] = [];
  const top0 = col(C.grassEdge);
  const soil = col(C.soil);
  const r0 = col(C.rockTop);
  const r1 = col(C.rockMid);
  const r2 = col(C.rockLow);
  prof.forEach(([fr, fy], li) => {
    for (let s = 0; s < S; s++) {
      const t = (s / S) * Math.PI * 2;
      const rock = li < 2 ? 1 : 1 + 0.09 * Math.sin(t * 7 + li * 1.3 + seed) + 0.06 * Math.sin(t * 13 - li * 2.1) + 0.04 * Math.sin(t * 23 + li);
      // deeper rings lean towards a circle, so a long bed still ends in one rounded point
      const blend = clamp01((li - 2) / 6);
      const rr = (radius(t) * (1 - blend) + Math.sqrt(a * b) * blend) * fr * rock;
      sp.push(Math.cos(t) * rr, fy * H + (li > 1 ? 0.05 * Math.sin(t * 5 + li) : 0), Math.sin(t) * rr);
      if (li === 0) c.copy(top0);
      else if (li < 3) c.copy(soil).multiplyScalar(li === 1 ? 1.05 : 0.9);
      else c.copy(r0).lerp(r1, clamp01((li - 3) / 3)).lerp(r2, clamp01((li - 6) / 3));
      c.multiplyScalar(0.9 + 0.2 * rnd(s + li * 97, 3));
      sc.push(c.r, c.g, c.b);
    }
  });
  sp.push(0, -1.08 * H, 0);
  c.copy(r2).multiplyScalar(0.8);
  sc.push(c.r, c.g, c.b);
  const si: number[] = [];
  for (let l = 0; l < prof.length - 1; l++)
    for (let s = 0; s < S; s++) {
      const p = l * S + s;
      const q = l * S + ((s + 1) % S);
      si.push(p, p + S, q, q, p + S, q + S);
    }
  const tip = prof.length * S;
  for (let s = 0; s < S; s++) si.push((prof.length - 1) * S + s, tip, (prof.length - 1) * S + ((s + 1) % S));
  const side = new BufferGeometry();
  side.setAttribute('position', new Float32BufferAttribute(sp, 3));
  side.setAttribute('color', new Float32BufferAttribute(sc, 3));
  side.setIndex(si);
  side.computeVertexNormals();
  return { top, side, radius, height: H };
}

// --- shared kit -----------------------------------------------------------------------------------------------------

// One set of geometries and materials shared by every plant, so a garden of many plots stays cheap.
function makeKit() {
  const vc = { vertexColors: true } as const;
  const mound = new SphereGeometry(0.36, 22, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  mound.scale(1, 0.3, 1);
  {
    const p = mound.getAttribute('position') as Float32BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      p.setY(i, p.getY(i) * (1 + 0.18 * Math.sin(x * 21) * Math.cos(z * 17)));
    }
    mound.computeVertexNormals();
  }
  const seed = new SphereGeometry(0.125, 18, 12);
  seed.scale(1, 0.7, 0.68);
  {
    // an almond: one end pointed
    const p = seed.getAttribute('position') as Float32BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const k = 1 - 0.35 * clamp01(x / 0.12);
      p.setY(i, p.getY(i) * k);
      p.setZ(i, p.getZ(i) * k);
    }
    seed.computeVertexNormals();
  }
  const sproutStem = taperTube([new Vector3(0, 0, 0), new Vector3(0.02, 0.2, 0.01), new Vector3(-0.01, 0.4, 0), new Vector3(0, 0.52, 0)], 0.034, 0.022, C.stemDark, C.stem);
  const flowerStem = taperTube([new Vector3(0, 0, 0), new Vector3(0.05, 0.3, 0.02), new Vector3(-0.04, 0.65, 0.0), new Vector3(0.0, 0.92, 0.04), new Vector3(0.02, 1.0, 0.07)], 0.038, 0.024, C.stemDark, C.stem);
  const trunk = taperTube([new Vector3(0, 0, 0), new Vector3(0.06, 0.3, 0), new Vector3(-0.03, 0.62, 0.02), new Vector3(0.02, 0.92, 0)], 0.13, 0.06, C.barkDark, C.bark, 12, 9);
  const branchL = taperTube([new Vector3(0, 0.55, 0), new Vector3(-0.18, 0.75, 0.03), new Vector3(-0.32, 0.92, 0.05)], 0.05, 0.025, C.barkDark, C.bark, 8, 6);
  const branchR = taperTube([new Vector3(0, 0.62, 0), new Vector3(0.2, 0.8, -0.02), new Vector3(0.34, 0.98, -0.04)], 0.045, 0.022, C.barkDark, C.bark, 8, 6);
  const stump = new CylinderGeometry(0.15, 0.2, 0.3, 14, 3).translate(0, 0.15, 0);
  {
    const p = stump.getAttribute('position') as Float32BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      const t = Math.atan2(z, x);
      const k = 1 + 0.07 * Math.sin(t * 9) + 0.04 * Math.sin(t * 17);
      if (p.getY(i) < 0.299) {
        p.setX(i, x * k);
        p.setZ(i, z * k);
      }
    }
    stump.computeVertexNormals();
  }
  const fruit = new SphereGeometry(0.1, 16, 12);
  fruit.scale(1, 0.92, 1);
  return {
    geo: {
      mound,
      seed,
      sproutStem,
      flowerStem,
      sproutLeaf: leafGeometry({ len: 0.34, width: 0.15, fold: 0.35, curl: 0.18, round: 0.75, widest: 0.8, base: C.leafBase, tip: C.lime }),
      leaf: leafGeometry({ len: 0.3, width: 0.1, fold: 0.4, curl: -0.12, round: 0.9, widest: 0.85, base: C.leafBase, tip: C.lime }),
      petal: leafGeometry({ len: 0.24, width: 0.11, fold: 0.5, curl: 0.25, round: 0.45, widest: 0.62, base: C.lavender, tip: C.purple, segU: 9, segV: 4 }),
      petalInner: leafGeometry({ len: 0.17, width: 0.08, fold: 0.6, curl: 0.35, round: 0.45, widest: 0.62, base: C.cream, tip: C.purpleLight, segU: 8, segV: 4 }),
      core: new SphereGeometry(0.075, 16, 10).scale(1, 0.62, 1),
      coreDot: new IcosahedronGeometry(0.013, 0),
      trunk,
      branchL,
      branchR,
      blobs: [blobGeometry(0.42, 1, C.canopyDark, C.canopy), blobGeometry(0.34, 2.4, C.canopyDark, C.canopyLight), blobGeometry(0.3, 4.1, C.canopyDark, C.canopy), blobGeometry(0.27, 5.7, C.canopy, C.canopyLight)],
      fruit,
      fruitLeaf: leafGeometry({ len: 0.08, width: 0.03, fold: 0.3, curl: 0.2, round: 0.9, widest: 0.8, base: C.stemDark, tip: C.lime, segU: 5, segV: 2 }),
      stump,
      cutFace: new CircleGeometry(0.15, 20).rotateX(-Math.PI / 2),
      cutRing: new RingGeometry(0.055, 0.075, 20).rotateX(-Math.PI / 2),
      cutRing2: new RingGeometry(0.105, 0.118, 20).rotateX(-Math.PI / 2),
      chip: new IcosahedronGeometry(0.03, 0).scale(1.4, 0.5, 1),
      ring: new RingGeometry(0.5, 0.56, 48).rotateX(-Math.PI / 2),
      disc: new PlaneGeometry(1.5, 1.5).rotateX(-Math.PI / 2),
      hit: new CylinderGeometry(0.72, 0.72, 1.9, 8).translate(0, 0.95, 0),
    },
    mat: {
      soil: mat(0x3d2620, { roughness: 1 }),
      seed: mat(0xc98642, { roughness: 0.32, emissive: col(C.amber), emissiveIntensity: 0.1 }),
      plant: mat(0xffffff, { ...vc, roughness: 0.7 }),
      leaf: mat(0xffffff, { ...vc, side: DoubleSide, roughness: 0.6 }),
      petal: mat(0xffffff, { ...vc, side: DoubleSide, roughness: 0.5, emissive: col(C.purple), emissiveIntensity: 0.08 }),
      core: mat(C.amber, { roughness: 0.45, emissive: col(C.amber), emissiveIntensity: 0.55 }),
      coreDot: mat(C.orange, { roughness: 0.6, flatShading: true }),
      bark: mat(0xffffff, { ...vc, roughness: 0.9 }),
      stump: mat(C.bark, { roughness: 0.95, flatShading: true }),
      canopy: mat(0xffffff, { ...vc, roughness: 0.75 }),
      fruitA: mat(C.orange, { roughness: 0.28, emissive: col(C.orange), emissiveIntensity: 0.18 }),
      fruitB: mat(C.amber, { roughness: 0.28, emissive: col(C.amber), emissiveIntensity: 0.18 }),
      cut: mat(C.cut, { roughness: 0.9 }),
      cutRing: mat(C.cutRing, { roughness: 0.9 }),
      chip: mat(C.cut, { roughness: 0.9, flatShading: true }),
      oldLeaf: mat(0xffffff, { ...vc, side: DoubleSide, transparent: true, color: col(C.oldLeaf) }),
      ring: new MeshBasicMaterial({ color: C.lime, transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending }),
      disc: new MeshBasicMaterial({ color: C.lime, transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending }),
      hit: new MeshBasicMaterial({ visible: false }),
    },
  };
}
type Kit = ReturnType<typeof makeKit>;

const shadowed = <T extends Mesh>(m: T, cast = true, receive = false): T => {
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
};

// A soft additive glow that always faces the camera.
function halo(dot: DataTexture, color: number, size: number, opacity: number): Sprite {
  const s = new Sprite(new SpriteMaterial({ map: dot, color, transparent: true, opacity, depthWrite: false, blending: AdditiveBlending }));
  s.scale.setScalar(size);
  s.userData.base = opacity;
  return s;
}

// --- plants --------------------------------------------------------------------------------------------------------

type Body = {
  group: Group;
  sway?: Object3D; // swings from its base
  leaves: Object3D[];
  petals: Object3D[];
  inner: Object3D[];
  head?: Object3D;
  fruits: Object3D[];
  blobs: Object3D[];
  seed?: Object3D;
  glows: Sprite[];
  fallingLeaf?: Mesh;
  owned: Material[]; // materials made for this body only, disposed with it
};

function leafAt(geo: BufferGeometry, material: Material, y: number, yaw: number, lift: number): Object3D {
  const pivot = new Group();
  pivot.position.y = y;
  pivot.rotation.y = yaw;
  const m = shadowed(new Mesh(geo, material));
  m.rotation.z = lift;
  pivot.add(m);
  return pivot;
}

function buildBody(kit: Kit, dot: DataTexture, p: PlantParams): Body {
  const group = new Group();
  const b: Body = { group, leaves: [], petals: [], inner: [], fruits: [], blobs: [], glows: [], owned: [] };
  const glow = (color: number, size: number, opacity: number, at: Vector3, parent: Object3D = group): void => {
    const h = halo(dot, color, size, opacity);
    h.position.copy(at);
    parent.add(h);
    b.glows.push(h);
    b.owned.push(h.material);
  };
  switch (p.stage) {
    case 'seed': {
      const seed = shadowed(new Mesh(kit.geo.seed, kit.mat.seed));
      seed.position.set(0.02, 0.11, 0.03);
      seed.rotation.set(0.2, 0.5, -0.5);
      group.add(seed);
      b.seed = seed;
      glow(C.amber, 0.7, 0.32, new Vector3(0.02, 0.16, 0.03));
      break;
    }
    case 'sprout': {
      const sway = new Group();
      sway.add(shadowed(new Mesh(kit.geo.sproutStem, kit.mat.plant)));
      // two leaves opening like the logo's sprout
      b.leaves.push(leafAt(kit.geo.sproutLeaf, kit.mat.leaf, 0.5, 0.15, 0.55), leafAt(kit.geo.sproutLeaf, kit.mat.leaf, 0.5, Math.PI + 0.15, 0.55));
      sway.add(...b.leaves);
      sway.position.y = 0.06;
      group.add(sway);
      b.sway = sway;
      glow(C.lime, 0.9, 0.12, new Vector3(0, 0.55, 0), sway);
      break;
    }
    case 'flower': {
      const sway = new Group();
      sway.add(shadowed(new Mesh(kit.geo.flowerStem, kit.mat.plant)));
      b.leaves.push(leafAt(kit.geo.leaf, kit.mat.leaf, 0.28, 0.4, 0.45), leafAt(kit.geo.leaf, kit.mat.leaf, 0.5, Math.PI + 0.2, 0.4), leafAt(kit.geo.leaf, kit.mat.leaf, 0.16, -1.6, 0.3));
      sway.add(...b.leaves);
      const head = new Group();
      head.position.set(0.02, 1.0, 0.07);
      head.rotation.x = 0.62; // face the camera a little
      const N = 9;
      for (let i = 0; i < N; i++) {
        const pivot = new Group();
        pivot.rotation.y = (i / N) * Math.PI * 2;
        const petal = shadowed(new Mesh(kit.geo.petal, kit.mat.petal));
        petal.position.x = 0.03;
        petal.rotation.z = 0.25;
        pivot.add(petal);
        head.add(pivot);
        b.petals.push(petal);
      }
      for (let i = 0; i < 6; i++) {
        const pivot = new Group();
        pivot.rotation.y = ((i + 0.5) / 6) * Math.PI * 2;
        const petal = new Mesh(kit.geo.petalInner, kit.mat.petal);
        petal.position.set(0.02, 0.02, 0);
        petal.rotation.z = 0.6;
        pivot.add(petal);
        head.add(pivot);
        b.inner.push(petal);
      }
      const core = new Mesh(kit.geo.core, kit.mat.core);
      core.position.y = 0.03;
      head.add(core);
      for (let i = 0; i < 10; i++) {
        const a = i * 2.39996;
        const r = 0.055 * Math.sqrt((i + 0.5) / 10);
        const d = new Mesh(kit.geo.coreDot, kit.mat.coreDot);
        d.position.set(Math.cos(a) * r, 0.072 - r * 0.35, Math.sin(a) * r);
        head.add(d);
      }
      glow(C.amber, 0.55, 0.5, new Vector3(0, 0.08, 0), head);
      glow(C.purple, 1.3, 0.22, new Vector3(0, 0.05, 0), head);
      sway.add(head);
      sway.position.y = 0.06;
      group.add(sway);
      b.sway = sway;
      b.head = head;
      break;
    }
    case 'fruit': {
      group.add(shadowed(new Mesh(kit.geo.trunk, kit.mat.bark)));
      group.add(shadowed(new Mesh(kit.geo.branchL, kit.mat.bark)), shadowed(new Mesh(kit.geo.branchR, kit.mat.bark)));
      const sway = new Group();
      sway.position.y = 0.72;
      const blobs: [number, number, number, number][] = [
        [0, 0.36, 0, 0],
        [-0.36, 0.26, 0.06, 1],
        [0.36, 0.3, -0.04, 2],
        [0.05, 0.66, -0.02, 3],
        [-0.12, 0.2, 0.3, 2],
      ];
      for (const [x, y, z, k] of blobs) {
        const m = shadowed(new Mesh(kit.geo.blobs[k], kit.mat.canopy));
        m.position.set(x, y, z);
        m.userData.base = m.position.clone();
        sway.add(m);
        b.blobs.push(m);
      }
      // fruits sit on the front half of the canopy, spread left to right and low to high
      for (let i = 0; i < p.fruits; i++) {
        const k = p.fruits === 1 ? 0.5 : i / (p.fruits - 1);
        const theta = (k - 0.5) * 1.9 + Math.sin(i * 2.39996 + p.phase) * 0.25;
        const phi = -0.3 + ((i * 0.618 + 0.3) % 1) * 0.75;
        const r = 0.6;
        const holder = new Group();
        holder.position.set(Math.sin(theta) * Math.cos(phi) * r, 0.36 + Math.sin(phi) * r, Math.cos(theta) * Math.cos(phi) * r);
        holder.add(shadowed(new Mesh(kit.geo.fruit, i % 2 ? kit.mat.fruitB : kit.mat.fruitA)));
        const lf = new Mesh(kit.geo.fruitLeaf, kit.mat.leaf);
        lf.position.y = 0.085;
        lf.rotation.set(0, i * 1.3, 0.6);
        holder.add(lf);
        const h = halo(dot, i % 2 ? C.amber : C.orange, 0.42, 0.35);
        holder.add(h);
        b.glows.push(h);
        b.owned.push(h.material);
        sway.add(holder);
        b.fruits.push(holder);
      }
      group.scale.setScalar(0.8);
      group.add(sway);
      b.sway = sway;
      break;
    }
    case 'pruned': {
      group.add(shadowed(new Mesh(kit.geo.stump, kit.mat.stump)));
      const face = new Mesh(kit.geo.cutFace, kit.mat.cut);
      face.position.y = 0.301;
      const r1 = new Mesh(kit.geo.cutRing, kit.mat.cutRing);
      r1.position.y = 0.303;
      const r2 = new Mesh(kit.geo.cutRing2, kit.mat.cutRing);
      r2.position.y = 0.303;
      group.add(face, r1, r2);
      group.add(leafAt(kit.geo.leaf, kit.mat.leaf, 0.12, 0.8, 0.15));
      for (let i = 0; i < 4; i++) {
        const chip = shadowed(new Mesh(kit.geo.chip, kit.mat.chip));
        const a = 0.6 + i * 1.4;
        chip.position.set(Math.cos(a) * (0.27 + rnd(i, 1) * 0.08), 0.06, Math.sin(a) * (0.27 + rnd(i, 2) * 0.08));
        chip.rotation.set(rnd(i, 3), rnd(i, 4) * 3, rnd(i, 5));
        group.add(chip);
      }
      const om = kit.mat.oldLeaf.clone();
      b.owned.push(om);
      const fl = shadowed(new Mesh(kit.geo.leaf, om));
      group.add(fl);
      b.fallingLeaf = fl;
      break;
    }
  }
  return b;
}

const disposeBody = (b: Body): void => {
  for (const m of b.owned) m.dispose();
};

type Anim = { kind: 'grow' | 'prune'; t: number; cut?: Group; cutBody?: Body };

class Plant {
  root = new Group();
  holder = new Group(); // receives the grow squash-and-stretch
  body: Body;
  ring: Mesh;
  disc: Mesh;
  hit: Mesh;
  anim: Anim | null = null;
  replaced: Body | null = null; // the body before a stage change, kept for a prune cut
  glow = 0;
  constructor(
    private kit: Kit,
    private dot: DataTexture,
    public p: PlantParams,
  ) {
    const mound = shadowed(new Mesh(kit.geo.mound, kit.mat.soil), true, true);
    this.ring = new Mesh(kit.geo.ring, kit.mat.ring.clone());
    this.ring.position.y = 0.02;
    this.disc = new Mesh(kit.geo.disc, kit.mat.disc.clone());
    (this.disc.material as MeshBasicMaterial).map = dot;
    this.disc.position.y = 0.025;
    this.hit = new Mesh(kit.geo.hit, kit.mat.hit);
    this.hit.userData.plotId = p.id;
    this.body = buildBody(kit, dot, p);
    this.holder.add(this.body.group);
    this.root.add(this.disc, mound, this.ring, this.holder, this.hit);
    this.root.position.set(p.x, 0, p.z);
  }
  set(p: PlantParams): void {
    const changed = p.stage !== this.p.stage || p.fruits !== this.p.fruits;
    const wasStage = this.p.stage;
    this.p = p;
    this.root.position.set(p.x, 0, p.z);
    if (!changed) return;
    this.holder.remove(this.body.group);
    if (this.replaced) disposeBody(this.replaced);
    if (wasStage !== p.stage) this.replaced = this.body;
    else {
      disposeBody(this.body);
      this.replaced = null;
    }
    this.body = buildBody(this.kit, this.dot, p);
    this.holder.add(this.body.group);
  }
  dispose(): void {
    (this.ring.material as Material).dispose();
    (this.disc.material as Material).dispose();
    disposeBody(this.body);
    if (this.replaced) disposeBody(this.replaced);
    if (this.anim?.cutBody) disposeBody(this.anim.cutBody);
  }
}

// --- particles -----------------------------------------------------------------------------------------------------

function dotTexture(): DataTexture {
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2);
      const a = Math.max(0, 1 - d) ** 2.2;
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  const t = new DataTexture(data, n, n);
  t.needsUpdate = true;
  return t;
}

// Round, soft points with their own size, colour and twinkle: stars, fireflies and sparkles all use this.
function glowPointsMaterial(attenuate: boolean): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPR: { value: 1 }, uOpacity: { value: 1 } },
    vertexShader: `
      attribute float size; attribute float phase; attribute vec3 tint;
      uniform float uTime; uniform float uPR;
      varying float vA; varying vec3 vC;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        vA = 0.55 + 0.45 * sin(uTime * (1.2 + fract(phase * 7.13)) + phase * 6.2831);
        vC = tint;
        gl_PointSize = size * uPR * (0.65 + 0.35 * vA) ${attenuate ? '* (8.0 / -mv.z)' : ''};
      }`,
    fragmentShader: `
      uniform float uOpacity;
      varying float vA; varying vec3 vC;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = pow(max(0.0, 1.0 - d), 1.6) + 0.6 * pow(max(0.0, 1.0 - d * 3.0), 2.0);
        gl_FragColor = vec4(vC * (1.0 + 0.6 * pow(max(0.0, 1.0 - d * 2.5), 2.0)), a * vA * uOpacity);
      }`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

function pointCloud(count: number, attenuate: boolean, fill: (i: number, pos: number[], size: number[], phase: number[], tint: number[]) => void): { pts: Points; mat: ShaderMaterial } {
  const pos: number[] = [];
  const size: number[] = [];
  const phase: number[] = [];
  const tint: number[] = [];
  for (let i = 0; i < count; i++) fill(i, pos, size, phase, tint);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('size', new Float32BufferAttribute(size, 1));
  g.setAttribute('phase', new Float32BufferAttribute(phase, 1));
  g.setAttribute('tint', new Float32BufferAttribute(tint, 3));
  const m = glowPointsMaterial(attenuate);
  const pts = new Points(g, m);
  pts.frustumCulled = false;
  return { pts, mat: m };
}

type Burst = { obj: Object3D; t: number; life: number; step(dt: number, t: number): void; dispose(): void };

// A spiral of glowing motes rising from a plant that just grew, with an expanding ring on the ground.
function sparkles(dot: DataTexture, pr: number, at: Vector3, colors: number[], count = 34): Burst {
  const c = new Color();
  const { pts, mat: m } = pointCloud(count, true, (i, pos, size, phase, tint) => {
    pos.push(0, 0, 0);
    size.push(10 + rnd(i, 1) * 12);
    phase.push(rnd(i, 2));
    c.setHex(colors[i % colors.length]);
    tint.push(c.r, c.g, c.b);
  });
  m.uniforms.uPR.value = pr;
  const ring = new Mesh(new RingGeometry(0.3, 0.42, 48).rotateX(-Math.PI / 2), new MeshBasicMaterial({ color: colors[0], map: dot, transparent: true, depthWrite: false, blending: AdditiveBlending }));
  ring.position.y = -at.y + 0.04;
  const obj = new Group();
  obj.add(pts, ring);
  obj.position.copy(at);
  const attr = pts.geometry.getAttribute('position') as Float32BufferAttribute;
  const life = 1.6;
  return {
    obj,
    t: 0,
    life,
    step(_dt, t) {
      for (let i = 0; i < count; i++) {
        const a = rnd(i, 3) * Math.PI * 2 + t * (1.6 + rnd(i, 4));
        const r = (0.15 + rnd(i, 5) * 0.45) * (0.4 + 0.6 * clamp01(t * 2));
        const up = (0.4 + rnd(i, 6) * 1.6) * t - 0.25 * t * t;
        attr.setXYZ(i, Math.cos(a) * r, up - 0.2, Math.sin(a) * r);
      }
      attr.needsUpdate = true;
      m.uniforms.uTime.value = t * 6;
      m.uniforms.uOpacity.value = 1 - clamp01((t - life * 0.45) / (life * 0.55));
      const k = clamp01(t / 0.9);
      ring.scale.setScalar(0.4 + 2.4 * (1 - (1 - k) ** 3));
      (ring.material as MeshBasicMaterial).opacity = 0.9 * (1 - k);
    },
    dispose() {
      pts.geometry.dispose();
      m.dispose();
      ring.geometry.dispose();
      (ring.material as Material).dispose();
    },
  };
}

// Small flat pieces that fall and spin: confetti over the bed, or leaves from a cut plant.
function flutter(geo: BufferGeometry, colors: number[], count: number, origin: Vector3, spread: number, up: number, life: number): Burst {
  const material = new MeshBasicMaterial({ side: DoubleSide, transparent: true });
  const mesh = new InstancedMesh(geo, material, count);
  mesh.frustumCulled = false;
  const seeds = Array.from({ length: count }, (_, i) => {
    const r = (k: number): number => rnd(i, k);
    return { p: new Vector3((r(1) - 0.5) * spread, r(2) * 0.4, (r(3) - 0.5) * spread * 0.6), v: new Vector3((r(4) - 0.5) * 2.2, up * (0.6 + r(5) * 0.6), (r(6) - 0.5) * 1.4), spin: new Vector3(r(7) * 8, r(8) * 8, r(9) * 8), sway: r(10) * 6 };
  });
  const c = new Color();
  for (let i = 0; i < count; i++) mesh.setColorAt(i, c.setHex(colors[i % colors.length]));
  const m4 = new Matrix4();
  const q = new Quaternion();
  const e = new Object3D();
  const one = new Vector3(1, 1, 1);
  mesh.position.copy(origin);
  return {
    obj: mesh,
    t: 0,
    life,
    step(dt, t) {
      // a pop upwards, then gravity until the piece reaches a slow flutter speed
      const damp = Math.exp(-dt * 1.6);
      for (let i = 0; i < count; i++) {
        const s = seeds[i];
        s.v.x *= damp;
        s.v.z *= damp;
        s.v.y = Math.max(s.v.y - 3.2 * dt, -0.75);
        s.p.addScaledVector(s.v, dt);
        e.position.set(s.p.x + Math.sin(t * 3 + s.sway) * 0.12, s.p.y, s.p.z + Math.cos(t * 2.4 + s.sway) * 0.06);
        e.rotation.set(s.spin.x * t, s.spin.y * t, s.spin.z * t);
        q.setFromEuler(e.rotation);
        m4.compose(e.position, q, one);
        mesh.setMatrixAt(i, m4);
      }
      mesh.instanceMatrix.needsUpdate = true;
      material.opacity = 1 - clamp01((t - life * 0.6) / (life * 0.4));
    },
    dispose() {
      mesh.dispose();
      material.dispose();
    },
  };
}

// --- the scene -----------------------------------------------------------------------------------------------------

const FOV = 34;
const PLANT_SCALE = 1.5;

export function createGardenScene(canvas: HTMLCanvasElement, opts: SceneOptions): GardenScene {
  const win = opts.win;
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'default' });
  renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  // VSM rather than PCF: PCF shadows rendered the whole scene dark in iOS Safari (WebKit), VSM renders correctly there
  renderer.shadowMap.type = VSMShadowMap;
  const pr = (): number => renderer.getPixelRatio();

  const scene = new Scene();
  scene.fog = new Fog(C.haze, 14, 34);
  const camera = new PerspectiveCamera(FOV, 2, 0.1, 90);
  scene.add(camera);
  const kit = makeKit();
  const dot = dotTexture();
  const owned: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => (owned.push(x), x);

  // --- light: lavender sky, warm earth bounce, a warm low sun and a purple rim from behind ---
  scene.add(new HemisphereLight(0xb9a8ff, 0x4a2c25, 1.25));
  const sun = new DirectionalLight(0xffd6a0, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.radius = 6;
  sun.shadow.blurSamples = 12;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  const rim = new DirectionalLight(0x9d86ff, 2.2);
  rim.position.set(-6, 4, -7);
  scene.add(rim);

  // --- sky: a moon pinned to the view, stars, drifting clouds and two islets far away ---
  const moon = new Group();
  const moonDisc = new Mesh(keep(new CircleGeometry(1, 40)), keep(new MeshBasicMaterial({ color: C.moon, fog: false, transparent: true, opacity: 0.95 })));
  const moonShade = new Mesh(keep(new CircleGeometry(0.93, 40)), keep(new MeshBasicMaterial({ color: 0xe8d4ff, fog: false, transparent: true, opacity: 0.22 })));
  moonShade.position.set(0.22, -0.16, 0.01);
  const moonHalo = halo(dot, 0xffd9a8, 9, 0.45);
  const moonHalo2 = halo(dot, C.purpleLight, 20, 0.18);
  for (const h of [moonHalo, moonHalo2]) {
    (h.material as SpriteMaterial).fog = false;
    owned.push(h.material);
  }
  moonHalo.position.z = moonHalo2.position.z = -0.1;
  moon.add(moonHalo2, moonHalo, moonDisc, moonShade);
  moon.renderOrder = -1;
  camera.add(moon);
  const placeMoon = (aspect: number): void => {
    const z = 60;
    const th = Math.tan(((FOV / 2) * Math.PI) / 180);
    moon.position.set(th * z * aspect * 0.62, th * z * 0.62, -z);
    moon.scale.setScalar(z * 0.028);
  };

  const starCol = new Color();
  const stars = pointCloud(140, false, (i, pos, size, phase, tint) => {
    const x = (rnd(i, 1) - 0.5) * 120;
    const y = 4 + rnd(i, 2) ** 0.8 * 34;
    pos.push(x, y, -40 - rnd(i, 3) * 10);
    size.push(1.5 + rnd(i, 4) ** 3 * 4.5);
    phase.push(rnd(i, 5));
    starCol.setHex(rnd(i, 6) < 0.2 ? C.amber : rnd(i, 6) < 0.45 ? C.purpleLight : 0xffffff);
    tint.push(starCol.r, starCol.g, starCol.b);
  });
  owned.push(stars.pts.geometry, stars.mat);
  scene.add(stars.pts);

  const cloudMat = keep(mat(0x5d5590, { roughness: 1, emissive: col(0x2b2550), emissiveIntensity: 0.4, fog: false, transparent: true, opacity: 0.4, depthWrite: false }));
  const cloudGeo = keep(new SphereGeometry(1, 20, 14));
  const clouds = new Group();
  // [screen x, screen y (-1..1), distance from the camera, size]: placed from the view in frame3, so they sit in the sky at any aspect
  for (const [x, y, z, s] of [[-0.55, 0.74, 46, 1.5], [0.12, 0.92, 52, 1.8], [0.95, 0.4, 44, 1.3], [-1.0, 0.18, 40, 1.2]] as const) {
    const cl = new Group();
    for (let k = 0; k < 5; k++) {
      const m = new Mesh(cloudGeo, cloudMat);
      const r = 0.55 + rnd(k + x, 1) * 0.5;
      m.position.set((k - 2) * 0.7 + rnd(k + x, 2) * 0.2, (2 - Math.abs(k - 2)) * 0.18 + rnd(k + x, 3) * 0.15, rnd(k + x, 4) * 0.3);
      m.scale.set(r * 1.2, r * 0.8, r * 0.7);
      cl.add(m);
    }
    cl.scale.setScalar(s);
    cl.userData.at = [x, y, z];
    clouds.add(cl);
  }
  scene.add(clouds);

  const islets = new Group();
  {
    const tiny = islandGeometry(1.6, 1.3, 3);
    const tinyTop = keep(tiny.top);
    const tinySide = keep(tiny.side);
    const topMat = keep(mat(0xffffff, { vertexColors: true, roughness: 0.9 }));
    const sideMat = keep(mat(0xffffff, { vertexColors: true, roughness: 0.95, flatShading: true }));
    const treeGeo = keep(blobGeometry(0.42, 7, C.canopyDark, C.canopy));
    for (const [x, y, z, s, tree] of [[-0.8, 0.32, 24, 1.0, 1], [0.8, -0.02, 28, 1.3, 2]] as const) {
      const g = new Group();
      g.add(new Mesh(tinyTop, topMat), new Mesh(tinySide, sideMat));
      for (let k = 0; k < tree; k++) {
        const t = new Mesh(treeGeo, kit.mat.canopy);
        t.position.set(k * 0.45 - 0.2, 0.42 - k * 0.1, -0.1 + k * 0.2);
        t.scale.setScalar(1 - k * 0.3);
        g.add(t);
      }
      g.scale.setScalar(s);
      g.userData.at = [x, y, z];
      islets.add(g);
    }
  }
  scene.add(islets);

  // --- the garden island; everything on it bobs gently together ---
  const world = new Group();
  scene.add(world);
  const islandTopMat = keep(mat(0xffffff, { vertexColors: true, roughness: 0.95 }));
  const islandSideMat = keep(mat(0xffffff, { vertexColors: true, roughness: 0.95, flatShading: true }));
  let island: { top: Mesh; side: Mesh } | null = null;
  const deco = new Group();
  world.add(deco);
  const decoOwned: { dispose(): void }[] = [];

  // grass blades: instanced, bent by a wind wave in the vertex shader, darker at the root
  const wind = { value: 0 };
  const bladeGeo = (() => {
    const g = new BufferGeometry();
    const pos: number[] = [];
    const colors: number[] = [];
    const segs = 4;
    const a = col(0x2e6b3c);
    const b = col(0xb8f07a);
    const c = new Color();
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const w = 0.022 * (1 - t) ** 0.9;
      const bend = 0.05 * t * t;
      pos.push(-w, t * 0.2, bend, w, t * 0.2, bend);
      c.copy(a).lerp(b, t ** 1.3);
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    const idx: number[] = [];
    for (let i = 0; i < segs; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new Float32BufferAttribute(colors, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return keep(g);
  })();
  const bladeMat = keep(mat(0xffffff, { vertexColors: true, side: DoubleSide, roughness: 0.8 }));
  bladeMat.onBeforeCompile = (sh) => {
    sh.uniforms.uWind = wind;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWind;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        #else
          vec3 ip = vec3(0.0);
        #endif
        float h = position.y * 5.0;
        float gust = sin(uWind * 1.6 + ip.x * 1.3 + ip.z * 0.9) + 0.5 * sin(uWind * 2.9 + ip.x * 3.1 - ip.z * 1.7);
        transformed.x += gust * 0.045 * h * h;
        transformed.z += cos(uWind * 1.2 + ip.z * 1.9) * 0.025 * h * h;`,
      );
  };
  bladeMat.customProgramCacheKey = () => 'flipgarden-grass';

  const mushCapGeo = keep(new SphereGeometry(0.07, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.7, 1));
  const mushStemGeo = keep(new CylinderGeometry(0.018, 0.024, 0.08, 8).translate(0, 0.04, 0));
  const mushCapMat = keep(mat(C.lavender, { roughness: 0.45, emissive: col(C.purple), emissiveIntensity: 0.55 }));
  const mushStemMat = keep(mat(C.cream, { roughness: 0.7, emissive: col(C.cream), emissiveIntensity: 0.15 }));
  const pebbleGeo = keep(new IcosahedronGeometry(0.05, 0));
  const pebbleMat = keep(mat(0x8a7aa8, { roughness: 0.9, flatShading: true }));
  const budGeo = keep(new SphereGeometry(0.022, 8, 6));
  const budMat = keep(mat(0xffffff, { roughness: 0.6, emissive: col(0xffffff), emissiveIntensity: 0.25 }));
  const postGeo = keep(taperTube([new Vector3(0, 0, 0), new Vector3(0, 0.6, 0), new Vector3(0.03, 1.05, 0), new Vector3(0.14, 1.2, 0), new Vector3(0.28, 1.18, 0)], 0.035, 0.022, C.barkDark, C.bark, 16, 6));
  const lanternGeo = keep(new SphereGeometry(0.09, 16, 12).scale(0.85, 1.1, 0.85));
  const lanternCapGeo = keep(new CylinderGeometry(0.03, 0.08, 0.05, 10));
  const lanternMat = keep(mat(C.amber, { emissive: col(0xffb347), emissiveIntensity: 2.2, roughness: 0.4 }));
  const lantern = new PointLight(0xffb560, 4, 5, 1.6);
  let lanternGlow: Sprite | null = null;
  const vines: Mesh[] = [];
  const mushrooms: Sprite[] = [];

  const scatter = (p: SceneParams, w: number, d: number, radius: (t: number) => number): void => {
    deco.clear();
    for (const o of decoOwned.splice(0)) o.dispose();
    vines.length = 0;
    mushrooms.length = 0;
    const plantsAt = p.plants.map((pl) => [pl.x, pl.z] as const);
    const free = (x: number, z: number, room: number): boolean => plantsAt.every(([px, pz]) => Math.hypot(x - px, z - pz) > room);
    const inside = (x: number, z: number, f: number): boolean => Math.hypot(x, z) < radius(Math.atan2(z, x)) * f;
    const m4 = new Matrix4();
    const q = new Quaternion();
    const e = new Object3D();
    const s = new Vector3();
    const v = new Vector3();
    const c = new Color();

    // grass
    const want = Math.min(1800, Math.round(w * d * 110));
    const blades = new InstancedMesh(bladeGeo, bladeMat, want);
    decoOwned.push({ dispose: () => blades.dispose() });
    let n = 0;
    for (let i = 0; n < want && i < want * 4; i++) {
      const x = (rnd(i, 11) - 0.5) * w;
      const z = (rnd(i, 12) - 0.5) * d;
      if (!inside(x, z, 0.96) || !free(x, z, 0.4)) continue;
      e.rotation.set((rnd(i, 13) - 0.5) * 0.4, rnd(i, 14) * Math.PI * 2, (rnd(i, 15) - 0.5) * 0.4);
      q.setFromEuler(e.rotation);
      const h = 0.45 + rnd(i, 16) * 0.6;
      m4.compose(v.set(x, 0.02, z), q, s.set(1, h, 1));
      blades.setMatrixAt(n, m4);
      blades.setColorAt(n, c.setHSL(0.28 + (rnd(i, 17) - 0.5) * 0.05, 0.5, 0.5 + rnd(i, 18) * 0.14));
      n++;
    }
    blades.count = n;
    blades.receiveShadow = true;
    deco.add(blades);

    // little white and lavender buds in the grass
    const buds = new InstancedMesh(budGeo, budMat, 40);
    decoOwned.push({ dispose: () => buds.dispose() });
    let nb = 0;
    for (let i = 0; nb < 40 && i < 400; i++) {
      const x = (rnd(i, 21) - 0.5) * w;
      const z = (rnd(i, 22) - 0.5) * d;
      if (!inside(x, z, 0.9) || !free(x, z, 0.42)) continue;
      m4.compose(v.set(x, 0.13 + rnd(i, 23) * 0.08, z), q.identity(), s.setScalar(0.7 + rnd(i, 24) * 0.6));
      buds.setMatrixAt(nb, m4);
      buds.setColorAt(nb, c.setHex([0xffffff, C.lavender, C.amber, C.purpleLight][i % 4]));
      nb++;
    }
    buds.count = nb;
    deco.add(buds);

    // pebbles around the rim
    const pebbles = new InstancedMesh(pebbleGeo, pebbleMat, 18);
    decoOwned.push({ dispose: () => pebbles.dispose() });
    for (let i = 0; i < 18; i++) {
      const t = rnd(i, 31) * Math.PI * 2;
      const r = radius(t) * (0.84 + rnd(i, 32) * 0.1);
      e.rotation.set(rnd(i, 33) * 3, rnd(i, 34) * 3, 0);
      q.setFromEuler(e.rotation);
      m4.compose(v.set(Math.cos(t) * r, 0.01, Math.sin(t) * r), q, s.set(1 + rnd(i, 35), 0.5 + rnd(i, 36) * 0.4, 1 + rnd(i, 37) * 0.6));
      pebbles.setMatrixAt(i, m4);
    }
    pebbles.castShadow = true;
    deco.add(pebbles);

    // glowing mushrooms in small clusters near the edge
    const spots = [2.5, 0.35, 4.0];
    spots.forEach((t, k) => {
      const r = radius(t) * 0.82;
      const bx = Math.cos(t) * r;
      const bz = Math.sin(t) * r;
      if (!free(bx, bz, 0.45)) return;
      for (let j = 0; j < 3; j++) {
        const g = new Group();
        g.position.set(bx + (j - 1) * 0.09, 0.01, bz + ((j * 7) % 3 - 1) * 0.06);
        const sc = j === 1 ? 1.2 : 0.75 + 0.1 * j;
        g.scale.setScalar(sc);
        g.rotation.z = (j - 1) * 0.2;
        const cap = new Mesh(mushCapGeo, mushCapMat);
        cap.position.y = 0.075;
        g.add(shadowed(new Mesh(mushStemGeo, mushStemMat)), cap);
        deco.add(g);
      }
      const h = halo(dot, k === 1 ? C.lime : C.purple, 0.9, 0.35);
      h.position.set(bx, 0.12, bz);
      decoOwned.push(h.material);
      deco.add(h);
      mushrooms.push(h);
    });

    // vines hanging over the front edge
    const vineMat = kit.mat.plant;
    for (let i = 0; i < 7; i++) {
      const t = 0.35 + (i / 6) * (Math.PI - 0.7) + (rnd(i, 41) - 0.5) * 0.2;
      const r = radius(t) * 1.01;
      const x = Math.cos(t) * r;
      const z = Math.sin(t) * r;
      const len = 0.25 + rnd(i, 42) * 0.45;
      const out = new Vector3(Math.cos(t), 0, Math.sin(t));
      const pts = [new Vector3(x, 0.0, z), new Vector3(x + out.x * 0.06, -0.08, z + out.z * 0.06), new Vector3(x + out.x * 0.05, -len * 0.6, z + out.z * 0.05), new Vector3(x + out.x * 0.02, -len, z + out.z * 0.02)];
      const g = taperTube(pts, 0.014, 0.006, C.stemDark, C.stem, 10, 5);
      decoOwned.push(g);
      const vine = new Mesh(g, vineMat);
      deco.add(vine);
      vines.push(vine);
      for (let k = 1; k <= 3; k++) {
        const p0 = pts[Math.min(3, k)];
        const l = new Mesh(kit.geo.fruitLeaf, kit.mat.leaf);
        l.position.copy(p0);
        l.rotation.set(0.4, t + k * 2, -0.4 - k * 0.2);
        l.scale.setScalar(1.3);
        vine.add(l);
        l.position.sub(vine.position);
      }
    }

    // a lantern on the back-left corner, lighting the grass warmly
    const lt = -2.3;
    const lr = radius(lt) * 0.8;
    const post = new Group();
    post.position.set(Math.cos(lt) * lr, 0, Math.sin(lt) * lr);
    post.rotation.y = 0.5;
    post.add(shadowed(new Mesh(postGeo, kit.mat.bark)));
    const lamp = new Group();
    lamp.position.set(0.28, 1.06, 0);
    const cap = new Mesh(lanternCapGeo, kit.mat.bark);
    cap.position.y = 0.11;
    lamp.add(new Mesh(lanternGeo, lanternMat), cap);
    lanternGlow = halo(dot, 0xffb347, 1.4, 0.6);
    decoOwned.push(lanternGlow.material);
    lamp.add(lanternGlow);
    lamp.add(lantern);
    post.add(lamp);
    post.userData.lamp = lamp;
    deco.add(post);
  };

  // warm fireflies drifting over the garden
  const FLIES = 30;
  const flyCol = new Color();
  const flies = pointCloud(FLIES, true, (i, pos, size, phase, tint) => {
    pos.push(0, 0, 0);
    size.push(7 + rnd(i, 51) * 6);
    phase.push(rnd(i, 52));
    flyCol.setHex(i % 4 === 0 ? C.lime : C.amber);
    tint.push(flyCol.r, flyCol.g, flyCol.b);
  });
  owned.push(flies.pts.geometry, flies.mat);
  world.add(flies.pts);

  const plants = new Map<string, Plant>();
  const bursts: Burst[] = [];
  let params: SceneParams | null = null;
  let view: GardenView | null = null;
  let aspect = 2;
  let highlighted: string | null = null;
  let hovered: string | null = null;
  let running = false;
  let raf = 0;
  let last = 0;
  let clock = 0;
  let frameMs = 0;
  let renderMs = 0;
  let dead = false;
  let camDist = 8;
  let elevation = elevationFor(1);
  let islandH = 1.3;

  const layoutBed = (p: SceneParams): void => {
    const w = p.width + 0.9;
    const d = p.depth + 1.0;
    if (island) {
      world.remove(island.top, island.side);
      island.top.geometry.dispose();
      island.side.geometry.dispose();
    }
    const geo = islandGeometry(w, d, p.cols * 1.7 + p.rows);
    islandH = geo.height;
    island = { top: shadowed(new Mesh(geo.top, islandTopMat), false, true), side: shadowed(new Mesh(geo.side, islandSideMat), false, true) };
    world.add(island.top, island.side);
    scatter(p, w, d, geo.radius);
    sun.position.set(w * 0.35 + 3, 7.5, d * 0.4 + 4.5);
    const cam = sun.shadow.camera;
    const ext = Math.max(w, d) / 2 + 1.2;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    cam.near = 0.5;
    cam.far = 25;
    cam.updateProjectionMatrix();
    elevation = elevationFor(p.rows);
    frame3();
  };
  // camera distance and fog for the current bed and canvas
  const frame3 = (): void => {
    if (!params) return;
    camDist = cameraDistance(params.width, params.depth, aspect, FOV, elevation) * 1.04 + islandH * 0.35;
    const f = scene.fog as Fog;
    f.near = camDist + 4;
    f.far = camDist + 30;
    // pin the far scenery to places in the view, measured from the camera's resting position
    placeCamera(0, true);
    camera.updateMatrixWorld();
    const dir = new Vector3();
    for (const g of [...clouds.children, ...islets.children]) {
      const [x, y, dist] = g.userData.at as [number, number, number];
      dir.set(x, y, 0.5).unproject(camera).sub(camera.position).normalize();
      g.position.copy(camera.position).addScaledVector(dir, dist);
      g.userData.x = g.position.x;
      g.userData.y = g.position.y;
    }
  };

  const rebuild = (): void => {
    if (!view) return;
    const prevShape = params ? `${params.cols}x${params.rows}` : '';
    const prevPos = params ? params.plants.map((p) => `${p.id}:${p.x.toFixed(3)},${p.z.toFixed(3)}`).join('|') : '';
    params = sceneParams(view, aspect);
    const pos = params.plants.map((p) => `${p.id}:${p.x.toFixed(3)},${p.z.toFixed(3)}`).join('|');
    if (`${params.cols}x${params.rows}` !== prevShape || !island) layoutBed(params);
    else if (pos !== prevPos) layoutBed(params);
    else frame3();
    const ids = new Set(params.plants.map((p) => p.id));
    for (const [id, pl] of plants)
      if (!ids.has(id)) {
        world.remove(pl.root);
        pl.dispose();
        plants.delete(id);
      }
    for (const p of params.plants) {
      const pl = plants.get(p.id);
      if (pl) pl.set(p);
      else {
        const np = new Plant(kit, dot, p);
        plants.set(p.id, np);
        world.add(np.root);
      }
    }
  };

  function placeCamera(t: number, rest = false): void {
    const az = opts.still || rest ? 0 : Math.sin(t * 0.11) * 0.08;
    const el = elevation + (opts.still || rest ? 0 : Math.sin(t * 0.083) * 0.025);
    camera.position.set(Math.sin(az) * Math.cos(el) * camDist, Math.sin(el) * camDist + 0.2, Math.cos(az) * Math.cos(el) * camDist);
    camera.lookAt(0, 0.35, 0);
  }

  const flyPos = flies.pts.geometry.getAttribute('position') as Float32BufferAttribute;
  const animate = (t: number, dt: number): void => {
    wind.value = t;
    world.position.y = Math.sin(t * 0.55) * 0.04;
    world.rotation.z = Math.sin(t * 0.37) * 0.006;
    clouds.children.forEach((cl, i) => (cl.position.x = cl.userData.x + Math.sin(t * 0.03 + i * 2) * 2));
    islets.children.forEach((g, i) => (g.position.y = g.userData.y + Math.sin(t * 0.4 + i * 1.7) * 0.18));
    stars.mat.uniforms.uTime.value = t;
    flies.mat.uniforms.uTime.value = t * 1.6;
    // fireflies
    const w = params ? params.width + 1.4 : 4;
    const d = params ? params.depth + 1.2 : 2;
    for (let i = 0; i < FLIES; i++) {
      const a = i * 1.618;
      flyPos.setXYZ(i, Math.sin(t * 0.13 + a * 3) * w * 0.55, 0.35 + ((i * 0.37) % 1.9) + Math.sin(t * 0.7 + a) * 0.25, Math.cos(t * 0.11 + a * 2) * d * 0.6);
    }
    flyPos.needsUpdate = true;
    // lantern flicker
    const flick = 1 + 0.06 * Math.sin(t * 9.1) + 0.04 * Math.sin(t * 13.7 + 1);
    lantern.intensity = 4 * flick;
    if (lanternGlow) lanternGlow.material.opacity = 0.6 * flick;
    mushrooms.forEach((h, i) => (h.material.opacity = 0.28 + 0.12 * Math.sin(t * 1.3 + i * 2)));
    vines.forEach((v, i) => (v.rotation.z = Math.sin(t * 0.9 + i) * 0.015));

    for (const pl of plants.values()) {
      const ph = pl.p.phase;
      const b = pl.body;
      // highlight glow
      const target = pl.p.id === highlighted || pl.p.id === hovered ? 1 : 0;
      pl.glow += (target - pl.glow) * Math.min(1, dt * 10);
      (pl.ring.material as MeshBasicMaterial).opacity = pl.glow * (0.75 + 0.2 * Math.sin(t * 4));
      (pl.disc.material as MeshBasicMaterial).opacity = pl.glow * 0.5;
      pl.ring.scale.setScalar(1 + 0.04 * Math.sin(t * 4));
      const hs = 1 + pl.glow * 0.07;
      // idle motion, each plant with its own phase
      if (b.seed) {
        const s = 1 + 0.08 * Math.sin(t * 2.2 + ph);
        b.seed.scale.set(s, 2 - s, s);
      }
      for (const g of b.glows) g.material.opacity = g.userData.base * (0.8 + 0.2 * Math.sin(t * 2.2 + ph));
      if (b.sway) {
        const amp = pl.p.stage === 'fruit' ? 0.022 : 0.085;
        b.sway.rotation.z = Math.sin(t * 1.4 + ph) * amp + Math.sin(t * 2.3 + ph * 2) * amp * 0.3;
        b.sway.rotation.x = Math.sin(t * 1.05 + ph * 1.7) * amp * 0.5;
      }
      b.leaves.forEach((l, i) => (l.rotation.x = Math.sin(t * 2.1 + ph + i * 1.3) * 0.13));
      if (b.petals.length) {
        const open = pl.anim?.kind === 'grow' ? easeOutBack(clamp01((pl.anim.t - 0.25) / 1.0)) : 1;
        b.petals.forEach((pt, i) => (pt.rotation.z = 1.35 - open * (1.18 - 0.06 * Math.sin(t * 1.8 + ph + i * 0.6))));
        b.inner.forEach((pt, i) => (pt.rotation.z = 1.4 - open * (0.92 - 0.05 * Math.sin(t * 2 + ph + i))));
        if (b.head) b.head.rotation.y = Math.sin(t * 0.6 + ph) * 0.3;
      }
      b.blobs.forEach((m, i) => {
        const s = 1 + 0.025 * Math.sin(t * 1.3 + ph + i * 1.7);
        m.scale.set(s, 2 - s, s);
      });
      b.fruits.forEach((f, i) => {
        const bob = Math.sin(t * 2 + ph + i * 1.9) * 0.022;
        f.position.y += bob - (f.userData.bob ?? 0);
        f.userData.bob = bob;
        f.rotation.z = Math.sin(t * 2 + ph + i * 1.9) * 0.12;
      });
      if (b.fallingLeaf) {
        const cyc = 4.6;
        const u = ((t + ph) % cyc) / cyc;
        const fall = clamp01(u / 0.8);
        b.fallingLeaf.position.set(0.18 + Math.sin(fall * 9) * 0.16, 0.7 - fall * 0.64, 0.12 + Math.cos(fall * 7) * 0.08);
        b.fallingLeaf.rotation.set(Math.sin(fall * 10) * 0.8, fall * 4, Math.cos(fall * 8) * 0.6);
        const fade = u < 0.08 ? u / 0.08 : u > 0.85 ? Math.max(0, 1 - (u - 0.85) / 0.15) : 1;
        b.fallingLeaf.scale.setScalar(0.25 + 0.75 * fade);
        (b.fallingLeaf.material as MeshStandardMaterial).opacity = fade;
        b.fallingLeaf.visible = fade > 0.02;
      }
      // transitions
      let sx = 1;
      let sy = 1;
      if (pl.anim) {
        pl.anim.t += dt;
        const a = pl.anim;
        if (a.kind === 'grow') {
          ({ sx, sy } = squashStretch(a.t / 0.9));
          if (a.t >= 1.4) pl.anim = null;
        } else {
          const k = clamp01(a.t / 1.1);
          // the cut top tips over from its base and sinks away; the stump gives a small squash
          if (a.cut) {
            a.cut.rotation.z = -easeOutBack(Math.min(1, k * 1.3)) * 1.35;
            a.cut.position.set(k * 0.35, 0.28 - k * 0.2, 0);
            a.cut.scale.setScalar(PLANT_SCALE * Math.max(0.001, 1 - clamp01((k - 0.55) / 0.45)));
          }
          ({ sx, sy } = k < 0.5 ? { sx: 1 + 0.12 * Math.sin(k * Math.PI * 2), sy: 1 - 0.14 * Math.sin(k * Math.PI * 2) } : { sx: 1, sy: 1 });
          if (a.t >= 1.2) {
            if (a.cut) pl.root.remove(a.cut);
            if (a.cutBody) disposeBody(a.cutBody);
            pl.anim = null;
          }
        }
      }
      pl.holder.scale.set(sx * hs * PLANT_SCALE, sy * hs * PLANT_SCALE, sx * hs * PLANT_SCALE);
    }
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      b.t += dt;
      b.step(dt, b.t);
      if (b.t >= b.life) {
        world.remove(b.obj);
        b.dispose();
        bursts.splice(i, 1);
      }
    }
  };

  const draw = (): void => {
    const t0 = win.performance.now();
    placeCamera(clock);
    renderer.render(scene, camera);
    const ms = win.performance.now() - t0;
    renderMs = renderMs ? renderMs * 0.95 + ms * 0.05 : ms;
  };

  const frame = (now: number): void => {
    raf = 0;
    if (!running || dead) return;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    if (last) frameMs = frameMs ? frameMs * 0.95 + (now - last) * 0.05 : now - last;
    last = now;
    clock += dt;
    animate(clock, dt);
    draw();
    raf = win.requestAnimationFrame(frame);
  };

  const still = (): void => {
    if (dead) return;
    animate(clock, 0);
    draw();
  };

  const kick = (): void => {
    if (opts.still) return still();
    if (running && !raf && !dead) {
      last = 0;
      raf = win.requestAnimationFrame(frame);
    }
  };

  // --- picking ---
  const ray = new Raycaster();
  const ndc = new Vector2();
  const pickAt = (ev: PointerEvent | MouseEvent): string | null => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects([...plants.values()].map((p) => p.hit), false);
    return hits.length ? (hits[0].object.userData.plotId as string) : null;
  };
  const onMove = (ev: PointerEvent): void => {
    if (ev.pointerType === 'touch') return;
    const id = pickAt(ev);
    if (id !== hovered) {
      hovered = id;
      canvas.style.cursor = id ? 'pointer' : '';
      if (opts.still) still();
    }
  };
  const onLeave = (): void => {
    hovered = null;
    canvas.style.cursor = '';
    if (opts.still) still();
  };
  const onClick = (ev: MouseEvent): void => {
    const id = pickAt(ev);
    if (!id) return;
    highlighted = id;
    if (opts.still) still();
    opts.onPick(id);
  };
  const onLost = (ev: Event): void => {
    ev.preventDefault();
    dead = true;
    opts.onFail();
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('webglcontextlost', onLost);

  const addBurst = (b: Burst): void => {
    world.add(b.obj);
    bursts.push(b);
  };

  return {
    update(v) {
      view = v;
      rebuild();
      kick();
      if (opts.still) still();
    },
    highlight(id) {
      if (highlighted === id) return;
      highlighted = id;
      if (opts.still) still();
    },
    play(moments) {
      if (opts.still) return;
      for (const m of moments) {
        if (m.kind === 'confetti') {
          const w = params ? params.width : 3;
          const g = new PlaneGeometry(0.09, 0.05);
          const b = flutter(g, [C.lime, C.purple, C.amber, C.mint, C.purpleLight], 120, new Vector3(0, 1.5, 0.4), w + 1, 2.4, 3.2);
          const dispose = b.dispose;
          b.dispose = () => {
            dispose();
            g.dispose();
          };
          addBurst(b);
          continue;
        }
        const pl = plants.get(m.plotId);
        if (!pl) continue;
        const at = new Vector3(pl.p.x, 0.5, pl.p.z);
        if (m.kind === 'grow') {
          pl.anim = { kind: 'grow', t: 0 };
          if (pl.replaced) disposeBody(pl.replaced);
          pl.replaced = null;
          addBurst(sparkles(dot, pr(), at, [C.lime, C.amber, C.purpleLight]));
        } else {
          const cut = pl.replaced;
          pl.replaced = null;
          if (cut) {
            const g = new Group();
            cut.group.position.set(0, -0.28, 0);
            g.add(cut.group);
            pl.root.add(g);
            pl.anim = { kind: 'prune', t: 0, cut: g, cutBody: cut };
          } else pl.anim = { kind: 'prune', t: 0 };
          addBurst(flutter(kit.geo.leaf, [C.lime, C.stem, C.oldLeaf], 16, new Vector3(pl.p.x, 0.7, pl.p.z), 0.8, 1.4, 1.8));
        }
      }
      kick();
    },
    setRunning(on) {
      if (running === on) return;
      running = on;
      if (on) kick();
      else if (raf) {
        win.cancelAnimationFrame(raf);
        raf = 0;
      }
    },
    resize(w, h) {
      if (w < 2 || h < 2) return;
      renderer.setSize(w, h, false);
      aspect = w / h;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      placeMoon(aspect);
      stars.mat.uniforms.uPR.value = pr();
      flies.mat.uniforms.uPR.value = pr();
      sun.shadow.mapSize.set(w < 600 ? 512 : 1024, w < 600 ? 512 : 1024);
      if (sun.shadow.map) {
        sun.shadow.map.dispose();
        sun.shadow.map = null as never;
      }
      if (view) rebuild();
      if (opts.still || !running) still();
    },
    stats: () => ({ frameMs, renderMs }),
    dispose() {
      dead = true;
      if (raf) win.cancelAnimationFrame(raf);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('webglcontextlost', onLost);
      for (const b of bursts) b.dispose();
      for (const p of plants.values()) p.dispose();
      for (const g of Object.values(kit.geo)) if (Array.isArray(g)) g.forEach((x) => x.dispose());
      else g.dispose();
      for (const m of Object.values(kit.mat)) m.dispose();
      for (const o of decoOwned) o.dispose();
      for (const o of owned) o.dispose();
      if (island) {
        island.top.geometry.dispose();
        island.side.geometry.dispose();
      }
      dot.dispose();
      renderer.dispose();
    },
  };
}

// The 3D garden scene, built with Three.js from geometry in code (no image files). Loaded as its own chunk by
// garden3d-mount.ts, only when a garden panel is on the page. It only draws what the garden view already says; the plot
// cards in the DOM stay the source of truth for every word, number and button.
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Quaternion,
  Raycaster,
  RingGeometry,
  Scene,
  Shape,
  SphereGeometry,
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
  amber: 0xffc857,
  orange: 0xff9f43,
  mint: 0x5fe3a1,
  grass: 0x3f7a49,
  grassDark: 0x58a04e,
  bedSide: 0x5a3b4c,
  soil: 0x7a5238,
  bark: 0x8a5a3c,
  cut: 0xe2b27a,
  canopy: 0x4fb96a,
  canopyLight: 0x7fd46c,
  hill: 0x3a2f7a,
  hillFar: 0x2c2466,
  stem: 0x7cc24f,
  oldLeaf: 0xc2c95a,
};

const mat = (color: number, extra: Partial<ConstructorParameters<typeof MeshStandardMaterial>[0]> = {}): MeshStandardMaterial =>
  new MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, flatShading: true, ...extra });

// One set of geometries and materials shared by every plant, so a garden of many plots stays cheap.
function makeKit() {
  const leaf = new SphereGeometry(1, 8, 5);
  leaf.scale(0.15, 0.028, 0.07);
  leaf.translate(0.15, 0, 0);
  const petal = new SphereGeometry(1, 8, 5);
  petal.scale(0.17, 0.035, 0.095);
  petal.translate(0.16, 0, 0);
  const mound = new SphereGeometry(0.4, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2);
  mound.scale(1, 0.38, 1);
  return {
    geo: {
      mound,
      seed: new SphereGeometry(0.13, 12, 8).scale(1, 0.72, 0.72),
      stemShort: new CylinderGeometry(0.028, 0.04, 0.55, 6).translate(0, 0.275, 0),
      stemTall: new CylinderGeometry(0.03, 0.045, 1.0, 6).translate(0, 0.5, 0),
      leaf,
      petal,
      core: new SphereGeometry(0.1, 10, 7),
      trunk: new CylinderGeometry(0.07, 0.13, 0.85, 7).translate(0, 0.425, 0),
      canopy: new IcosahedronGeometry(0.55, 1),
      lump: new IcosahedronGeometry(0.34, 0),
      fruit: new SphereGeometry(0.11, 10, 7),
      stump: new CylinderGeometry(0.13, 0.17, 0.28, 9).translate(0, 0.14, 0),
      cutFace: new CylinderGeometry(0.125, 0.125, 0.012, 9),
      ring: new RingGeometry(0.6, 0.72, 40).rotateX(-Math.PI / 2),
      hit: new CylinderGeometry(0.72, 0.72, 1.9, 8).translate(0, 0.95, 0),
    },
    mat: {
      soil: mat(C.soil),
      seed: mat(C.amber, { roughness: 0.55 }),
      stem: mat(C.stem),
      leaf: mat(C.lime, { side: DoubleSide }),
      petalA: mat(C.purple, { side: DoubleSide, roughness: 0.6 }),
      petalB: mat(C.purpleLight, { side: DoubleSide, roughness: 0.6 }),
      core: mat(C.amber, { emissive: new Color(C.amber), emissiveIntensity: 0.25 }),
      bark: mat(C.bark),
      canopy: mat(C.canopy),
      canopyLight: mat(C.canopyLight),
      fruitA: mat(C.orange, { roughness: 0.45, emissive: new Color(C.orange), emissiveIntensity: 0.12 }),
      fruitB: mat(C.amber, { roughness: 0.45, emissive: new Color(C.amber), emissiveIntensity: 0.12 }),
      cut: mat(C.cut),
      oldLeaf: mat(C.oldLeaf, { side: DoubleSide, transparent: true }),
      ring: new MeshBasicMaterial({ color: C.lime, transparent: true, opacity: 0, depthWrite: false }),
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

// --- plants --------------------------------------------------------------------------------------------------------

type Body = {
  group: Group;
  sway?: Object3D; // swings from its base
  leaves: Object3D[];
  petals: Object3D[];
  head?: Object3D;
  fruits: Object3D[];
  seed?: Object3D;
  fallingLeaf?: Mesh;
};

function leafAt(kit: Kit, y: number, yaw: number, lift: number, material: Material = kit.mat.leaf): Object3D {
  const pivot = new Group();
  pivot.position.y = y;
  pivot.rotation.y = yaw;
  const m = shadowed(new Mesh(kit.geo.leaf, material));
  m.rotation.z = lift;
  pivot.add(m);
  return pivot;
}

function buildBody(kit: Kit, p: PlantParams): Body {
  const group = new Group();
  const b: Body = { group, leaves: [], petals: [], fruits: [] };
  switch (p.stage) {
    case 'seed': {
      const seed = shadowed(new Mesh(kit.geo.seed, kit.mat.seed));
      seed.position.set(0.02, 0.17, 0.04);
      seed.rotation.z = -0.45;
      group.add(seed);
      b.seed = seed;
      break;
    }
    case 'sprout': {
      const sway = new Group();
      sway.add(shadowed(new Mesh(kit.geo.stemShort, kit.mat.stem)));
      b.leaves.push(leafAt(kit, 0.5, 0.3, 0.55), leafAt(kit, 0.42, Math.PI + 0.3, 0.45));
      sway.add(...b.leaves);
      sway.position.y = 0.12;
      group.add(sway);
      b.sway = sway;
      break;
    }
    case 'flower': {
      const sway = new Group();
      sway.add(shadowed(new Mesh(kit.geo.stemTall, kit.mat.stem)));
      b.leaves.push(leafAt(kit, 0.32, 0.2, 0.5), leafAt(kit, 0.55, Math.PI + 0.5, 0.4));
      sway.add(...b.leaves);
      const head = new Group();
      head.position.y = 1.0;
      head.rotation.x = 0.45; // face the camera a little
      for (let i = 0; i < 7; i++) {
        const pivot = new Group();
        pivot.rotation.y = (i / 7) * Math.PI * 2;
        const petal = shadowed(new Mesh(kit.geo.petal, i % 2 ? kit.mat.petalB : kit.mat.petalA));
        petal.rotation.z = 0.3;
        pivot.add(petal);
        head.add(pivot);
        b.petals.push(petal);
      }
      head.add(shadowed(new Mesh(kit.geo.core, kit.mat.core)));
      sway.add(head);
      sway.position.y = 0.12;
      group.add(sway);
      b.sway = sway;
      b.head = head;
      break;
    }
    case 'fruit': {
      group.add(shadowed(new Mesh(kit.geo.trunk, kit.mat.bark)));
      const sway = new Group();
      sway.position.y = 0.75;
      const canopy = shadowed(new Mesh(kit.geo.canopy, kit.mat.canopy));
      canopy.position.y = 0.38;
      sway.add(canopy);
      for (const [x, y, z] of [[-0.38, 0.28, 0.1], [0.36, 0.34, -0.05], [0.02, 0.72, 0.05]] as const) {
        const lump = shadowed(new Mesh(kit.geo.lump, kit.mat.canopyLight));
        lump.position.set(x, y, z);
        sway.add(lump);
      }
      // fruits sit on the front half of the canopy, spread by a golden-angle spiral
      for (let i = 0; i < p.fruits; i++) {
        const k = p.fruits === 1 ? 0.5 : i / (p.fruits - 1);
        const theta = (k - 0.5) * 1.9 + Math.sin(i * 2.39996 + p.phase) * 0.25; // around the front, left to right
        const phi = -0.35 + ((i * 0.618 + 0.3) % 1) * 0.8; // low to high
        const r = 0.6;
        const holder = new Group();
        holder.position.set(Math.sin(theta) * Math.cos(phi) * r, 0.38 + Math.sin(phi) * r, Math.cos(theta) * Math.cos(phi) * r);
        holder.add(shadowed(new Mesh(kit.geo.fruit, i % 2 ? kit.mat.fruitB : kit.mat.fruitA)));
        sway.add(holder);
        b.fruits.push(holder);
      }
      group.scale.setScalar(0.78);
      group.add(sway);
      b.sway = sway;
      break;
    }
    case 'pruned': {
      group.add(shadowed(new Mesh(kit.geo.stump, kit.mat.bark)));
      const face = new Mesh(kit.geo.cutFace, kit.mat.cut);
      face.position.y = 0.285;
      group.add(face);
      const low = leafAt(kit, 0.12, 0.8, 0.2);
      group.add(low);
      const fl = shadowed(new Mesh(kit.geo.leaf, kit.mat.oldLeaf));
      group.add(fl);
      b.fallingLeaf = fl;
      break;
    }
  }
  return b;
}

type Anim = { kind: 'grow' | 'prune'; t: number; cut?: Group };

class Plant {
  root = new Group();
  holder = new Group(); // receives the grow squash-and-stretch
  body: Body;
  ring: Mesh;
  hit: Mesh;
  anim: Anim | null = null;
  replaced: Group | null = null; // the body before a stage change, kept for a prune cut
  glow = 0;
  constructor(
    private kit: Kit,
    public p: PlantParams,
  ) {
    const mound = shadowed(new Mesh(kit.geo.mound, kit.mat.soil), true, true);
    this.ring = new Mesh(kit.geo.ring, kit.mat.ring.clone());
    this.ring.position.y = 0.015;
    this.hit = new Mesh(kit.geo.hit, kit.mat.hit);
    this.hit.userData.plotId = p.id;
    this.body = buildBody(kit, p);
    this.holder.add(this.body.group);
    this.root.add(mound, this.ring, this.holder, this.hit);
    this.root.position.set(p.x, 0, p.z);
  }
  set(p: PlantParams): void {
    const changed = p.stage !== this.p.stage || p.fruits !== this.p.fruits;
    const wasStage = this.p.stage;
    this.p = p;
    this.root.position.set(p.x, 0, p.z);
    if (!changed) return;
    this.holder.remove(this.body.group);
    this.replaced = wasStage !== p.stage ? this.body.group : null;
    this.body = buildBody(this.kit, p);
    this.holder.add(this.body.group);
  }
  dispose(): void {
    (this.ring.material as Material).dispose();
  }
}

// --- particles -----------------------------------------------------------------------------------------------------

function dotTexture(): DataTexture {
  const n = 32;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2);
      const a = Math.max(0, 1 - d) ** 1.8;
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  const t = new DataTexture(data, n, n);
  t.needsUpdate = true;
  return t;
}

type Burst = { obj: Object3D; t: number; life: number; step(dt: number, t: number): void; dispose(): void };

function sparkles(dot: DataTexture, at: Vector3, color: number, count = 26): Burst {
  const pos = new Float32Array(count * 3);
  const vel: Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const up = 0.6 + ((i * 37) % 11) / 11;
    vel.push(new Vector3(Math.cos(a) * 1.1, up * 1.8, Math.sin(a) * 1.1));
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const m = new PointsMaterial({ color, size: 0.22, map: dot, transparent: true, depthWrite: false, blending: AdditiveBlending });
  const pts = new Points(geo, m);
  pts.position.copy(at);
  pts.frustumCulled = false;
  return {
    obj: pts,
    t: 0,
    life: 1.2,
    step(_dt, t) {
      const attr = geo.getAttribute('position') as Float32BufferAttribute;
      for (let i = 0; i < count; i++) {
        const v = vel[i];
        attr.setXYZ(i, v.x * t, v.y * t - 1.4 * t * t, v.z * t);
      }
      attr.needsUpdate = true;
      m.opacity = 1 - clamp01(t / 1.2) ** 2;
      m.size = 0.22 * (1 - 0.5 * clamp01(t / 1.2));
    },
    dispose() {
      geo.dispose();
      m.dispose();
    },
  };
}

// Small flat pieces that fall and spin: confetti over the bed, or leaves from a cut plant.
function flutter(geo: BufferGeometry, colors: number[], count: number, origin: Vector3, spread: number, up: number, life: number, side: boolean): Burst {
  const material = new MeshBasicMaterial({ side: side ? DoubleSide : undefined, transparent: true });
  const mesh = new InstancedMesh(geo, material, count);
  mesh.frustumCulled = false;
  const seeds = Array.from({ length: count }, (_, i) => {
    const r = (k: number): number => ((Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
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
const PLANT_SCALE = 1.3;

function roundedBed(w: number, d: number): ExtrudeGeometry {
  const r = Math.min(0.9, w / 3, d / 3);
  const s = new Shape();
  const x = -w / 2;
  const y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r);
  s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d);
  s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const g = new ExtrudeGeometry(s, { depth: 0.35, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.12, bevelSegments: 3, curveSegments: 8 });
  g.rotateX(Math.PI / 2); // extrude downwards from y = 0
  g.translate(0, -0.12, 0); // the top bevel ends at y = 0
  return g;
}

export function createGardenScene(canvas: HTMLCanvasElement, opts: SceneOptions): GardenScene {
  const win = opts.win;
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'default' });
  renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  // VSM rather than PCF: PCF shadows rendered the whole scene dark in iOS Safari (WebKit), VSM renders correctly there
  renderer.shadowMap.type = VSMShadowMap;

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 2, 0.1, 80);
  const kit = makeKit();
  const dot = dotTexture();

  scene.add(new HemisphereLight(0xc9bfff, 0x3b2a1f, 1.35));
  const sun = new DirectionalLight(0xffe0b0, 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.radius = 4;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  const rim = new DirectionalLight(C.purple, 1.1);
  rim.position.set(-5, 3, -6);
  scene.add(rim);

  // distant soft hills behind the bed
  const hills = new Group();
  const hillGeo = new SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  const hillMats = [mat(C.hill), mat(C.hillFar)];
  for (const [x, z, sx, sy, k] of [[-6, -11, 7, 1.2, 1], [5, -12, 8, 1.6, 1], [-1, -9.5, 6, 0.8, 0], [10, -10, 6, 1.0, 0], [-12, -9.5, 6, 1.0, 0]] as const) {
    const h = new Mesh(hillGeo, hillMats[k]);
    h.position.set(x, -0.6, z);
    h.scale.set(sx, sy, sx * 0.5);
    hills.add(h);
  }
  scene.add(hills);

  // warm fireflies drifting over the garden
  const FLIES = 28;
  const flyGeo = new BufferGeometry();
  flyGeo.setAttribute('position', new Float32BufferAttribute(new Float32Array(FLIES * 3), 3));
  const flyMat = new PointsMaterial({ color: C.amber, size: 0.12, map: dot, transparent: true, depthWrite: false, blending: AdditiveBlending, opacity: 0.85 });
  const flies = new Points(flyGeo, flyMat);
  flies.frustumCulled = false;
  scene.add(flies);

  let bed: Mesh | null = null;
  const bedSideMat = mat(C.bedSide);
  const grassMat = mat(C.grass);
  const tuftMat = mat(C.grassDark);
  const tufts = new Group();
  scene.add(tufts);

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

  const layoutBed = (p: SceneParams): void => {
    const w = p.width + 0.6;
    const d = p.depth + 0.7;
    if (bed) {
      scene.remove(bed);
      bed.geometry.dispose();
    }
    // group 0 of an extrusion is its caps (the grass on top), group 1 its sides (the earth)
    bed = shadowed(new Mesh(roundedBed(w, d), [grassMat, bedSideMat]), false, true);
    scene.add(bed);
    // a few grass tufts along the rim, decoration only
    tufts.clear();
    const cone = new CylinderGeometry(0, 0.035, 0.22, 4).translate(0, 0.11, 0);
    const n = Math.round((w + d) * 3);
    for (let i = 0; i < n; i++) {
      const f = i / n;
      const per = 2 * (w + d);
      let s = f * per;
      let x: number, z: number;
      if (s < w) [x, z] = [-w / 2 + s, -d / 2 + 0.12];
      else if ((s -= w) < d) [x, z] = [w / 2 - 0.12, -d / 2 + s];
      else if ((s -= d) < w) [x, z] = [w / 2 - s, d / 2 - 0.12];
      else [x, z] = [-w / 2 + 0.12, d / 2 - (s - w)];
      for (let k = 0; k < 3; k++) {
        const t = shadowed(new Mesh(cone, tuftMat));
        t.position.set(x + (k - 1) * 0.05, 0, z + ((k * 13 + i) % 3 - 1) * 0.03);
        t.rotation.set(((i + k) % 3 - 1) * 0.25, 0, (k - 1) * 0.35);
        t.scale.y = 0.7 + ((i * 7 + k * 3) % 5) * 0.15;
        tufts.add(t);
      }
    }
    sun.position.set(w * 0.4 + 3, 7, d * 0.4 + 4);
    const cam = sun.shadow.camera;
    const ext = Math.max(w, d) / 2 + 1.5;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    cam.near = 0.5;
    cam.far = 25;
    cam.updateProjectionMatrix();
    hills.scale.setScalar(Math.max(1, w / 7));
    elevation = elevationFor(p.rows);
    camDist = cameraDistance(p.width, p.depth, aspect, FOV, elevation);
  };

  const rebuild = (): void => {
    if (!view) return;
    const prevShape = params ? `${params.cols}x${params.rows}` : '';
    params = sceneParams(view, aspect);
    if (`${params.cols}x${params.rows}` !== prevShape || !bed) layoutBed(params);
    else camDist = cameraDistance(params.width, params.depth, aspect, FOV, elevation);
    const keep = new Set(params.plants.map((p) => p.id));
    for (const [id, pl] of plants)
      if (!keep.has(id)) {
        scene.remove(pl.root);
        pl.dispose();
        plants.delete(id);
      }
    for (const p of params.plants) {
      const pl = plants.get(p.id);
      if (pl) pl.set(p);
      else {
        const np = new Plant(kit, p);
        plants.set(p.id, np);
        scene.add(np.root);
      }
    }
  };

  const placeCamera = (t: number): void => {
    const az = opts.still ? 0 : Math.sin(t * 0.11) * 0.07;
    const el = elevation + (opts.still ? 0 : Math.sin(t * 0.083) * 0.025);
    camera.position.set(Math.sin(az) * Math.cos(el) * camDist, Math.sin(el) * camDist + 0.3, Math.cos(az) * Math.cos(el) * camDist);
    camera.lookAt(0, 0.55, 0);
  };

  const flyPos = flyGeo.getAttribute('position') as Float32BufferAttribute;
  const animate = (t: number, dt: number): void => {
    // fireflies
    const w = params ? params.width + 1 : 4;
    const d = params ? params.depth + 1 : 2;
    for (let i = 0; i < FLIES; i++) {
      const a = i * 1.618;
      flyPos.setXYZ(i, Math.sin(t * 0.13 + a * 3) * w * 0.55, 0.6 + ((i * 0.37) % 1.8) + Math.sin(t * 0.7 + a) * 0.25, Math.cos(t * 0.11 + a * 2) * d * 0.6);
    }
    flyPos.needsUpdate = true;
    flyMat.opacity = 0.55 + 0.3 * Math.sin(t * 1.3);

    for (const pl of plants.values()) {
      const ph = pl.p.phase;
      const b = pl.body;
      // highlight glow
      const target = pl.p.id === highlighted || pl.p.id === hovered ? 1 : 0;
      pl.glow += (target - pl.glow) * Math.min(1, dt * 10);
      (pl.ring.material as MeshBasicMaterial).opacity = pl.glow * 0.85;
      const hs = 1 + pl.glow * 0.07;
      // idle motion, each plant with its own phase
      if (b.seed) {
        const s = 1 + 0.07 * Math.sin(t * 2.4 + ph);
        b.seed.scale.set(s, 2 - s, s);
      }
      if (b.sway) {
        const amp = pl.p.stage === 'fruit' ? 0.025 : 0.09;
        b.sway.rotation.z = Math.sin(t * 1.5 + ph) * amp;
        b.sway.rotation.x = Math.sin(t * 1.1 + ph * 1.7) * amp * 0.5;
      }
      b.leaves.forEach((l, i) => (l.rotation.x = Math.sin(t * 2.2 + ph + i * 1.3) * 0.12));
      if (b.petals.length) {
        const open = pl.anim?.kind === 'grow' ? clamp01(pl.anim.t / 1.1) : 1;
        b.petals.forEach((pt, i) => (pt.rotation.z = 1.25 - open * (1.0 - 0.06 * Math.sin(t * 1.8 + ph + i * 0.6))));
        if (b.head) b.head.rotation.y = Math.sin(t * 0.6 + ph) * 0.25;
      }
      b.fruits.forEach((f, i) => (f.position.y += (Math.sin(t * 2 + ph + i * 1.9) * 0.025 - (f.userData.bob ?? 0)), (f.userData.bob = Math.sin(t * 2 + ph + i * 1.9) * 0.025)));
      if (b.fallingLeaf) {
        const cyc = 4.2;
        const u = ((t + ph) % cyc) / cyc;
        const fall = clamp01(u / 0.8);
        b.fallingLeaf.position.set(0.18 + Math.sin(fall * 9) * 0.18, 0.95 - fall * 0.85, 0.12 + Math.cos(fall * 7) * 0.08);
        b.fallingLeaf.rotation.set(Math.sin(fall * 10) * 0.8, fall * 4, Math.cos(fall * 8) * 0.6);
        const fade = u < 0.08 ? u / 0.08 : u > 0.85 ? Math.max(0, 1 - (u - 0.85) / 0.15) : 1;
        b.fallingLeaf.scale.setScalar(0.25 + 0.75 * fade);
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
          if (a.t >= 1.2) pl.anim = null;
        } else {
          const k = clamp01(a.t / 1.1);
          // the cut top tips over from its base and sinks away; the stump gives a small squash
          if (a.cut) {
            a.cut.rotation.z = -easeOutBack(Math.min(1, k * 1.3)) * 1.35;
            a.cut.position.set(k * 0.35, 0.28 - k * 0.2, 0);
            a.cut.scale.setScalar(Math.max(0.001, 1 - clamp01((k - 0.55) / 0.45)));
          }
          ({ sx, sy } = k < 0.5 ? { sx: 1 + 0.12 * Math.sin(k * Math.PI * 2), sy: 1 - 0.14 * Math.sin(k * Math.PI * 2) } : { sx: 1, sy: 1 });
          if (a.t >= 1.2) {
            if (a.cut) pl.root.remove(a.cut);
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
        scene.remove(b.obj);
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
          const b = flutter(new PlaneGeometry(0.09, 0.05), [C.lime, C.purple, C.amber, C.mint, C.purpleLight], 110, new Vector3(0, 1.4, 0.4), w + 1, 2.4, 3.2, true);
          scene.add(b.obj);
          bursts.push(b);
          continue;
        }
        const pl = plants.get(m.plotId);
        if (!pl) continue;
        const at = new Vector3(pl.p.x, 0.5, pl.p.z);
        if (m.kind === 'grow') {
          pl.anim = { kind: 'grow', t: 0 };
          pl.replaced = null;
          const b = sparkles(dot, at, C.amber);
          scene.add(b.obj);
          bursts.push(b);
        } else {
          const cut = pl.replaced;
          pl.replaced = null;
          if (cut) {
            const g = new Group();
            cut.position.set(0, -0.28, 0);
            g.add(cut);
            pl.root.add(g);
            pl.anim = { kind: 'prune', t: 0, cut: g };
          } else pl.anim = { kind: 'prune', t: 0 };
          const lg = kit.geo.leaf.clone();
          const b = flutter(lg, [C.lime, C.stem, C.oldLeaf], 14, new Vector3(pl.p.x, 0.7, pl.p.z), 0.8, 1.4, 1.8, true);
          const dispose = b.dispose;
          b.dispose = () => {
            dispose();
            lg.dispose();
          };
          scene.add(b.obj);
          bursts.push(b);
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
      for (const g of Object.values(kit.geo)) g.dispose();
      for (const m of Object.values(kit.mat)) m.dispose();
      dot.dispose();
      renderer.dispose();
    },
  };
}


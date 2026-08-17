import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import ENV_TEXTURES from '../data/env-textures.json';

/** Same serving root as block textures (kept in sync with render/voxelmesh.ts) */
const TEXTURE_BASE = 'textures/blocks/';

export type GroundTheme = 'neutral' | 'grass';

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  resizeIfNeeded: () => void;
  setGroundTheme: (theme: GroundTheme) => void;
  /** Re-reads the 3D-side colors when the UI theme changes (#144) */
  refreshTheme: () => void;
  getGroundTheme: () => GroundTheme;
}

/**
 * Reads the 3D-side colors that **change with the UI theme** from CSS (#144).
 *
 * **CSS is the source of truth.** Keeping duplicate constants on the three.js side would let
 * the UI go dark while the viewport stays bright (the promise to update both always gets
 * forgotten on one side). This is only read at startup and on theme switch, so calling
 * `getComputedStyle` each time is fine.
 */
/** Names of the colors the 3D side pulls from the theme. **Startup fails if any of these are missing from CSS** */
const THEME_COLOR_TOKENS = ['--bs-3d-background', '--bs-3d-ground-neutral', '--bs-3d-grid-main', '--bs-3d-grid-sub'] as const;

type ThemeColorToken = (typeof THEME_COLOR_TOKENS)[number];

/**
 * Reads a theme color from CSS. **No hardcoded fallback value.**
 *
 * Keeping the same color hardcoded here would let things keep running silently even after
 * the CSS token is removed, making "CSS is the source of truth" true in name only
 * (#145 review). If it can't be read, throw and surface the broken source of truth at startup.
 */
function themeColor(name: ThemeColorToken): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!value) throw new Error(`Could not read 3D color from CSS: ${name} is undefined`);
  return value;
}

/**
 * The grass theme's colors are **not hooked into the UI theme** (settled in #144).
 *
 * The grass theme depicts "a Minecraft daytime plains," which is a different thing from the
 * UI's light/dark skin. Darkening it would change how the built structure looks in daylight
 * and create a mismatch with the exported result.
 */
const GRASS_COLORS = { ground: '#3f6b3a', gridMain: 0x5f8f52, gridSub: 0x335c30 };

const GRASS_TINT = '#8fbc5a'; // Approximates the plains biome grass color (multiply tint applied to grass_top.png)

const SKY_TOP = new THREE.Color('#7ba4ff'); // Approximates Minecraft's overworld zenith color
const SKY_HORIZON = new THREE.Color('#dceeff');
const SKY_RADIUS = 900; // Comfortably smaller than camera.far=2000, comfortably larger than the ground (64 square)

/** Single-color zenith-to-horizon gradient sky (BackSide, interpolated via vertex colors). Only shown in the grass theme */
function buildSkyMesh(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(SKY_RADIUS, 24, 16);
  const pos = geometry.attributes.position!;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp((pos.getY(i) / SKY_RADIUS + 1) / 2, 0, 1);
    c.copy(SKY_HORIZON).lerp(SKY_TOP, t);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = -10; // Draws before everything else (combined with depthWrite:false, always renders at the very back)
  return mesh;
}

/** Floats a handful of flat, Minecraft-style clouds at fixed positions (no animation, static layout) */
function buildCloudsGroup(): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.88, depthWrite: false });
  const CLOUD_Y = 90;
  // [x, z, width, depth] — a fixed layout scattered pseudo-randomly around the origin
  const layout: [number, number, number, number][] = [
    [-30, -20, 18, 10],
    [10, -35, 22, 12],
    [35, 5, 16, 9],
    [-15, 25, 20, 11],
    [20, 30, 14, 8],
    [-40, 15, 16, 9],
    [0, 0, 24, 13],
    [45, -15, 15, 8],
  ];
  for (const [x, z, w, d] of layout) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 3, d), material);
    mesh.position.set(x, CLOUD_Y, z);
    group.add(mesh);
  }
  return group;
}

export function createScene(canvas: HTMLCanvasElement): SceneCtx {
  // The canvas's own clientWidth/Height ends up following the inline style that
  // renderer.setSize() writes, effectively becoming a fixed value (so it can no longer detect
  // the parent resizing), so instead read the actual size of the parent element
  // (#editor-area, the grid's center column) as the real source of truth
  const container = canvas.parentElement ?? canvas;

  // preserveDrawingBuffer: for image capture from the canvas (used by verification/screenshot features)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);

  // **Read all of them up front at startup.** Waiting until first use would mean a missing
  // color only shows up once the theme is switched. Surface a missing source of truth here instead.
  for (const token of THEME_COLOR_TOKENS) themeColor(token);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(themeColor('--bs-3d-background'));

  const camera = new THREE.PerspectiveCamera(
    60,
    container.clientWidth / container.clientHeight,
    0.1,
    2000,
  );
  camera.position.set(20, 18, 26);

  // Left click is used for tool operations, so rotate=right-drag / pan=middle-drag
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.target.set(0, 2, 0);
  controls.maxPolarAngle = Math.PI * 0.55;
  controls.minDistance = 3;
  controls.maxDistance = 300;
  controls.mouseButtons = {
    LEFT: null,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.ROTATE,
  };

  let groundTheme: GroundTheme = 'neutral';

  /** Colors used by the current ground theme. Only neutral follows the UI theme */
  function groundColors(theme: GroundTheme): { ground: string; gridMain: string; gridSub: string } {
    if (theme === 'grass') {
      return {
        ground: GRASS_COLORS.ground,
        gridMain: `#${GRASS_COLORS.gridMain.toString(16).padStart(6, '0')}`,
        gridSub: `#${GRASS_COLORS.gridSub.toString(16).padStart(6, '0')}`,
      };
    }
    return {
      ground: themeColor('--bs-3d-ground-neutral'),
      gridMain: themeColor('--bs-3d-grid-main'),
      gridSub: themeColor('--bs-3d-grid-sub'),
    };
  }

  function buildGrid(theme: GroundTheme): THREE.GridHelper {
    const colors = groundColors(theme);
    const next = new THREE.GridHelper(64, 64, new THREE.Color(colors.gridMain), new THREE.Color(colors.gridSub));
    next.position.y = 0.001;
    return next;
  }

  let grid = buildGrid('neutral');
  scene.add(grid);

  /**
   * The ground (a light plane, purely for visual purposes).
   *
   * **Doesn't render the back face** (`FrontSide`) — with double-sided rendering, the moment
   * the camera rotates below the ground, the ground would block the view and hide the whole
   * build. Looking up from below is a legitimate way to check the underside/basement of a
   * build, so we favor the floor not getting in the way.
   * The grid (`GridHelper` = lines) is visible from behind too, so the ground's position is
   * never lost.
   */
  const groundMaterial = new THREE.MeshBasicMaterial({ color: groundColors('neutral').ground, side: THREE.FrontSide });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(64, 64), groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.002;
  scene.add(ground);

  const sky = buildSkyMesh();
  sky.visible = false;
  scene.add(sky);

  const clouds = buildCloudsGroup();
  clouds.visible = false;
  scene.add(clouds);

  // Real grass texture (public/textures/ is gitignored; same policy as fetch-textures —
  // fall back to a flat color if it hasn't been fetched). It's tiled across a single flat
  // polygon, so even when it does load the cost is near zero (no extra draw calls).
  //
  // env-textures.json is the source of truth for the filename — hardcoding a string here
  // could drift from the fetch plan (scripts/gen-textures.mjs) without anyone noticing. The
  // dev server returns index.html with a 200 for nonexistent paths too, so a wrong path
  // doesn't 404; it silently becomes "decode failure → silent fallback" (this was the cause
  // of a bug where grass never appeared)
  let grassTexture: THREE.Texture | null = null;
  new THREE.TextureLoader().load(
    TEXTURE_BASE + ENV_TEXTURES.grassTop,
    (tex) => {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(64, 64); // Match the scale of the 64-square ground = one repeat per block
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      grassTexture = tex;
      if (groundTheme === 'grass') applyGroundAppearance();
    },
    undefined,
    () => {
      // Not fetched → stays flat-colored (same fallback policy as other block textures)
    },
  );

  function applyGroundAppearance(): void {
    if (groundTheme === 'grass' && grassTexture) {
      groundMaterial.map = grassTexture;
      groundMaterial.color.set(GRASS_TINT); // Bedrock's grass_top is grayscale-based (tinted per biome at runtime), so multiply in green
    } else {
      groundMaterial.map = null;
      groundMaterial.color.set(groundColors(groundTheme).ground);
    }
    groundMaterial.needsUpdate = true;
  }

  function setGroundTheme(theme: GroundTheme): void {
    groundTheme = theme;
    applyGroundAppearance();
    sky.visible = theme === 'grass';
    clouds.visible = theme === 'grass';
    replaceGrid();
  }

  function replaceGrid(): void {
    scene.remove(grid);
    grid.geometry.dispose();
    (grid.material as THREE.Material).dispose();
    grid = buildGrid(groundTheme);
    scene.add(grid);
  }

  /**
   * Re-derives the 3D side because the screen theme changed (#144).
   *
   * **Leave the ground and grid alone in the grass theme** — the promise is that it stays the daytime look
   */
  function refreshTheme(): void {
    scene.background = new THREE.Color(themeColor('--bs-3d-background'));
    if (groundTheme === 'grass') return;
    applyGroundAppearance();
    replaceGrid();
  }


  const ambient = new THREE.AmbientLight(0xffffff, 0.65);
  scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(40, 70, 25);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x8899bb, 0.35);
  fill.position.set(-30, 40, -40);
  scene.add(fill);

  return {
    renderer,
    scene,
    camera,
    controls,
    resizeIfNeeded,
    setGroundTheme,
    refreshTheme,
    getGroundTheme: () => groundTheme,
  };

  // There are cases (e.g. embedded browsers) where the container size starts at 0, so track
  // it by checking every frame instead of relying on a resize event
  function resizeIfNeeded(): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x === w && size.y === h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
}

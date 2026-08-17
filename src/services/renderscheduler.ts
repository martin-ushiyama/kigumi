/** The minimal contract for a mesh with a dirty flag (voxelMesh/voxelEdges/voidEdges) */
export interface DirtyMesh {
  markDirty: () => void;
  update: () => void;
}

/** The minimal contract for an object with no dirty flag whose update() is just called every frame (selectionOverlay) */
export interface FrameUpdatable {
  update: () => void;
}

/**
 * The browser time/scheduling API that `start()` needs, carved out as a port
 *. RenderScheduler itself (this file) depends only on this port and
 * never touches concrete `performance` / `document` / `requestAnimationFrame` / `setTimeout`
 * entities — the implementation (`createBrowserFrameClock`, `./renderscheduler-clock-browser.ts`)
 * is assembled and injected only by main.ts (composition root, same policy as ProjectService's `ProjectIO`).
 */
export interface FrameClock {
  /** Current time (ms). Used for dt calculation */
  now: () => number;
  /** Whether the tab is hidden (a state where rAF stops) */
  isHidden: () => boolean;
  /** Calls cb once on the next frame (while visible) */
  requestFrame: (cb: () => void) => void;
  /** Calls cb once after ms (low-frequency drive while hidden) */
  scheduleTimeout: (cb: () => void, ms: number) => void;
}

export interface RenderSchedulerOpts {
  voxelMesh: DirtyMesh;
  voxelEdges: DirtyMesh;
  voidEdges: DirtyMesh;
  selectionOverlay: FrameUpdatable;
  /** ctx.resizeIfNeeded (render/scene.ts, tracks container size changes) */
  resizeIfNeeded: () => void;
  /** cameraKeys.update (input/camerakeys.ts, advances camera movement from WASD/arrow keys etc. by dt seconds) */
  updateCameraKeys: (dt: number) => void;
  /** ctx.controls.update (OrbitControls damping/inertia update) */
  controlsUpdate: () => void;
  /** ctx.renderer.render(ctx.scene, ctx.camera) turned into a closure on the main.ts (composition
   *  root) side. Never brings the THREE.js Scene/Camera/Renderer types themselves into this service */
  renderScene: () => void;
  /** The time/scheduling port. main.ts injects `createBrowserFrameClock()` directly */
  clock: FrameClock;
}

export interface RenderScheduler {
  /** On world/doc change: marks every mesh (voxelMesh/voxelEdges/voidEdges) dirty */
  markDirty: () => void;
  /** One frame's worth of update/render. Expected to be called from requestAnimationFrame, but
   *  since the timestamp can be passed in from outside it can also be driven directly from unit tests */
  tick: (now: number) => void;
  /** Starts the requestAnimationFrame loop (switches to a low-frequency setTimeout drive while the tab is hidden) */
  start: () => void;
}

/** Dirty notification / render scheduling extracted from main.ts. Behavior is unchanged */
export function createRenderScheduler(opts: RenderSchedulerOpts): RenderScheduler {
  const {
    voxelMesh,
    voxelEdges,
    voidEdges,
    selectionOverlay,
    resizeIfNeeded,
    updateCameraKeys,
    controlsUpdate,
    renderScene,
    clock,
  } = opts;

  function markDirty(): void {
    voxelMesh.markDirty();
    voxelEdges.markDirty();
    voidEdges.markDirty();
  }

  let lastTime = 0;

  function tick(now: number): void {
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    resizeIfNeeded();
    // These are no-ops driven by the dirty flag, so it's fine to call them every frame
    voxelMesh.update();
    voxelEdges.update();
    voidEdges.update();
    selectionOverlay.update();
    updateCameraKeys(dt);
    controlsUpdate();
    renderScene();
  }

  function start(): void {
    lastTime = clock.now();
    function loop(): void {
      // rAF stops while the tab is hidden, so switch to a low-frequency drive via setTimeout
      if (clock.isHidden()) clock.scheduleTimeout(loop, 50);
      else clock.requestFrame(loop);
      tick(clock.now());
    }
    loop();
  }

  return { markDirty, tick, start };
}

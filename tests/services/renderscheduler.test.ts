import { describe, expect, it, vi } from 'vitest';
import { createRenderScheduler, type DirtyMesh, type FrameClock, type FrameUpdatable } from '../../src/services/renderscheduler';

type VoidFn = ReturnType<typeof vi.fn<() => void>>;

function fakeDirtyMesh(): DirtyMesh & { markDirty: VoidFn; update: VoidFn } {
  return { markDirty: vi.fn(), update: vi.fn() };
}

function fakeFrameUpdatable(): FrameUpdatable & { update: VoidFn } {
  return { update: vi.fn() };
}

/**
 * A synchronous fake for FrameClock. requestFrame/scheduleTimeout use no real timer, just
 * collect the scheduled callbacks into an array (#14 PR4 review finding: turned start()'s
 * time/scheduling into a port, and unit-tested that "tick and rescheduling happen after
 * the callback fires" using the fire* helpers).
 */
function fakeClock() {
  let time = 0;
  let hidden = false;
  const requestFrameCalls: (() => void)[] = [];
  const scheduleTimeoutCalls: { cb: () => void; ms: number }[] = [];

  const clock: FrameClock = {
    now: () => time,
    isHidden: () => hidden,
    requestFrame: (cb) => requestFrameCalls.push(cb),
    scheduleTimeout: (cb, ms) => scheduleTimeoutCalls.push({ cb, ms }),
  };

  return {
    clock,
    setTime: (t: number) => {
      time = t;
    },
    setHidden: (h: boolean) => {
      hidden = h;
    },
    requestFrameCalls,
    scheduleTimeoutCalls,
    /** Pops the oldest requestFrame reservation and fires it */
    fireOldestRequestFrame: () => {
      const cb = requestFrameCalls.shift();
      cb?.();
    },
    /** Pops the oldest scheduleTimeout reservation and fires it */
    fireOldestTimeout: () => {
      const entry = scheduleTimeoutCalls.shift();
      entry?.cb();
    },
  };
}

function setup() {
  const voxelMesh = fakeDirtyMesh();
  const voxelEdges = fakeDirtyMesh();
  const voidEdges = fakeDirtyMesh();
  const selectionOverlay = fakeFrameUpdatable();
  const resizeIfNeeded = vi.fn();
  const updateCameraKeys = vi.fn();
  const controlsUpdate = vi.fn();
  const renderScene = vi.fn();
  const clockFake = fakeClock();

  const scheduler = createRenderScheduler({
    voxelMesh,
    voxelEdges,
    voidEdges,
    selectionOverlay,
    resizeIfNeeded,
    updateCameraKeys,
    controlsUpdate,
    renderScene,
    clock: clockFake.clock,
  });

  return {
    scheduler,
    voxelMesh,
    voxelEdges,
    voidEdges,
    selectionOverlay,
    resizeIfNeeded,
    updateCameraKeys,
    controlsUpdate,
    renderScene,
    clockFake,
  };
}

describe('RenderScheduler — markDirty', () => {
  it('marks voxelMesh/voxelEdges/voidEdges dirty', () => {
    const { scheduler, voxelMesh, voxelEdges, voidEdges } = setup();

    scheduler.markDirty();

    expect(voxelMesh.markDirty).toHaveBeenCalledTimes(1);
    expect(voxelEdges.markDirty).toHaveBeenCalledTimes(1);
    expect(voidEdges.markDirty).toHaveBeenCalledTimes(1);
  });
});

describe('RenderScheduler — tick', () => {
  it('calls resize / mesh updates / camera-key updates / scene render every frame', () => {
    const { scheduler, voxelMesh, voxelEdges, voidEdges, selectionOverlay, resizeIfNeeded, updateCameraKeys, controlsUpdate, renderScene } =
      setup();

    scheduler.tick(1000);

    expect(resizeIfNeeded).toHaveBeenCalledTimes(1);
    expect(voxelMesh.update).toHaveBeenCalledTimes(1);
    expect(voxelEdges.update).toHaveBeenCalledTimes(1);
    expect(voidEdges.update).toHaveBeenCalledTimes(1);
    expect(selectionOverlay.update).toHaveBeenCalledTimes(1);
    expect(updateCameraKeys).toHaveBeenCalledTimes(1);
    expect(controlsUpdate).toHaveBeenCalledTimes(1);
    expect(renderScene).toHaveBeenCalledTimes(1);
  });

  it('passes dt as the elapsed seconds since the last tick, clamped to a 0.1 second ceiling', () => {
    const { scheduler, updateCameraKeys } = setup();

    scheduler.tick(1000); // first call (starting from lastTime=0, so the elapsed time is always clamped to 0.1)
    scheduler.tick(1050); // 50ms elapsed -> 0.05 seconds

    expect(updateCameraKeys).toHaveBeenLastCalledWith(0.05);
  });

  it('clamps to 0.1 seconds when the elapsed time exceeds 0.1 seconds (guards against big jumps like returning from a hidden tab)', () => {
    const { scheduler, updateCameraKeys } = setup();

    scheduler.tick(1000);
    scheduler.tick(5000); // 4 seconds elapsed

    expect(updateCameraKeys).toHaveBeenLastCalledWith(0.1);
  });
});

describe('RenderScheduler — start (clock port)', () => {
  it('while visible, schedules the next frame via requestFrame and never uses setTimeout. The first tick also runs synchronously', () => {
    const { scheduler, resizeIfNeeded, clockFake } = setup();
    clockFake.setTime(1000);

    scheduler.start();

    expect(clockFake.requestFrameCalls).toHaveLength(1);
    expect(clockFake.scheduleTimeoutCalls).toHaveLength(0);
    expect(resizeIfNeeded).toHaveBeenCalledTimes(1); // the first frame's tick runs synchronously right after start()
  });

  it('while hidden, schedules via scheduleTimeout(50ms) and never uses requestFrame', () => {
    const { scheduler, clockFake } = setup();
    clockFake.setHidden(true);

    scheduler.start();

    expect(clockFake.scheduleTimeoutCalls).toHaveLength(1);
    expect(clockFake.scheduleTimeoutCalls[0]?.ms).toBe(50);
    expect(typeof clockFake.scheduleTimeoutCalls[0]?.cb).toBe('function');
    expect(clockFake.requestFrameCalls).toHaveLength(0);
  });

  it('after the requestFrame callback fires, the next tick runs and reschedules another requestFrame (stays visible)', () => {
    const { scheduler, resizeIfNeeded, updateCameraKeys, clockFake } = setup();
    clockFake.setTime(1000);
    scheduler.start();

    clockFake.setTime(1016); // roughly 1 frame later (16ms)
    clockFake.fireOldestRequestFrame();

    expect(resizeIfNeeded).toHaveBeenCalledTimes(2); // 1 from right after start() + 1 after the callback fires
    expect(updateCameraKeys).toHaveBeenLastCalledWith(0.016);
    expect(clockFake.requestFrameCalls).toHaveLength(1); // the next frame's worth is rescheduled after firing
    expect(clockFake.scheduleTimeoutCalls).toHaveLength(0);
  });

  it('when visibility switches from visible to hidden, the next reschedule moves to scheduleTimeout (switches to low-frequency driving)', () => {
    const { scheduler, clockFake } = setup();
    clockFake.setTime(1000);
    scheduler.start();
    expect(clockFake.requestFrameCalls).toHaveLength(1);

    clockFake.setHidden(true);
    clockFake.setTime(1016);
    clockFake.fireOldestRequestFrame();

    expect(clockFake.requestFrameCalls).toHaveLength(0);
    expect(clockFake.scheduleTimeoutCalls).toHaveLength(1);
    expect(clockFake.scheduleTimeoutCalls[0]?.ms).toBe(50);
    expect(typeof clockFake.scheduleTimeoutCalls[0]?.cb).toBe('function');
  });

  it('after the scheduleTimeout callback fires, tick likewise runs and reschedules (stays hidden)', () => {
    const { scheduler, resizeIfNeeded, clockFake } = setup();
    clockFake.setHidden(true);
    clockFake.setTime(1000);
    scheduler.start();

    clockFake.setTime(1050);
    clockFake.fireOldestTimeout();

    expect(resizeIfNeeded).toHaveBeenCalledTimes(2);
    expect(clockFake.scheduleTimeoutCalls).toHaveLength(1); // rescheduled via scheduleTimeout again after firing
    expect(clockFake.requestFrameCalls).toHaveLength(0);
  });
});

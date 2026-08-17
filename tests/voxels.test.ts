import { describe, expect, it, vi } from 'vitest';
import { VoxelWorld, type WorldChange } from '../src/core/voxels';

describe('VoxelWorld — subscribe/notify', () => {
  it('subscribe returns an unsubscribe function, and calling it stops further notifications', () => {
    const world = new VoxelWorld();
    const fn = vi.fn();
    const unsubscribe = world.subscribe(fn);
    world.stage({ x: 0, y: 0, z: 0, before: null, after: 1 });
    unsubscribe();
    world.stage({ x: 1, y: 0, z: 0, before: null, after: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('can subscribe multiple listeners at once (the single-callback-slot limitation of the old onChange is resolved)', () => {
    const world = new VoxelWorld();
    const a = vi.fn();
    const b = vi.fn();
    world.subscribe(a);
    world.subscribe(b);
    world.stage({ x: 0, y: 0, z: 0, before: null, after: 1 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('stage() fires a cells event once, with changedKeys for the single changed cell', () => {
    const world = new VoxelWorld();
    const events: WorldChange[] = [];
    world.subscribe((e) => events.push(e));
    world.stage({ x: 2, y: 0, z: 3, before: null, after: 5 });
    expect(events).toEqual([{ kind: 'cells', keys: ['2,0,3'] }]);
  });

  it('stageMany() notifies only once at the end even for multiple edits, with all keys in changedKeys (batch boundary)', () => {
    const world = new VoxelWorld();
    const events: WorldChange[] = [];
    world.subscribe((e) => events.push(e));
    world.stageMany([
      { x: 0, y: 0, z: 0, before: null, after: 1 },
      { x: 1, y: 0, z: 0, before: null, after: 1 },
      { x: 2, y: 0, z: 0, before: null, after: 1 },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: 'cells', keys: ['0,0,0', '1,0,0', '2,0,0'] });
  });

  it('clear() fires a clear event', () => {
    const world = new VoxelWorld();
    world.stage({ x: 0, y: 0, z: 0, before: null, after: 1 });
    const events: WorldChange[] = [];
    world.subscribe((e) => events.push(e));
    world.clear();
    expect(events).toEqual([{ kind: 'clear' }]);
    expect(world.size).toBe(0);
  });

  it('replaceAll() fires a replaceAll event', () => {
    const world = new VoxelWorld();
    const events: WorldChange[] = [];
    world.subscribe((e) => events.push(e));
    world.replaceAll([[0, 0, 0, 1]]);
    expect(events).toEqual([{ kind: 'replaceAll' }]);
    expect(world.get(0, 0, 0)).toBe(1);
  });

  it('if one listener throws, other listeners are still called and stage() itself does not throw (safety at the source, design moved to emitter)', () => {
    const world = new VoxelWorld();
    const after = vi.fn();
    world.subscribe(() => {
      throw new Error('mesh rebuild failed');
    });
    world.subscribe(after);
    expect(() => world.stage({ x: 0, y: 0, z: 0, before: null, after: 1 })).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(world.get(0, 0, 0)).toBe(1); // the write itself succeeded
  });
});

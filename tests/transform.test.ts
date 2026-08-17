import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  applyInverseTransform,
  applyTransform,
  assertValidGroupTransform,
  composeResolved,
  composeTransform,
  computePivot2,
  IDENTITY_RESOLVED,
  IDENTITY_TRANSFORM,
  inverseResolved,
  mirrorRaw,
  rebaseTransform,
  rotateRaw,
  type AngleSteps,
  type GroupTransform,
  type ResolvedTransform,
} from '../src/core/transform';
import { weirdoDirectionToYRotation } from '../src/render/geometry';
import { decodeOrientation, encodeOrientation, packCell, stairsFacingXZ, unpackCell, type Shape } from '../src/core/orientation';
import type { Cell } from '../src/core/types';

function resolved(t: GroupTransform): ResolvedTransform {
  return composeTransform(t, IDENTITY_RESOLVED);
}

function transform(partial: Partial<GroupTransform>): GroupTransform {
  return { angleSteps: 0, translate: [0, 0, 0], pivot2: [0, 0], ...partial };
}

describe('transform.ts — composing/inverting coordinate transforms and 90-degree rotation (#37)', () => {
  it('4 rotations return to identity (single transform, including pivot/translate)', () => {
    const t = transform({ angleSteps: 1, translate: [3, -2, 5], pivot2: [7, 3] });
    const cells: Cell[] = [
      [0, 0, 0],
      [5, 2, -3],
      [-4, -1, 9],
    ];
    for (const cell of cells) {
      let current = cell;
      for (let i = 0; i < 4; i++) current = applyTransform(current, resolved(t));
      // 90 degrees × 4 = 360 degrees. But translate accumulates each time, so to check
      // just the rotation component, verify with a pure rotation that has no translate
    }
    const pure = transform({ angleSteps: 1, pivot2: [7, 3] });
    for (const cell of cells) {
      let current = cell;
      for (let i = 0; i < 4; i++) current = applyTransform(current, resolved(pure));
      expect(current).toEqual(cell);
    }
  });

  it('applyInverseTransform round-trips exactly with applyTransform', () => {
    const t = transform({ angleSteps: 3, translate: [-6, 4, 2], pivot2: [5, -1] });
    const r = resolved(t);
    const cells: Cell[] = [
      [0, 0, 0],
      [10, 5, -7],
      [-3, -8, 1],
    ];
    for (const cell of cells) {
      const world = applyTransform(cell, r);
      expect(applyInverseTransform(world, r)).toEqual(cell);
    }
  });

  it('composing and inverting a 3-level parent/child chain with non-zero pivot + translation', () => {
    // 3 levels: grandchild → child → parent. Each has a different pivot / translate / rotation
    const grandchild = transform({ angleSteps: 1, translate: [2, 1, 0], pivot2: [3, 3] });
    const child = transform({ angleSteps: 2, translate: [-1, 0, 4], pivot2: [-5, 7] });
    const parent = transform({ angleSteps: 3, translate: [0, -3, -2], pivot2: [1, -9] });

    // apply outer transforms from the left in node→root order (world = T_parent(T_child(T_grandchild(local))))
    let chain = IDENTITY_RESOLVED;
    chain = composeTransform(grandchild, chain);
    chain = composeTransform(child, chain);
    chain = composeTransform(parent, chain);

    // step-by-step application matches composed application
    const local: Cell = [4, 2, -1];
    const step1 = applyTransform(local, resolved(grandchild));
    const step2 = applyTransform(step1, resolved(child));
    const step3 = applyTransform(step2, resolved(parent));
    expect(applyTransform(local, chain)).toEqual(step3);

    // the composed angleSteps is the sum mod 4
    expect(chain.angleSteps).toBe((1 + 2 + 3) % 4);

    // the inverse transform returns to the original
    expect(applyInverseTransform(step3, chain)).toEqual(local);
  });

  it('rotation direction is pinned: the cell at +X moves to -Z after step 1 (pivot at the origin)', () => {
    // pivot2=[-1,-1] is not cell (-0.5,-0.5)... rather, to make it symmetric about the origin
    // in doubled coordinates, use "the center of cell (0,0,0) = (1,1)" as the pivot and see
    // where the +X-adjacent cell moves to
    const r = resolved(transform({ angleSteps: 1, pivot2: [1, 1] }));
    // cell (1,0,0) (the +X neighbor of the pivot) should move to cell (0,0,-1) (the -Z neighbor of the pivot)
    expect(applyTransform([1, 0, 0], r)).toEqual([0, 0, -1]);
  });

  it('rotation direction matches the existing renderer\'s weirdoDirectionToYRotation (cross-checked against Three.js)', () => {
    // coordinate side: with the pivot at the origin cell's center, the +X cell moves to -Z = +Y 90-degree rotation
    const r = resolved(transform({ angleSteps: 1, pivot2: [1, 1] }));
    expect(applyTransform([1, 0, 0], r)).toEqual([0, 0, -1]);

    // display side: applying the same +Y 90-degree rotation to the +X unit vector in Three.js gives (0,0,-1)
    const v = new THREE.Vector3(1, 0, 0);
    v.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    expect(Math.round(v.x)).toBe(0);
    expect(Math.round(v.z)).toBe(-1);
  });

  it('runtime integer invariant: constructing a GroupTransform with mismatched parity directly makes applyTransform throw', () => {
    // directly construct an invalid value that bypasses assertValidGroupTransform (mixed pivot2 x/z parity)
    const bad = transform({ angleSteps: 1, pivot2: [2, 1] });
    expect(() => applyTransform([0, 0, 0], resolved(bad))).toThrow(/doesn't land on an integer cell/);
  });

  it('assertValidGroupTransform: angleSteps out of range / non-safe-integer / parity mismatch / valid values', () => {
    expect(() => assertValidGroupTransform(transform({ angleSteps: 4 as AngleSteps }))).toThrow(/angleSteps/);
    expect(() => assertValidGroupTransform(transform({ translate: [0.5, 0, 0] }))).toThrow(/translate\.x/);
    expect(() => assertValidGroupTransform(transform({ translate: [0, Number.MAX_SAFE_INTEGER + 1, 0] }))).toThrow(
      /translate\.y/,
    );
    expect(() => assertValidGroupTransform(transform({ pivot2: [2, 1] }))).toThrow(/parity/);
    expect(() => assertValidGroupTransform(transform({ pivot2: [2, 4] }))).not.toThrow(); // even/even is valid
    expect(() => assertValidGroupTransform(transform({ pivot2: [3, 1] }))).not.toThrow(); // odd/odd is also valid
    expect(() => assertValidGroupTransform(IDENTITY_TRANSFORM)).not.toThrow();
  });

  it('IDENTITY_TRANSFORM is deep frozen (translate/pivot2 cannot be rewritten either)', () => {
    expect(Object.isFrozen(IDENTITY_TRANSFORM)).toBe(true);
    expect(Object.isFrozen(IDENTITY_TRANSFORM.translate)).toBe(true);
    expect(Object.isFrozen(IDENTITY_TRANSFORM.pivot2)).toBe(true);
    expect(() => {
      (IDENTITY_TRANSFORM.translate as unknown as number[])[0] = 999;
    }).toThrow();
  });
});

describe('transform.ts — computePivot2 parity rules (#37)', () => {
  it('2×2 (even/even) keeps the true center (2,2)', () => {
    expect(computePivot2({ minX: 0, maxX: 1, minZ: 0, maxZ: 1 })).toEqual([2, 2]);
  });

  it('3×3 (odd/odd) keeps the true center (3,3)', () => {
    expect(computePivot2({ minX: 0, maxX: 2, minZ: 0, maxZ: 2 })).toEqual([3, 3]);
  });

  it('2×3 (mixed parity) snaps only the even side toward min', () => {
    // x: 0..1 (raw=2, even) / z: 0..2 (raw=3, odd) → x side gets -1
    expect(computePivot2({ minX: 0, maxX: 1, minZ: 0, maxZ: 2 })).toEqual([1, 3]);
  });

  it('3×2 (mixed parity) snaps only the even side (z)', () => {
    expect(computePivot2({ minX: 0, maxX: 2, minZ: 0, maxZ: 1 })).toEqual([3, 1]);
  });

  it('the same rule holds for negative coordinates too', () => {
    // x: -3..-1 (width 3, raw=-3, odd) / z: -4..-3 (width 2, raw=-6, even) → z side gets -1
    expect(computePivot2({ minX: -3, maxX: -1, minZ: -4, maxZ: -3 })).toEqual([-3, -7]);
    // negative even/even: x: -2..-1 (raw=-2) / z: -4..-3 (raw=-6) → kept as-is
    expect(computePivot2({ minX: -2, maxX: -1, minZ: -4, maxZ: -3 })).toEqual([-2, -6]);
  });

  it('computePivot2\'s output always satisfies applyTransform\'s integer invariant (2×2/3×3/2×3/negative coords × every step)', () => {
    const cases = [
      { minX: 0, maxX: 1, minZ: 0, maxZ: 1 },
      { minX: 0, maxX: 2, minZ: 0, maxZ: 2 },
      { minX: 0, maxX: 1, minZ: 0, maxZ: 2 },
      { minX: -3, maxX: -1, minZ: -4, maxZ: -3 },
    ];
    for (const bounds of cases) {
      const pivot2 = computePivot2(bounds);
      for (const steps of [0, 1, 2, 3] as const) {
        const r = resolved(transform({ angleSteps: steps, pivot2 }));
        for (let x = bounds.minX; x <= bounds.maxX; x++) {
          for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
            expect(() => applyTransform([x, 0, z], r)).not.toThrow();
          }
        }
      }
    }
  });
});

describe('transform.ts — 90-degree rotation of block orientation (rotateRaw) (#37)', () => {
  const shapes: Shape[] = ['full', 'slab', 'stairs'];
  const shapeOf = (catalogIndex: number): Shape | undefined => shapes[catalogIndex];

  it('stairs: weirdoDirection advances by +steps % 4 (returns to original after 4 rotations)', () => {
    const raw = packCell(2, encodeOrientation({ shape: 'stairs', weirdoDirection: 1, upsideDown: true }));
    const once = rotateRaw(raw, 1, shapeOf);
    const o = decodeOrientation('stairs', unpackCell(once).code);
    expect(o).toEqual({ shape: 'stairs', weirdoDirection: 2, upsideDown: true }); // upsideDown unchanged
    let current = raw;
    for (let i = 0; i < 4; i++) current = rotateRaw(current, 1, shapeOf);
    expect(current).toBe(raw);
  });

  it('stairs: rotates in the same world direction as the coordinate rotation (the display advances +90 degrees regardless of starting orientation)', () => {
    // weirdo_direction is **a label, not a rotation amount** (0=east / 1=west / 2=south / 3=north, from real-device measurement).
    // Which number a given d maps to at step 1 can vary by table, so instead of checking values, pin down for every
    // direction that "the displayed angle advances by the same amount as the coordinate rotation"
    const norm = (a: number): number => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    for (const d of [0, 1, 2, 3] as const) {
      const raw = packCell(2, encodeOrientation({ shape: 'stairs', weirdoDirection: d, upsideDown: false }));
      const next = decodeOrientation('stairs', unpackCell(rotateRaw(raw, 1, shapeOf)).code);
      if (next.shape !== 'stairs') throw new Error('expected stairs');
      const delta = norm(weirdoDirectionToYRotation(next.weirdoDirection) - weirdoDirectionToYRotation(d));
      expect(delta).toBeCloseTo(Math.PI / 2);
      expect(next.upsideDown).toBe(false); // a horizontal rotation never flips upside-down
    }
  });

  it('stairs: rotating the real-device-measured orientations (0=east / 1=west / 2=south / 3=north) by step 1 gives 0→3→1→2→0', () => {
    // rotating east by +Y 90 degrees gives north, rotating north gives west... this cycle was
    // pinned down by real-device verification in #114
    const rotatedOnce = (d: 0 | 1 | 2 | 3) => {
      const raw = packCell(2, encodeOrientation({ shape: 'stairs', weirdoDirection: d, upsideDown: false }));
      const o = decodeOrientation('stairs', unpackCell(rotateRaw(raw, 1, shapeOf)).code);
      if (o.shape !== 'stairs') throw new Error('expected stairs');
      return o.weirdoDirection;
    };
    expect(rotatedOnce(0)).toBe(3);
    expect(rotatedOnce(3)).toBe(1);
    expect(rotatedOnce(1)).toBe(2);
    expect(rotatedOnce(2)).toBe(0);
  });

  it('full (pillar): axis x/z swap on odd steps, stay unchanged on even steps, axis y is always unchanged', () => {
    const rawX = packCell(0, encodeOrientation({ shape: 'full', axis: 'x' }));
    const rawY = packCell(0, encodeOrientation({ shape: 'full', axis: 'y' }));
    expect(decodeOrientation('full', unpackCell(rotateRaw(rawX, 1, shapeOf)).code)).toEqual({ shape: 'full', axis: 'z' });
    expect(decodeOrientation('full', unpackCell(rotateRaw(rawX, 2, shapeOf)).code)).toEqual({ shape: 'full', axis: 'x' });
    expect(decodeOrientation('full', unpackCell(rotateRaw(rawX, 3, shapeOf)).code)).toEqual({ shape: 'full', axis: 'z' });
    expect(rotateRaw(rawY, 1, shapeOf)).toBe(rawY);
  });

  it('slab is unchanged by rotation', () => {
    const raw = packCell(1, encodeOrientation({ shape: 'slab', half: 'top' }));
    expect(rotateRaw(raw, 1, shapeOf)).toBe(raw);
    expect(rotateRaw(raw, 3, shapeOf)).toBe(raw);
  });

  it('even with steps=0, the catalog existence check still runs, returning raw unchanged when known', () => {
    const raw = packCell(0, 1);
    expect(rotateRaw(raw, 0, shapeOf)).toBe(raw);
  });

  it('if shapeOf returns undefined, throws even at steps=0 (no loophole where an unknown catalog only slips through as identity)', () => {
    const raw = packCell(99, 0);
    expect(() => rotateRaw(raw, 1, () => undefined)).toThrow(/unknown catalogIndex/);
    expect(() => rotateRaw(raw, 0, () => undefined)).toThrow(/unknown catalogIndex/);
  });
});

describe('composeResolved / inverseResolved / rebaseTransform (#37 B1b)', () => {
  const CHAINS: ResolvedTransform[] = [
    IDENTITY_RESOLVED,
    { angleSteps: 1, offsetXZ2: [4, -6], offsetY: 2 },
    { angleSteps: 2, offsetXZ2: [-10, 8], offsetY: -3 },
    { angleSteps: 3, offsetXZ2: [0, 12], offsetY: 0 },
  ];

  it('inverseResolved is the inverse element for composeResolved (both directions give identity)', () => {
    for (const r of CHAINS) {
      expect(composeResolved(inverseResolved(r), r)).toEqual(IDENTITY_RESOLVED);
      expect(composeResolved(r, inverseResolved(r))).toEqual(IDENTITY_RESOLVED);
    }
  });

  it('composeResolved matches applying transforms in sequence (world = outer(inner(local)))', () => {
    const local: Cell = [3, 1, -2];
    for (const outer of CHAINS) {
      for (const inner of CHAINS) {
        expect(applyTransform(local, composeResolved(outer, inner))).toEqual(applyTransform(applyTransform(local, inner), outer));
      }
    }
  });

  it('rebaseTransform: reparenting does not change the world position of any local cell', () => {
    const child: GroupTransform = { angleSteps: 1, translate: [2, 1, -3], pivot2: [3, 3] };
    const locals: Cell[] = [
      [0, 0, 0],
      [5, 2, -4],
      [-3, -1, 7],
    ];
    for (const oldParent of CHAINS) {
      for (const newParent of CHAINS) {
        const rebased = rebaseTransform(child, oldParent, newParent);
        for (const local of locals) {
          const before = applyTransform(local, composeResolved(oldParent, composeTransform(child, IDENTITY_RESOLVED)));
          const after = applyTransform(local, composeResolved(newParent, composeTransform(rebased, IDENTITY_RESOLVED)));
          expect(after).toEqual(before);
        }
      }
    }
  });

  it('rebaseTransform: pivot2 is preserved (reparenting does not send the rotation center flying to the origin)', () => {
    const child: GroupTransform = { angleSteps: 2, translate: [1, 0, 1], pivot2: [5, 5] };
    const rebased = rebaseTransform(child, CHAINS[1]!, CHAINS[3]!);
    expect(rebased.pivot2).toEqual([5, 5]);
  });

  it('rebaseTransform: rebasing to the same parent leaves the transform unchanged (identity)', () => {
    const child: GroupTransform = { angleSteps: 3, translate: [-2, 4, 6], pivot2: [1, 1] };
    for (const parent of CHAINS) {
      expect(rebaseTransform(child, parent, parent)).toEqual(child);
    }
  });

  it('rebaseTransform: round-trips back to the original (old→new→old)', () => {
    const child: GroupTransform = { angleSteps: 1, translate: [7, -2, 3], pivot2: [2, 2] };
    const once = rebaseTransform(child, CHAINS[1]!, CHAINS[2]!);
    const back = rebaseTransform(once, CHAINS[2]!, CHAINS[1]!);
    expect(back).toEqual(child);
  });
});

describe('transform.ts — mirroring block orientation (mirrorRaw) (#63)', () => {
  const shapes: Shape[] = ['full', 'slab', 'stairs'];
  const shapeOf = (catalogIndex: number): Shape | undefined => shapes[catalogIndex];

  function stairs(weirdoDirection: 0 | 1 | 2 | 3, upsideDown = false): number {
    return packCell(2, encodeOrientation({ shape: 'stairs', weirdoDirection, upsideDown }));
  }
  function dirOf(raw: number): { weirdoDirection: number; upsideDown: boolean } {
    const o = decodeOrientation('stairs', unpackCell(raw).code);
    if (o.shape !== 'stairs') throw new Error('expected stairs');
    return { weirdoDirection: o.weirdoDirection, upsideDown: o.upsideDown };
  }

  /**
   * The step's direction vector (the renderer's base pose d=0 = +Z, rotated d times via rotateXZ).
   * Derived the same way as mirrorRaw's internal implementation, but written independently of
   * implementation from the renderer convention "a +Y rotation maps (x,z)→(z,-x)"
   * (deliberately not copied straight from the implementation).
   */
  /** normalize -0 to 0 (toEqual distinguishes -0 from 0, so use this when building expected values) */
  const neg = (v: number): number => (v === 0 ? 0 : -v);

  // The direction definitions are **taken from the source of truth (the measured table in orientation.ts)**.
  // Keeping a copy here would let this test keep passing on a stale convention if it ever diverges
  // from the real device. Whether the table itself matches real measurements is pinned down by orientation.test.ts
  const dirXZ = (d: 0 | 1 | 2 | 3): readonly [number, number] => stairsFacingXZ(d);

  it('stairs (X mirror): flips only the x component of the step direction', () => {
    for (const d of [0, 1, 2, 3] as const) {
      const after = dirOf(mirrorRaw(stairs(d), 'x', shapeOf));
      const [dx, dz] = dirXZ(d);
      expect(dirXZ(after.weirdoDirection as 0 | 1 | 2 | 3)).toEqual([neg(dx), dz]);
      expect(after.upsideDown).toBe(false); // a horizontal mirror never changes upside-down
    }
  });

  it('stairs (Z mirror): flips only the z component of the step direction', () => {
    for (const d of [0, 1, 2, 3] as const) {
      const after = dirOf(mirrorRaw(stairs(d), 'z', shapeOf));
      const [dx, dz] = dirXZ(d);
      expect(dirXZ(after.weirdoDirection as 0 | 1 | 2 | 3)).toEqual([dx, neg(dz)]);
    }
  });

  it('stairs (Y mirror): direction is unchanged, only upsideDown flips', () => {
    for (const d of [0, 1, 2, 3] as const) {
      const after = dirOf(mirrorRaw(stairs(d, false), 'y', shapeOf));
      expect(after).toEqual({ weirdoDirection: d, upsideDown: true });
      expect(dirOf(mirrorRaw(stairs(d, true), 'y', shapeOf))).toEqual({ weirdoDirection: d, upsideDown: false });
    }
  });

  it('mirroring twice on the same axis returns to the original (all shapes / all orientations)', () => {
    const raws = [
      packCell(0, encodeOrientation({ shape: 'full', axis: 'x' })),
      packCell(0, encodeOrientation({ shape: 'full', axis: 'y' })),
      packCell(0, encodeOrientation({ shape: 'full', axis: 'z' })),
      packCell(1, encodeOrientation({ shape: 'slab', half: 'top' })),
      packCell(1, encodeOrientation({ shape: 'slab', half: 'bottom' })),
      ...([0, 1, 2, 3] as const).flatMap((d) => [stairs(d, false), stairs(d, true)]),
    ];
    for (const axis of ['x', 'y', 'z'] as const) {
      for (const raw of raws) {
        expect(mirrorRaw(mirrorRaw(raw, axis, shapeOf), axis, shapeOf)).toBe(raw);
      }
    }
  });

  it('slab: unchanged by horizontal mirroring; Y mirroring swaps top/bottom', () => {
    const top = packCell(1, encodeOrientation({ shape: 'slab', half: 'top' }));
    expect(mirrorRaw(top, 'x', shapeOf)).toBe(top);
    expect(mirrorRaw(top, 'z', shapeOf)).toBe(top);
    expect(decodeOrientation('slab', unpackCell(mirrorRaw(top, 'y', shapeOf)).code)).toEqual({
      shape: 'slab',
      half: 'bottom',
    });
  });

  it('full (pillar_axis): the axis has no sign, so it is unchanged by any mirror', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      for (const pillar of ['x', 'y', 'z'] as const) {
        const raw = packCell(0, encodeOrientation({ shape: 'full', axis: pillar }));
        expect(mirrorRaw(raw, axis, shapeOf)).toBe(raw);
      }
    }
  });

  it('an unknown catalogIndex throws, same as rotateRaw (never silently produces a wrong raw)', () => {
    expect(() => mirrorRaw(packCell(99, 0), 'x', shapeOf)).toThrow(/unknown catalogIndex/);
  });
});

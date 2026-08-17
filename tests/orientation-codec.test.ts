import { describe, expect, it } from 'vitest';
import { CATALOG } from '../src/data/blocks';
import { decodeOrientation, encodeOrientation, MAX_ORIENTATION_CODE } from '../src/core/orientation';
import { decodeStates, encodeStates, stateCountOf, stateSpaceOf } from '../src/core/orientation-codec';
import {
  foldPoseSpacesByShape,
  NON_POSE_STATES,
  poseSpaceSize,
  poseStatesOf,
  POSE_STATES,
} from '../scripts/pose-space.mjs';

/**
 * **Orientation code numbering is part of the save format** (`persistence.ts` writes `code`
 * as-is). Since the orientation space is now assembled from upstream data, this pins down
 * that the numbering doesn't shift even if the upstream declaration order changes. If this
 * table changes = the orientation of existing save files changes.
 */
describe('orientation code numbering (save format)', () => {
  const table: Array<[string, number, Record<string, unknown>]> = [
    ['full', 0, { pillar_axis: 'y' }],
    ['full', 1, { pillar_axis: 'x' }],
    ['full', 2, { pillar_axis: 'z' }],
    ['slab', 0, { 'minecraft:vertical_half': 'bottom' }],
    ['slab', 1, { 'minecraft:vertical_half': 'top' }],
    ['stairs', 0, { weirdo_direction: 0, upside_down_bit: false }],
    ['stairs', 1, { weirdo_direction: 0, upside_down_bit: true }],
    ['stairs', 2, { weirdo_direction: 1, upside_down_bit: false }],
    ['stairs', 3, { weirdo_direction: 1, upside_down_bit: true }],
    ['stairs', 4, { weirdo_direction: 2, upside_down_bit: false }],
    ['stairs', 5, { weirdo_direction: 2, upside_down_bit: true }],
    ['stairs', 6, { weirdo_direction: 3, upside_down_bit: false }],
    ['stairs', 7, { weirdo_direction: 3, upside_down_bit: true }],
  ];

  it.each(table)('%s code %d', (shape, code, states) => {
    expect(decodeStates(shape, code)).toEqual(states);
    expect(encodeStates(shape, states as Record<string, string | number | boolean>)).toBe(code);
  });

  it('the total number of assignments is closed per shape', () => {
    expect([stateCountOf('full'), stateCountOf('slab'), stateCountOf('stairs')]).toEqual([3, 2, 8]);
  });

  /**
   * `weirdo_direction` being the higher-order digit is **our own declaration** (upstream
   * lists `upside_down_bit` first). Reversing it would shift stairs orientation across the
   * whole save format.
   */
  it('for stairs, weirdo_direction is the higher-order digit (does not follow the upstream declaration order)', () => {
    expect(POSE_STATES.indexOf('weirdo_direction')).toBeLessThan(POSE_STATES.indexOf('upside_down_bit'));
  });
});

describe('orientation numbering corresponds to Orientation', () => {
  it('round-trips for every shape × every code', () => {
    for (const shape of ['full', 'slab', 'stairs'] as const) {
      for (let code = 0; code < stateCountOf(shape); code++) {
        expect(encodeOrientation(decodeOrientation(shape, code)), `${shape} ${code}`).toBe(code);
      }
    }
  });

  it('every orientation space fits within the width of an orientation code', () => {
    for (const shape of ['full', 'slab', 'stairs'] as const) {
      expect(stateCountOf(shape) - 1, shape).toBeLessThanOrEqual(MAX_ORIENTATION_CODE);
    }
  });

  it('an out-of-range code falls back to the default (never fabricates a nonexistent orientation)', () => {
    expect(decodeStates('full', 7)).toEqual({ pillar_axis: 'y' });
    expect(decodeStates('stairs', -1)).toEqual({ weirdo_direction: 0, upside_down_bit: false });
  });

  it('drops an unknown shape (never silently returns an empty assignment)', () => {
    expect(() => stateSpaceOf('door')).toThrow('Unknown shape, no orientation assignment');
  });

  it('does not let a value outside the domain through to the export', () => {
    expect(() => encodeStates('slab', { 'minecraft:vertical_half': 'middle' })).toThrow('unknown value');
  });

  /**
   * The "never silently ignore an unknown state" guarantee is upheld at generation time
   * (`poseStatesOf`), and this confirms it is not broken at the runtime entry point either
   *. **Drops both shortfalls and extras.**
   */
  it('drops it if an unknown state key is mixed in', () => {
    expect(() => encodeStates('full', { pillar_axis: 'y', open_bit: true })).toThrow('extra: open_bit');
  });

  it('drops it if a state key is missing', () => {
    expect(() => encodeStates('stairs', { weirdo_direction: 0 })).toThrow('missing: upside_down_bit');
  });

  /**
   * Since `in` also looks up the prototype chain, a name coming from Object.prototype like
   * `toString` would slip through as a "known state"
   */
  it('drops names coming from Object.prototype as unknown states too', () => {
    expect(() => encodeStates('full', { pillar_axis: 'y', toString: 'x' })).toThrow('extra: toString');
    expect(() => encodeStates('full', { pillar_axis: 'y', hasOwnProperty: 'x' })).toThrow('extra: hasOwnProperty');
  });
});

/**
 * Cross-checks the catalog (committed) against the orientation space (generated artifact).
 * **Cross-checking against upstream itself is a generation-time gate** (`gen-blocks.mjs`) —
 * the upstream file is gitignored, so CI has no real copy. Only the committed side can be
 * observed here.
 */
describe('catalog / orientation-space consistency', () => {
  it('every shape appearing in the catalog has an orientation space', () => {
    for (const shape of new Set(CATALOG.map((b) => b.shape))) {
      expect(() => stateSpaceOf(shape), shape).not.toThrow();
    }
  });

  it('every state in the orientation space is one that was declared as a pose', () => {
    for (const shape of new Set(CATALOG.map((b) => b.shape))) {
      for (const name of Object.keys(stateSpaceOf(shape))) {
        expect(POSE_STATES, `${shape}.${name}`).toContain(name);
      }
    }
  });

  it("the orientation space's key order follows POSE_STATES's order (digit-weight order)", () => {
    for (const shape of new Set(CATALOG.map((b) => b.shape))) {
      const names = Object.keys(stateSpaceOf(shape));
      const sorted = [...names].sort((a, b) => POSE_STATES.indexOf(a) - POSE_STATES.indexOf(b));
      expect(names, shape).toEqual(sorted);
    }
  });
});

describe('extracting poses from the upstream declaration', () => {
  const domains = new Map<string, (string | number | boolean)[]>([
    ['pillar_axis', ['y', 'x', 'z']],
    ['weirdo_direction', [0, 1, 2, 3]],
    ['upside_down_bit', [false, true]],
    ['deprecated', [0, 1, 2, 3]],
  ]);

  it('the domain is kept as-is from upstream (not transcribed)', () => {
    const { pose } = poseStatesOf({ properties: [{ name: 'pillar_axis' }] }, domains);
    expect(pose).toEqual({ pillar_axis: ['y', 'x', 'z'] });
  });

  it('is ordered by POSE_STATES order, not the upstream declaration order', () => {
    // upstream lists upside_down_bit first
    const { pose } = poseStatesOf(
      { properties: [{ name: 'upside_down_bit' }, { name: 'weirdo_direction' }] },
      domains,
    );
    expect(Object.keys(pose)).toEqual(['weirdo_direction', 'upside_down_bit']);
    expect(poseSpaceSize(pose)).toBe(8);
  });

  /** `bone_block` declares `deprecated` alongside `pillar_axis` */
  it('a state decided not to be a pose does not go into the orientation space', () => {
    const { pose, unknownStates } = poseStatesOf(
      { properties: [{ name: 'deprecated' }, { name: 'pillar_axis' }] },
      domains,
    );
    expect(Object.keys(pose)).toEqual(['pillar_axis']);
    expect(unknownStates).toEqual([]);
    expect(NON_POSE_STATES).toContain('deprecated');
  });

  it('reports a state that has not been judged (never silently ignores it)', () => {
    const { unknownStates } = poseStatesOf({ properties: [{ name: 'open_bit' }] }, domains);
    expect(unknownStates).toEqual(['open_bit']);
  });

  it('a block with no pose states has an empty pose', () => {
    expect(poseStatesOf({ properties: [] }, domains).pose).toEqual({});
    expect(poseSpaceSize({})).toBe(1);
  });
});

describe('folding the orientation space per shape', () => {
  const stairs = { weirdo_direction: [0, 1, 2, 3], upside_down_bit: [false, true] };

  it('blocks with the same shape fold into a single orientation space', () => {
    const { spaces, conflicts } = foldPoseSpacesByShape([
      { id: 'oak_stairs', shape: 'stairs', pose: stairs },
      { id: 'stone_stairs', shape: 'stairs', pose: stairs },
      { id: 'stone', shape: 'full', pose: {} },
    ]);
    expect(spaces).toEqual({ stairs, full: {} });
    expect(conflicts).toEqual([]);
  });

  it("a block with no pose doesn't narrow the shape's orientation space (stone and log share the same full)", () => {
    const { spaces } = foldPoseSpacesByShape([
      { id: 'stone', shape: 'full', pose: {} },
      { id: 'oak_log', shape: 'full', pose: { pillar_axis: ['y', 'x', 'z'] } },
    ]);
    expect(spaces.full).toEqual({ pillar_axis: ['y', 'x', 'z'] });
  });

  it('reports when the same shape has different orientation spaces (classification is incomplete)', () => {
    const { conflicts } = foldPoseSpacesByShape([
      { id: 'oak_stairs', shape: 'stairs', pose: stairs },
      { id: 'weird_stairs', shape: 'stairs', pose: { ...stairs, open_bit: [false, true] } },
    ]);
    expect(conflicts.join(' ')).toContain('weird_stairs');
  });
});

import { describe, expect, it } from 'vitest';
import {
  cycleFacing,
  decodeOrientation,
  defaultCode,
  encodeOrientation,
  orientationToNbtStates,
  packCell,
  rotateWeirdoDirection,
  stairsFacingXZ,
  toggleFlip,
  unpackCell,
  xzToWeirdoDirection,
  type Orientation,
} from '../src/core/orientation';

describe('packCell / unpackCell', () => {
  it('round-trips catalogIndex and code (0〜300, all 64 codes)', () => {
    for (const catalogIndex of [0, 1, 42, 124, 214, 299]) {
      for (let code = 0; code < 64; code++) {
        const packed = packCell(catalogIndex, code);
        expect(unpackCell(packed)).toEqual({ catalogIndex, code });
      }
    }
  });

  it('code is masked to 6 bits', () => {
    expect(unpackCell(packCell(5, 64)).code).toBe(0);
    expect(unpackCell(packCell(5, 127)).code).toBe(63);
  });

  /**
   * Even when the container is widened, the meaning of the code held by an existing project
   * must not change. The save format keeps the blockId string and code separately, so
   * they get re-packed via packCell on load. If code turns into a different orientation here,
   * existing works break.
   */
  it('existing codes (0〜15) round-trip with the same value unchanged', () => {
    for (let code = 0; code < 16; code++) {
      expect(unpackCell(packCell(7, code)).code).toBe(code);
    }
  });

  it("each shape's orientation meaning keeps matching the existing codes", () => {
    expect(encodeOrientation({ shape: 'full', axis: 'y' })).toBe(0);
    expect(encodeOrientation({ shape: 'slab', half: 'top' })).toBe(1);
    expect(encodeOrientation({ shape: 'stairs', weirdoDirection: 3, upsideDown: true })).toBe(7);
    expect(decodeOrientation('stairs', 7)).toEqual({ shape: 'stairs', weirdoDirection: 3, upsideDown: true });
  });
});

describe('encodeOrientation / decodeOrientation', () => {
  it('for full, codes 0/1/2 are axis y/x/z (for pillar_axis blocks, default is y)', () => {
    expect(encodeOrientation({ shape: 'full', axis: 'y' })).toBe(0);
    expect(encodeOrientation({ shape: 'full', axis: 'x' })).toBe(1);
    expect(encodeOrientation({ shape: 'full', axis: 'z' })).toBe(2);
    expect(decodeOrientation('full', 0)).toEqual({ shape: 'full', axis: 'y' });
    expect(decodeOrientation('full', 1)).toEqual({ shape: 'full', axis: 'x' });
    expect(decodeOrientation('full', 2)).toEqual({ shape: 'full', axis: 'z' });
    expect(decodeOrientation('full', 7)).toEqual({ shape: 'full', axis: 'y' }); // anything other than 0/1/2 falls back to y
  });

  it('slab round-trips bottom/top', () => {
    for (const half of ['bottom', 'top'] as const) {
      const o: Orientation = { shape: 'slab', half };
      expect(decodeOrientation('slab', encodeOrientation(o))).toEqual(o);
    }
  });

  it('stairs round-trips weirdoDirection 0-3 × upsideDown', () => {
    for (let w = 0; w < 4; w++) {
      for (const upsideDown of [false, true]) {
        const o: Orientation = { shape: 'stairs', weirdoDirection: w as 0 | 1 | 2 | 3, upsideDown };
        expect(decodeOrientation('stairs', encodeOrientation(o))).toEqual(o);
      }
    }
  });

  it('defaultCode is always 0', () => {
    expect(defaultCode('full')).toBe(0);
    expect(defaultCode('slab')).toBe(0);
    expect(defaultCode('stairs')).toBe(0);
  });
});

describe('cycleFacing / toggleFlip', () => {
  it('the stairs orientation completes one cycle in 4 steps, never repeating an orientation along the way', () => {
    // **Do not pin the numeric ordering.** 0→1→2→3 is a leftover from the mistaken premise
    // that "d is the rotation amount" — the real device's ordering is 0=east / 1=west /
    // 2=south / 3=north. What needs to be preserved is the property that
    // "each press moves to a different orientation, returning to start after 4 presses"
    let code = defaultCode('stairs');
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const o = decodeOrientation('stairs', code) as Extract<Orientation, { shape: 'stairs' }>;
      seen.push(o.weirdoDirection);
      code = cycleFacing('stairs', code);
    }
    expect(new Set(seen).size).toBe(4); // passes through all 4 directions exactly once
    expect(code).toBe(defaultCode('stairs')); // returns to the start after 4 cycles
  });

  it('the T-key orientation toggle matches the orientation you get from rotating the group 90 degrees', () => {
    // when there are 2 code paths, one can be left on the old convention. In fact,
    // only the group rotation was fixed and an extra addition was left in the T-key path
    for (const d of [0, 1, 2, 3] as const) {
      const code = encodeOrientation({ shape: 'stairs', weirdoDirection: d, upsideDown: false });
      const byKey = decodeOrientation('stairs', cycleFacing('stairs', code)) as Extract<
        Orientation,
        { shape: 'stairs' }
      >;
      expect(byKey.weirdoDirection).toBe(rotateWeirdoDirection(d, 1));
    }
  });

  it('rotating the orientation by 90 degrees at a time advances the display angle by 90 degrees at a time too', () => {
    const norm = (a: number): number => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const angleOf = (d: 0 | 1 | 2 | 3): number => {
      const [fx, fz] = stairsFacingXZ(d);
      return Math.atan2(fx, fz);
    };
    for (const d of [0, 1, 2, 3] as const) {
      expect(norm(angleOf(rotateWeirdoDirection(d, 1)) - angleOf(d))).toBeCloseTo(Math.PI / 2);
    }
  });

  it('4 rotations returns to the start, and -1 rotation equals +3 rotations', () => {
    for (const d of [0, 1, 2, 3] as const) {
      expect(rotateWeirdoDirection(d, 4)).toBe(d);
      expect(rotateWeirdoDirection(d, -1)).toBe(rotateWeirdoDirection(d, 3));
    }
  });

  it('full/slab are unaffected by cycleFacing', () => {
    expect(cycleFacing('full', 5)).toBe(5);
    expect(cycleFacing('slab', 1)).toBe(1);
  });

  it("toggleFlip toggles a slab's bottom/top", () => {
    const bottom = encodeOrientation({ shape: 'slab', half: 'bottom' });
    const top = toggleFlip('slab', bottom);
    expect(decodeOrientation('slab', top)).toEqual({ shape: 'slab', half: 'top' });
    expect(decodeOrientation('slab', toggleFlip('slab', top))).toEqual({ shape: 'slab', half: 'bottom' });
  });

  it("toggleFlip toggles a stairs' upsideDown (orientation stays the same)", () => {
    const code = encodeOrientation({ shape: 'stairs', weirdoDirection: 2, upsideDown: false });
    const flipped = toggleFlip('stairs', code);
    expect(decodeOrientation('stairs', flipped)).toEqual({ shape: 'stairs', weirdoDirection: 2, upsideDown: true });
  });

  it('toggleFlip has no effect on full', () => {
    expect(toggleFlip('full', 3)).toBe(3);
  });
});

describe('orientationToNbtStates', () => {
  it('full returns empty states for the default axis (y), and pillar_axis for x/z', () => {
    expect(orientationToNbtStates({ shape: 'full', axis: 'y' })).toEqual({});
    expect(orientationToNbtStates({ shape: 'full', axis: 'x' })).toEqual({ pillar_axis: 'x' });
    expect(orientationToNbtStates({ shape: 'full', axis: 'z' })).toEqual({ pillar_axis: 'z' });
  });

  it('slab only has minecraft:vertical_half', () => {
    expect(orientationToNbtStates({ shape: 'slab', half: 'top' })).toEqual({ 'minecraft:vertical_half': 'top' });
  });

  it('stairs has upside_down_bit + weirdo_direction', () => {
    expect(orientationToNbtStates({ shape: 'stairs', weirdoDirection: 3, upsideDown: true })).toEqual({
      upside_down_bit: true,
      weirdo_direction: 3,
    });
  });
});

/**
 * The **measured table** of stairs orientations, taken from the real device.
 *
 * This is the source of truth for blocksmith's stairs orientations. The display rotation
 * angle, group rotation, mirroring, and export are all derived from this table, so **if the
 * table drifts, everything drifts with it at once**.
 *
 * The values come from the real device, not guesswork:
 * `scripts/gen-stairs-probe.mjs` writes out a structure with directional markers embedded,
 * and it was placed in Bedrock 1.21 to check which way the tall face of the step points
 * (2026-08-01).
 *
 * It used to be assumed that "d × 90 degrees from a +Z reference pose", but on the real
 * device 0 and 1 are 180 degrees apart, and d turned out to be just a label, not a rotation amount.
 */
describe('stairs orientation — real-device measured table', () => {
  const EAST = [1, 0] as const;
  const WEST = [-1, 0] as const;
  const SOUTH = [0, 1] as const;
  const NORTH = [0, -1] as const;

  it('weirdo_direction 0=east / 1=west / 2=south / 3=north', () => {
    expect(stairsFacingXZ(0)).toEqual(EAST);
    expect(stairsFacingXZ(1)).toEqual(WEST);
    expect(stairsFacingXZ(2)).toEqual(SOUTH);
    expect(stairsFacingXZ(3)).toEqual(NORTH);
  });

  it('0 and 1 are 180 degrees apart (a reminder that this is not d × 90 degrees)', () => {
    const [ex, ez] = stairsFacingXZ(0);
    const [wx, wz] = stairsFacingXZ(1);
    expect([wx, wz]).toEqual([-ex, ez === 0 ? 0 : -ez]);
  });

  it('the inverse mapping returns to the original value', () => {
    for (const d of [0, 1, 2, 3] as const) {
      const [x, z] = stairsFacingXZ(d);
      expect(xzToWeirdoDirection(x, z)).toBe(d);
    }
  });

  it('throws for anything that is not a unit direction (never silently passes a diagonal or zero vector)', () => {
    expect(() => xzToWeirdoDirection(1, 1)).toThrow(/not a unit direction/);
    expect(() => xzToWeirdoDirection(0, 0)).toThrow(/not a unit direction/);
  });

  it('all 4 directions are distinct (no duplicates in the table)', () => {
    const seen = new Set([0, 1, 2, 3].map((d) => stairsFacingXZ(d as 0 | 1 | 2 | 3).join(',')));
    expect(seen.size).toBe(4);
  });
});

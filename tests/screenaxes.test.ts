import { describe, expect, it } from 'vitest';
import { screenAlignedNudge, type CameraBasis } from '../src/input/screenaxes';

/**
 * Makes arrow-key movement screen-relative (#147).
 *
 * What matters here is just this one point: **"does it move on screen in the pressed
 * direction?"** We build a camera basis for each viewpoint and pin down that the 4
 * directions land on the expected world axes.
 */

/** The camera basis when the camera at `eye` looks at the origin (same convention as three.js's lookAt) */
function lookingAtOrigin(eye: [number, number, number]): CameraBasis {
  const norm = (v: [number, number, number]): [number, number, number] => {
    const len = Math.hypot(...v) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  };
  const cross = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const forward = norm([-eye[0], -eye[1], -eye[2]]);
  // when looking straight up/down, forward becomes parallel to world up, so use a different reference (same workaround as three.js)
  const reference: [number, number, number] =
    Math.abs(forward[0]) < 1e-6 && Math.abs(forward[2]) < 1e-6 ? [0, 0, -1] : [0, 1, 0];
  const right = norm(cross(forward, reference));
  const up = norm(cross(right, forward));
  return { right, forward, up };
}

describe('screen-relative nudge (#147)', () => {
  it('height is always up/down regardless of viewpoint', () => {
    const basis = lookingAtOrigin([20, 18, 26]);
    expect(screenAlignedNudge('PageUp', basis)).toEqual([0, 1, 0]);
    expect(screenAlignedNudge('PageDown', basis)).toEqual([0, -1, 0]);
  });

  it('an unhandled key returns null', () => {
    expect(screenAlignedNudge('Enter', lookingAtOrigin([20, 18, 26]))).toBeNull();
  });

  /**
   * Expected values per viewpoint. **"away"** = the direction away from the camera,
   * **"right"** = screen-right. Only values that can be hand-verified from the camera's
   * position are written here
   */
  const VIEWS: readonly { name: string; eye: [number, number, number]; right: Vec3; away: Vec3 }[] = [
    // from a diagonal high point on the +X +Z side. "away" could lean toward -X or -Z, so we write the rounded result
    { name: 'default diagonal viewpoint', eye: [20, 18, 26], right: [1, 0, 0], away: [0, 0, -1] },
    // looking straight down from above. three.js's lookAt puts -Z at the top of the screen when looking straight down
    { name: 'top view', eye: [0, 40, 0], right: [1, 0, 0], away: [0, 0, -1] },
    // looking at the origin from +Z (front view). moving away = -Z
    { name: 'front view', eye: [0, 0, 40], right: [1, 0, 0], away: [0, 0, -1] },
    // looking at the origin from +X (side view). right is -Z, away is -X
    { name: 'side view', eye: [40, 0, 0], right: [0, 0, -1], away: [-1, 0, 0] },
    // going around to the opposite side flips both right and away
    { name: 'from the back', eye: [-20, 18, -26], right: [-1, 0, 0], away: [0, 0, 1] },
  ];

  for (const view of VIEWS) {
    it(`${view.name}: -> moves screen-right, up moves screen-away`, () => {
      const basis = lookingAtOrigin(view.eye);
      expect(screenAlignedNudge('ArrowRight', basis), 'right').toEqual(view.right);
      expect(screenAlignedNudge('ArrowLeft', basis), 'left').toEqual(view.right.map((n) => -n));
      expect(screenAlignedNudge('ArrowUp', basis), 'up').toEqual(view.away);
      expect(screenAlignedNudge('ArrowDown', basis), 'down').toEqual(view.away.map((n) => -n));
    });
  }

  it('rotating the viewpoint to the opposite side flips the same key to the opposite axis', () => {
    const front = screenAlignedNudge('ArrowRight', lookingAtOrigin([0, 0, 40]));
    const back = screenAlignedNudge('ArrowRight', lookingAtOrigin([0, 0, -40]));
    expect(front).toEqual([1, 0, 0]);
    expect(back).toEqual([-1, 0, 0]);
  });

  /**
   * Horizontal 45 degrees (#150 review).
   *
   * Both right and away have equal-sized X and Z components, and the rounding rule (ties go
   * to X) means **both end up landing on X**. Giving up here would make every direction stop
   * moving — and in fact, before this was fixed, all 4 directions returned null.
   */
  describe('horizontal 45 degrees and its neighborhood', () => {
    const EYES: readonly { name: string; eye: [number, number, number] }[] = [
      { name: 'exactly 45 degrees', eye: [20, 18, 20] },
      { name: 'just short of 45 degrees (leaning X)', eye: [21, 18, 20] },
      { name: 'just past 45 degrees (leaning Z)', eye: [20, 18, 21] },
      { name: 'exactly 45 degrees on the opposite side', eye: [-20, 18, -20] },
      { name: '45 degrees near straight-up', eye: [20, 200, 20] },
    ];

    for (const { name, eye } of EYES) {
      it(`${name}: all 4 directions move`, () => {
        const basis = lookingAtOrigin(eye);
        for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']) {
          const delta = screenAlignedNudge(key, basis);
          expect(delta, `${key} did not resolve`).not.toBeNull();
          // always exactly 1 cell on exactly 1 axis (never moves diagonally)
          expect(delta!.filter((n) => n !== 0)).toHaveLength(1);
        }
      });

      it(`${name}: right and away land on different axes`, () => {
        const basis = lookingAtOrigin(eye);
        const right = screenAlignedNudge('ArrowRight', basis)!;
        const away = screenAlignedNudge('ArrowUp', basis)!;
        expect((right[0] !== 0) === (away[0] !== 0)).toBe(false);
      });

      it(`${name}: left/right and up/down are opposite of each other`, () => {
        const basis = lookingAtOrigin(eye);
        const right = screenAlignedNudge('ArrowRight', basis)!;
        const left = screenAlignedNudge('ArrowLeft', basis)!;
        const up = screenAlignedNudge('ArrowUp', basis)!;
        const down = screenAlignedNudge('ArrowDown', basis)!;
        expect(left).toEqual(right.map((n) => -n));
        expect(down).toEqual(up.map((n) => -n));
      });
    }

    it('away stays pointed away from the camera even across the 45-degree boundary', () => {
      // viewed from the +X +Z side, so away is either -X or -Z leaning (either way, it moves away)
      for (const eye of [[21, 18, 20], [20, 18, 20], [20, 18, 21]] as const) {
        const away = screenAlignedNudge('ArrowUp', lookingAtOrigin([...eye]))!;
        expect(away[0] + away[2], `eye=${eye.join(',')}`).toBeLessThan(0);
      }
    });
  });

  it('right and away always land on different axes', () => {
    for (const view of VIEWS) {
      const basis = lookingAtOrigin(view.eye);
      const right = screenAlignedNudge('ArrowRight', basis)!;
      const away = screenAlignedNudge('ArrowUp', basis)!;
      expect((right[0] !== 0) === (away[0] !== 0), view.name).toBe(false);
    }
  });
});

type Vec3 = readonly [number, number, number];

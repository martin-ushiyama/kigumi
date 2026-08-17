import { describe, expect, it } from 'vitest';
import { createShapeGeometry } from '../src/render/geometry';

describe('createShapeGeometry (stairs) vertical flip', () => {
  it('X and Z stay unchanged for every vertex, only Y flips sign (regression guard: rotateX would also flip Z)', () => {
    const normal = createShapeGeometry('stairs', false);
    const flipped = createShapeGeometry('stairs', true);
    const posN = normal.getAttribute('position');
    const posF = flipped.getAttribute('position');

    expect(posF.count).toBe(posN.count);
    for (let i = 0; i < posN.count; i++) {
      expect(posF.getX(i), `vertex ${i} x`).toBeCloseTo(posN.getX(i), 6);
      expect(posF.getZ(i), `vertex ${i} z`).toBeCloseTo(posN.getZ(i), 6);
      expect(posF.getY(i), `vertex ${i} y`).toBeCloseTo(-posN.getY(i), 6);
    }
  });

  it('the Z range of the step (back half, faces with z>0 vertices) is preserved after flipping', () => {
    const normal = createShapeGeometry('stairs', false);
    const flipped = createShapeGeometry('stairs', true);
    const zRangeOfStepVertices = (geo: import('three').BufferGeometry) => {
      const pos = geo.getAttribute('position');
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        const z = pos.getZ(i);
        if (z > 0.001) {
          // Only step vertices (from the upper box): those with z greater than 0
          if (z < min) min = z;
          if (z > max) max = z;
        }
      }
      return [min, max];
    };
    expect(zRangeOfStepVertices(flipped)).toEqual(zRangeOfStepVertices(normal));
  });

  it('normal direction also flips only the Y component (paired with winding-order flip to keep front/back faces correct)', () => {
    const normal = createShapeGeometry('stairs', false);
    const flipped = createShapeGeometry('stairs', true);
    const nN = normal.getAttribute('normal');
    const nF = flipped.getAttribute('normal');
    for (let i = 0; i < nN.count; i++) {
      expect(nF.getX(i)).toBeCloseTo(nN.getX(i), 6);
      expect(nF.getZ(i)).toBeCloseTo(nN.getZ(i), 6);
      expect(nF.getY(i)).toBeCloseTo(-nN.getY(i), 6);
    }
  });

  it('triangle count per face group is unchanged before/after mirroring (winding-order flip only, no faces added or removed)', () => {
    const normal = createShapeGeometry('stairs', false);
    const flipped = createShapeGeometry('stairs', true);
    expect(flipped.groups).toEqual(normal.groups);
    expect(flipped.getIndex()!.count).toBe(normal.getIndex()!.count);
  });
});

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { TEXTURE_BASE } from '../src/core/textureframe';
import {
  encodeOrientation,
  packCell,
  type Orientation,
  type Shape,
} from '../src/core/orientation';
import { stateCountOf } from '../src/core/orientation-codec';
import { CATALOG } from '../src/data/blocks';
import { VoxelWorld } from '../src/core/voxels';
import { VoxelMesh } from '../src/render/voxelmesh';
import { renderSignatureAt, type Direction, type SubCell } from './helpers/render-signature';
import { toIndexChange } from './helpers/world-index-events';

/**
 * **Cross-checking the measured ledger against the final data reaching the screen** (#131 PR 2).
 *
 * The ledger never references product code at all. It writes directly "what should be visible
 * on screen for this pose." The observation side (`renderSignatureAt`) also only reads the
 * `InstancedMesh` inside a `THREE.Scene`, so both sides don't end up sharing the same table
 * in a structure where a round trip would pass anyway (the lesson from #114).
 *
 * ## How to read the sub-cell names
 *
 * The name for a cell split into a 2×2×2 grid. `x1y0z1` = +X side / lower half / +Z side.
 *
 * ## Faces are checked in two layers
 *
 * - `faces`: the `materialIndex` held by each face group in the geometry
 * - `faceTextures`: **the texture actually loaded onto the material that index points to**
 *
 * `faces` alone doesn't check the correspondence with the `mesh.material` array, so swapping
 * side/top and putting them into the array still passes (#139 review finding).
 * That's why we observe all the way down to the texture.
 *
 * Texture loading depends on the DOM, so it doesn't run in this environment. **To keep the
 * product's material-assignment path exercised as-is**, we pass `VoxelMesh` a loader that
 * resolves synchronously (the logic that assembles materials stays on the product side).
 */

const ALL: SubCell[] = ['x0y0z0', 'x0y0z1', 'x0y1z0', 'x0y1z1', 'x1y0z0', 'x1y0z1', 'x1y1z0', 'x1y1z1'];
const LOWER = ALL.filter((c) => c.includes('y0'));
const UPPER = ALL.filter((c) => c.includes('y1'));
const on = (cells: SubCell[], part: string) => cells.filter((c) => c.includes(part));

/** The real block used per pose. Pick ones **with different textures on the side vs. top** (so a mix-up would be visible) */
const BLOCKS: Record<Shape, { id: string; side: string; top: string }> = {
  full: { id: 'minecraft:oak_log', side: 'log_oak.png', top: 'log_oak_top.png' },
  slab: { id: 'minecraft:smooth_stone_slab', side: 'stone_slab_side.png', top: 'stone_slab_top.png' },
  stairs: { id: 'minecraft:sandstone_stairs', side: 'sandstone_normal.png', top: 'sandstone_top.png' },
};

const side = (shape: Shape) => [BLOCKS[shape].side];
const top = (shape: Shape) => [BLOCKS[shape].top];

/** Unrotated cuboid face → slot (BoxGeometry default order 0=+X 1=-X 2=+Y 3=-Y 4=+Z 5=-Z) */
const UNROTATED_FACES: Record<Direction, number[]> = {
  '+x': [0],
  '-x': [1],
  '+y': [2],
  '-y': [3],
  '+z': [4],
  '-z': [5],
};

/** Unrotated cuboid textures: the 4 side faces use side, top/bottom use top */
const unrotatedTextures = (shape: Shape): Record<Direction, string[]> => ({
  '+x': side(shape),
  '-x': side(shape),
  '+y': top(shape),
  '-y': top(shape),
  '+z': side(shape),
  '-z': side(shape),
});

/** Stairs only have 2 groups: side = 0 / top-and-bottom = 1 */
const STAIRS_FACES: Record<Direction, number[]> = {
  '+x': [0],
  '-x': [0],
  '+y': [1],
  '-y': [1],
  '+z': [0],
  '-z': [0],
};

interface LedgerEntry {
  label: string;
  orientation: Orientation;
  occupancy: SubCell[];
  faces: Record<Direction, number[]>;
  faceTextures: Record<Direction, string[]>;
}

/** For stairs, "side stays side, top/bottom stays top" even when the orientation changes */
const stairsEntry = (
  label: string,
  weirdoDirection: 0 | 1 | 2 | 3,
  upsideDown: boolean,
  occupancy: SubCell[],
): LedgerEntry => ({
  label,
  orientation: { shape: 'stairs', weirdoDirection, upsideDown },
  occupancy: [...occupancy].sort(),
  faces: STAIRS_FACES,
  faceTextures: {
    '+x': side('stairs'),
    '-x': side('stairs'),
    '+y': top('stairs'),
    '-y': top('stairs'),
    '+z': side('stairs'),
    '-z': side('stairs'),
  },
});

/** The side the step rises toward (flipping upside-down swaps top/bottom; horizontal orientation doesn't move) */
const stepOn = (part: string, flipped: boolean): SubCell[] =>
  flipped ? [...UPPER, ...on(LOWER, part)] : [...LOWER, ...on(UPPER, part)];

const LEDGER: LedgerEntry[] = [
  {
    label: 'Full · axis y (default)',
    orientation: { shape: 'full', axis: 'y' },
    occupancy: ALL,
    faces: UNROTATED_FACES,
    faceTextures: unrotatedTextures('full'),
  },
  {
    // end grain faces ±X. Occupancy is the same for any axis, so this can only be detected via faces
    label: 'Full · axis x (end grain faces ±X)',
    orientation: { shape: 'full', axis: 'x' },
    occupancy: ALL,
    faces: { '+x': [3], '-x': [2], '+y': [0], '-y': [1], '+z': [4], '-z': [5] },
    faceTextures: {
      '+x': top('full'),
      '-x': top('full'),
      '+y': side('full'),
      '-y': side('full'),
      '+z': side('full'),
      '-z': side('full'),
    },
  },
  {
    label: 'Full · axis z (end grain faces ±Z)',
    orientation: { shape: 'full', axis: 'z' },
    occupancy: ALL,
    faces: { '+x': [0], '-x': [1], '+y': [5], '-y': [4], '+z': [2], '-z': [3] },
    faceTextures: {
      '+x': side('full'),
      '-x': side('full'),
      '+y': side('full'),
      '-y': side('full'),
      '+z': top('full'),
      '-z': top('full'),
    },
  },
  {
    label: 'Half · bottom',
    orientation: { shape: 'slab', half: 'bottom' },
    occupancy: LOWER,
    faces: UNROTATED_FACES,
    faceTextures: unrotatedTextures('slab'),
  },
  {
    label: 'Half · top',
    orientation: { shape: 'slab', half: 'top' },
    occupancy: UPPER,
    faces: UNROTATED_FACES,
    faceTextures: unrotatedTextures('slab'),
  },
  // Stairs: the lower half is fully filled, and the upper half keeps only the side the step rises
  // toward. The direction the step faces per the measured table (0=east / 1=west / 2=south / 3=north)
  stairsEntry('Stairs · east (d=0)', 0, false, stepOn('x1', false)),
  stairsEntry('Stairs · west (d=1)', 1, false, stepOn('x0', false)),
  stairsEntry('Stairs · south (d=2)', 2, false, stepOn('z1', false)),
  stairsEntry('Stairs · north (d=3)', 3, false, stepOn('z0', false)),
  // Upside-down: only the top and bottom flip, **the horizontal orientation doesn't move**.
  // This is exactly the behavior confirmed on real hardware (Bedrock 1.21) on 2026-08-01 (#129).
  // **List all 4 directions** — with only some listed, breaking the wiring for that pose would
  // still pass (#139 review finding)
  stairsEntry('Stairs · east upside-down', 0, true, stepOn('x1', true)),
  stairsEntry('Stairs · west upside-down', 1, true, stepOn('x0', true)),
  stairsEntry('Stairs · south upside-down', 2, true, stepOn('z1', true)),
  stairsEntry('Stairs · north upside-down', 3, true, stepOn('z0', true)),
];

const indexOf = (id: string) => {
  const i = CATALOG.findIndex((b) => b.id === id);
  if (i < 0) throw new Error(`not in catalog: ${id}`);
  return i;
};

/** A loader that resolves synchronously. Puts the texture name into `map.name` so faces can be traced */
function stubLoader(): THREE.TextureLoader {
  const loader = new THREE.TextureLoader();
  loader.load = ((url: string, onLoad?: (texture: THREE.Texture) => void) => {
    const texture = new THREE.Texture();
    texture.name = url.startsWith(TEXTURE_BASE) ? url.slice(TEXTURE_BASE.length) : url;
    onLoad?.(texture);
    return texture;
  }) as THREE.TextureLoader['load'];
  return loader;
}

/**
 * **Exercises the product's rendering path as-is.** Calling `createShapeGeometry` directly
 * here would make this a test that never checks whether the geometry actually reaches the
 * screen.
 */
async function renderPose(orientation: Orientation) {
  const scene = new THREE.Scene();
  const world = new VoxelWorld();
  const mesh = new VoxelMesh(scene, world, CATALOG, stubLoader());
  world.subscribe((event) => mesh.onWorldChange(toIndexChange(event)));
  world.replaceAll([[0, 0, 0, packCell(indexOf(BLOCKS[orientation.shape].id), encodeOrientation(orientation))]]);
  mesh.update();
  // material application goes through a Promise (because the product's loading path is exercised as-is)
  await new Promise((resolve) => setTimeout(resolve, 0));
  return renderSignatureAt(scene, [0, 0, 0]);
}

describe('measured ledger matches the screen (#131 PR 2)', () => {
  it.each(LEDGER.map((entry) => [entry.label, entry] as const))('%s', async (_label, entry) => {
    const signature = await renderPose(entry.orientation);
    expect(signature.occupancy).toEqual([...entry.occupancy].sort());
    expect(signature.faces).toEqual(entry.faces);
    expect(signature.faceTextures).toEqual(entry.faceTextures);
  });

  /**
   * **Pins down that the ledger itself doesn't miss any part of the pose space** (#139 review
   * finding). Only 2 poses of the flipped stairs were listed, so breaking the wiring for the
   * remaining 2 poses still passed every check. The pose count is taken from PR 1's pose space
   * (used as **the denominator for coverage**, not an expected value)
   */
  it('every pose in the pose space is present in the ledger', () => {
    for (const shape of ['full', 'slab', 'stairs'] as const) {
      const codes = LEDGER.filter((e) => e.orientation.shape === shape).map((e) =>
        encodeOrientation(e.orientation),
      );
      expect(new Set(codes).size, `${shape} has a duplicate`).toBe(codes.length);
      expect(codes.length, `${shape} is missing poses`).toBe(stateCountOf(shape));
    }
  });

  /**
   * Occupancy volume alone can't verify a post's axis (#131 body text). This pins down
   * **that the ledger itself doesn't have that blind spot**.
   */
  it("a post's 3 axes can't be distinguished by occupancy volume (the reason we check faces)", () => {
    const axes = LEDGER.filter((e) => e.orientation.shape === 'full');
    expect(new Set(axes.map((e) => JSON.stringify([...e.occupancy].sort()))).size).toBe(1);
    expect(new Set(axes.map((e) => JSON.stringify(e.faceTextures))).size).toBe(3);
  });

  /** Upside-down doesn't change the horizontal orientation (confirmed on real hardware 2026-08-01, #129) */
  it('the horizontal direction the step faces stays the same even when flipped upside-down', async () => {
    const stepSide = (cells: SubCell[]) => {
      const half = cells.filter((c) => cells.filter((o) => o.slice(0, 2) === c.slice(0, 2)).length === 1);
      return new Set(half.map((c) => `${c.slice(0, 2)}${c.slice(4)}`));
    };
    for (const d of [0, 1, 2, 3] as const) {
      const normal = await renderPose({ shape: 'stairs', weirdoDirection: d, upsideDown: false });
      const flipped = await renderPose({ shape: 'stairs', weirdoDirection: d, upsideDown: true });
      expect(stepSide(normal.occupancy), `d=${d}`).toEqual(stepSide(flipped.occupancy));
    }
  });
});

import { describe, expect, it } from 'vitest';
import { loadProjectV3, serializeProjectV5 } from '../src/project/persistence';
import { CATALOG } from '../src/data/blocks';
import { MAX_ORIENTATION_CODE, packCell, unpackCell } from '../src/core/orientation';
import { makeCellKey } from '../src/core/types';
import { SceneTree } from '../src/core/scenetree';
import { OwnerVoxelStore, type EditorScene } from '../src/core/ownervoxels';
import { PatternPaintStore } from '../src/core/patternpaint';
import type { MixRecipe } from '../src/core/mixpalette';

const indexOf = (blockId: string): number | undefined => {
  const i = CATALOG.findIndex((d) => d.id === blockId);
  return i === -1 ? undefined : i;
};
const STONE = CATALOG[0]!.id;
const RECIPE: MixRecipe = { id: 'r1', name: 'Mix', entries: [{ blockId: STONE, weight: 1 }] };

/**
 * The orientation code's container only closes cleanly if both write and read use
 * the same width.
 *
 * `serializeProjectV5` writes `unpackCell(raw).code` as-is, so widening the container lets
 * it write out larger codes. If the read side is stuck on the old limit, **saving succeeds
 * but reloading rejects it**.
 *
 * Just reading hand-written JSON wouldn't exercise the write side, so we round-trip by
 * **actually building a scene, serializing it, and loading that**.
 */
describe('orientation code limit in the save format', () => {
  const codes = [0, 15, 16, 31, MAX_ORIENTATION_CODE];

  function sceneWith(code: number, withPattern: boolean): EditorScene {
    const cells = new OwnerVoxelStore();
    const raw = packCell(0, code);
    cells.set(null, makeCellKey(1, 2, 3), raw);
    const patterns = new PatternPaintStore();
    if (withPattern) {
      patterns.set(
        { ownerId: null, localCell: [1, 2, 3] },
        { recipeId: RECIPE.id, variant: 0, sourceRaw: raw, appliedRaw: raw },
      );
    }
    return { tree: new SceneTree(), cells, patterns };
  }

  it.each(codes)('a normal cell with code=%i round-trips through serialize -> load', (code) => {
    const file = serializeProjectV5('Test', sceneWith(code, false), CATALOG, []);
    // the write side did not drop the code
    expect(file.cells).toEqual([[-1, 1, 2, 3, STONE, code]]);

    // the output can be read back as-is
    const { scene, loaded, skipped } = loadProjectV3(file, indexOf);
    expect({ loaded, skipped }).toEqual({ loaded: 1, skipped: 0 });
    expect(unpackCell(scene.cells.get(null, makeCellKey(1, 2, 3))!).code).toBe(code);
  });

  it.each(codes)('a pattern with sourceOrientationCode=%i round-trips through serialize -> load', (code) => {
    const file = serializeProjectV5('Test', sceneWith(code, true), CATALOG, [RECIPE]);
    const cell = file.cells[0]!;
    const meta = cell[6];
    expect(meta, `the pattern for code=${code} was not written out`).toBeDefined();
    expect(meta!.sourceOrientationCode).toBe(code);

    const { scene } = loadProjectV3(file, indexOf);
    const paint = scene.patterns?.get(null, makeCellKey(1, 2, 3));
    expect(paint, `the pattern for code=${code} was not loaded`).toBeDefined();
    expect(unpackCell(paint!.sourceRaw).code).toBe(code);
  });

  it('rejects loading a code that exceeds the container limit', () => {
    const file = serializeProjectV5('Test', sceneWith(0, false), CATALOG, []);
    file.cells = [[-1, 1, 2, 3, STONE, MAX_ORIENTATION_CODE + 1]];
    expect(() => loadProjectV3(file, indexOf)).toThrow();
  });
});

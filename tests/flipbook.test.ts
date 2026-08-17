import { describe, expect, it } from 'vitest';
import {
  buildFlipbookMembership,
  frameCountFromSize,
  parseTextureSource,
  validateFrameIndices,
  verifyFrameStructure,
} from '../scripts/flipbook.mjs';

/**
 * The frame-count contract for animated textures.
 *
 * What is pinned down here is **structural consistency only**. PNGs are gitignored and absent in
 * CI, so "the real image really has 5 frames" cannot be verified here (that happens at fetch time).
 * The test names claim only what CI can actually guarantee.
 */

describe('frameCountFromSize — the physical frame count follows from the PNG dimensions', () => {
  it('reads 16x64 as 4 frames', () => {
    expect(frameCountFromSize({ width: 16, height: 64 })).toEqual({ ok: true, frameCount: 4 });
  });

  it('reads 16x80 as 5 frames', () => {
    expect(frameCountFromSize({ width: 16, height: 80 })).toEqual({ ok: true, frameCount: 5 });
  });

  it('reads a square as 1 frame (non-animated images take the same path)', () => {
    expect(frameCountFromSize({ width: 16, height: 16 })).toEqual({ ok: true, frameCount: 1 });
  });

  it('rejects a ratio that does not divide evenly (never slices at a partial position)', () => {
    const r = frameCountFromSize({ width: 16, height: 72 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('not an integer multiple');
  });

  it('rejects invalid dimensions', () => {
    expect(frameCountFromSize({ width: 0, height: 64 }).ok).toBe(false);
    expect(frameCountFromSize({ width: 16, height: -1 }).ok).toBe(false);
  });
});

describe('validateFrameIndices — frames is a playback sequence, not a frame count', () => {
  /** The real prismarine_rough data from upstream 921fafb0 */
  const prismarine = [0, 1, 0, 2, 0, 3, 0, 1, 2, 1, 3, 1, 0, 2, 1, 2, 3, 2, 0, 3, 1, 3];

  it('accepts a 22-element sequence as in range when there are physically 4 frames', () => {
    expect(validateFrameIndices({ frames: prismarine, frameCount: 4 })).toEqual({ ok: true });
  });

  it('does not mistake 22 elements for 22 frames (this is not a check that would pass under a physical count of 22)', () => {
    // Getting the physical count wrong as 3 puts index 3 out of range and fails = frames is validated independently
    const r = validateFrameIndices({ frames: prismarine, frameCount: 3 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('out of range');
  });

  it('skips validation for an entry without frames (crimson / warped are like this)', () => {
    expect(validateFrameIndices({ frames: null, frameCount: 5 })).toEqual({ ok: true });
    expect(validateFrameIndices({ frames: undefined, frameCount: 5 })).toEqual({ ok: true });
  });

  it('rejects an out-of-range index', () => {
    expect(validateFrameIndices({ frames: [0, 1, 9], frameCount: 4 }).ok).toBe(false);
    expect(validateFrameIndices({ frames: [-1], frameCount: 4 }).ok).toBe(false);
  });
});

describe('buildFlipbookMembership — which files are animation targets', () => {
  const entries = [
    { flipbook_texture: 'textures/blocks/prismarine_rough', frames: [0, 1, 0, 2], ticks_per_frame: 300 },
    { flipbook_texture: 'textures/blocks/huge_fungus/crimson_log_side', ticks_per_frame: 15 },
    { atlas_tile: 'broken' },
  ];

  it('can be looked up by the path with textures/blocks/ stripped', () => {
    const m = buildFlipbookMembership(entries);
    expect(m.has('prismarine_rough')).toBe(true);
    expect(m.has('huge_fungus/crimson_log_side')).toBe(true);
  });

  it('preserves whether frames is present (an absent one does not become an empty array)', () => {
    const m = buildFlipbookMembership(entries);
    expect(m.get('prismarine_rough')?.frames).toEqual([0, 1, 0, 2]);
    expect(m.get('huge_fungus/crimson_log_side')?.frames).toBeNull();
  });

  it('ignores an entry without flipbook_texture', () => {
    expect(buildFlipbookMembership(entries).size).toBe(2);
  });
});

describe('verifyFrameStructure — structural consistency is as far as CI can guarantee', () => {
  const membership = buildFlipbookMembership([
    { flipbook_texture: 'textures/blocks/prismarine_rough', frames: [0, 1, 2, 3] },
    { flipbook_texture: 'textures/blocks/huge_fungus/crimson_log_side' },
  ]);

  it('is consistent when a target file has 2 or more frames', () => {
    expect(
      verifyFrameStructure({
        membership,
        frames: { 'prismarine_rough.png': 4, 'huge_fungus/crimson_log_side.png': 5 },
      }),
    ).toEqual([]);
  });

  it('detects a frame count attached to a file that is not a flipbook target', () => {
    const p = verifyFrameStructure({ membership, frames: { 'stone.png': 4 } });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('not a flipbook member');
  });

  it('detects a target whose frame count is 1', () => {
    const p = verifyFrameStructure({ membership, frames: { 'prismarine_rough.png': 1 } });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('should be 2 or more');
  });

  it('detects an explicit sequence whose index exceeds the frame count', () => {
    const p = verifyFrameStructure({ membership, frames: { 'prismarine_rough.png': 2 } });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('out of range');
  });

  it('detects a referenced flipbook target with no recorded frame count (newly added targets were missed)', () => {
    // A snapshot update made crimson a flipbook target, but no record exists yet.
    // Letting it through silently makes the app collapse it to 1 frame and draw it at full size
    const p = verifyFrameStructure({
      membership,
      frames: { 'prismarine_rough.png': 4 },
      referenced: ['huge_fungus/crimson_log_side.png', 'prismarine_rough.png', 'stone.png'],
    });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('no recorded frame count');
    expect(p[0]).toContain('crimson_log_side');
  });

  it('skips the unrecorded check for the legacy call without referenced (backward compatibility)', () => {
    expect(verifyFrameStructure({ membership, frames: { 'prismarine_rough.png': 4 } })).toEqual([]);
  });
});

describe('parseTextureSource — validate the record down to its structure before using it', () => {
  const COMMIT = 'f'.repeat(40);

  it('accepts only a record whose commit is 40 hex digits', () => {
    expect(parseTextureSource({ commit: COMMIT, files: 142 })).toEqual({ commit: COMMIT });
  });

  it('collapses a malformed structure to null = unknown generation (so {} does not TypeError downstream)', () => {
    expect(parseTextureSource({})).toBeNull();
    expect(parseTextureSource(null)).toBeNull();
    expect(parseTextureSource('921fafb0')).toBeNull();
    expect(parseTextureSource({ commit: 42 })).toBeNull();
    expect(parseTextureSource({ commit: 'main' })).toBeNull();
    expect(parseTextureSource({ commit: COMMIT.slice(0, 8) })).toBeNull();
  });
});

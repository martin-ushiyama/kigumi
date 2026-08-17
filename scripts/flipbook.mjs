/**
 * The contract that decides the frame count of an animated texture (a 16xN vertically
 * concatenated sprite).
 *
 * Minecraft ships animated textures as a single vertically concatenated PNG. Pasting one as a
 * still image squashes it vertically, so only the first frame is cut out and used (#93).
 *
 * **The source of truth for the frame count is split in two.**
 *
 * - which files are animated → the membership in `flipbook_textures.json`
 * - how many frames a file has → the PNG's height / width
 *
 * The `frames` field of `flipbook_textures.json` cannot be used as the physical frame count.
 * Checking the real data (upstream 921fafb0), 42 of the 83 entries carry `frames`, and 21 of
 * those are not a plain 0,1,2,... sequence:
 *
 *   prismarine_rough   frames = [0,1,0,2,0,3,0,1,2,1,3,1,0,2,1,2,3,2,0,3,1,3]  (22 elements, 4 physical frames)
 *   crimson_log_side   no frames field                                          (5 physical frames)
 *
 * `frames` is a playback sequence — neither a count nor an ordering. It is used here only to
 * verify that every index falls inside the physical frame count.
 */

/** Parses JSONC (including the leading comment lines) */
export const parseJsonc = (text) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));

/**
 * A pure function that validates the generation record of the PNG cache (.source.json) **down
 * to its structure**.
 *
 * Being readable as JSON and being usable as a record are different things. Returning a
 * structurally invalid value such as `{}` makes the next stage stop with a TypeError the
 * moment it calls `commit.slice(...)` (reproduced on a real run in the #100 review). An
 * unusable record collapses to null = "generation unknown" and flows into the refetch path.
 *
 * @returns {{ commit: string } | null}
 */
export function parseTextureSource(value) {
  if (typeof value !== 'object' || value === null) return null;
  const commit = value.commit;
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) return null;
  return { commit };
}

/**
 * Builds the mapping of "files treated as animated" from the flipbook entry list.
 *
 * The key is the relative path with `textures/blocks/` stripped and no extension, which lines
 * it up with the file names on the manifest side.
 *
 * @returns Map<string, { frames: number[] | null }>
 */
export function buildFlipbookMembership(entries) {
  const membership = new Map();
  for (const e of entries) {
    const ref = e?.flipbook_texture;
    if (typeof ref !== 'string') continue;
    const rel = ref.replace(/^textures\/blocks\//, '');
    membership.set(rel, { frames: Array.isArray(e.frames) ? e.frames : null });
  }
  return membership;
}

/**
 * Derives the physical frame count from the PNG's dimensions.
 *
 * The frames are concatenated vertically, so the height must be an integer multiple of the
 * width. An image that does not divide evenly has no determined frame split, so it raises an
 * error instead of being truncated silently (cutting at a half-way position leaves a shifted
 * picture on screen with nothing to notice it by).
 *
 * @returns {{ ok: true, frameCount: number } | { ok: false, reason: string }}
 */
export function frameCountFromSize({ width, height }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return { ok: false, reason: `the dimensions are invalid (${width}x${height})` };
  }
  if (height % width !== 0) {
    return {
      ok: false,
      reason: `the height is not an integer multiple of the width (${width}x${height} → ${(height / width).toFixed(3)} frames)`,
    };
  }
  return { ok: true, frameCount: height / width };
}

/**
 * Verifies that an explicit playback sequence stays inside the physical frame count.
 *
 * Some entries carry no `frames`, and those skip the check (that is not an error).
 */
export function validateFrameIndices({ frames, frameCount }) {
  if (!Array.isArray(frames)) return { ok: true };
  const bad = frames.filter((i) => !Number.isInteger(i) || i < 0 || i >= frameCount);
  if (bad.length) {
    return {
      ok: false,
      reason: `the playback sequence has an index out of range (${frameCount} physical frames, out of range: ${[...new Set(bad)].join(', ')})`,
    };
  }
  return { ok: true };
}

/**
 * Verifies the **structural consistency** between the membership and the measured frame counts.
 *
 * What is checked here is only the correspondence "animated ⇒ at least 2 frames" and
 * "not animated ⇒ 1 frame"; it **does not guarantee that the real PNG dimensions are correct**
 * (the PNGs are gitignored and do not exist in CI). Agreement with the real dimensions can
 * only be confirmed at fetch time.
 *
 * @param referenced the list of files the manifest references (optional). Passing it also
 *   checks the **reverse direction** — detecting files that are flipbook members but have no
 *   recorded frame count. When an upstream snapshot update adds a new animated texture, a
 *   missing record makes the app squash it into a single frame (1:1) and draw it, so it is
 *   never let through silently (#100 review)
 * @returns the problem messages (empty when consistent)
 */
export function verifyFrameStructure({ membership, frames, referenced }) {
  const problems = [];

  if (referenced) {
    for (const file of referenced) {
      if (!membership.has(file.replace(/\.png$/, ''))) continue;
      if (frames[file] === undefined) {
        problems.push(
          `${file}: a flipbook member with no recorded frame count. Run npm run fetch-textures to fetch the PNG and record it`,
        );
      }
    }
  }

  for (const [file, count] of Object.entries(frames)) {
    const rel = file.replace(/\.png$/, '');
    if (!membership.has(rel)) {
      problems.push(`${file}: a frame count of ${count} is recorded, but it is not a flipbook member`);
      continue;
    }
    if (!Number.isInteger(count) || count < 2) {
      problems.push(`${file}: a flipbook member whose frame count is ${count} (it should be 2 or more)`);
      continue;
    }
    const entry = membership.get(rel);
    const v = validateFrameIndices({ frames: entry.frames, frameCount: count });
    if (!v.ok) problems.push(`${file}: ${v.reason}`);
  }

  return problems;
}

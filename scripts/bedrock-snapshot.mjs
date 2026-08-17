/**
 * The shared definitions and reader for the Mojang bedrock-samples snapshot.
 *
 * The upstream files (`(c) Mojang AB. All rights reserved.` / under the Minecraft EULA) are
 * **never committed to this repository**. Just like the texture PNGs, which are gitignored
 * along with public/textures/, data/bedrock/ is kept as a local cache.
 *
 * The only thing committed is data/bedrock/SOURCE.json (the record of which commit was taken
 * and what it contained). That way "which point in time of Bedrock this catalogue assumes" is
 * under version control while the upstream files themselves are not redistributed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Where the snapshot lives (resolved relative to scripts/, independent of cwd) */
export const SNAPSHOT_DIR = fileURLToPath(new URL('../data/bedrock/', import.meta.url));

/** The record of which commit was taken and what it contained. **The only committed file** */
export const SOURCE_PATH = fileURLToPath(new URL('../data/bedrock/SOURCE.json', import.meta.url));

export const UPSTREAM_REPO = 'https://github.com/Mojang/bedrock-samples';

/**
 * What to fetch. The key is the local file name, the path is the path inside the upstream
 * repository.
 *
 * No script reads terrain_texture.json at the moment, but it is the source of truth for
 * texture file names (guessing does not get there, #92), so it is fetched at the same commit
 * as everything else.
 *
 * `resource-pack-blocks.json` (upstream `resource_pack/blocks.json`) is **the only bridge from
 * a block ID to a texture name**. terrain_texture.json is a dictionary keyed by texture name,
 * so without this bridge a block ID cannot reach a real file (#97 stage 2).
 * The upstream basename is `blocks.json`, but that would blur into `mojang-blocks.json` and
 * `src/data/blocks.json`, so the local name is kept distinct.
 */
export const SNAPSHOT_FILES = {
  'mojang-blocks.json': 'metadata/vanilladata_modules/mojang-blocks.json',
  'resource-pack-blocks.json': 'resource_pack/blocks.json',
  'terrain_texture.json': 'resource_pack/textures/terrain_texture.json',
  'flipbook_textures.json': 'resource_pack/textures/flipbook_textures.json',
  'en_US.lang': 'resource_pack/texts/en_US.lang',
  // **Mojang ships Japanese display names too** (`languages.json` has ja_JP).
  // The reason for keeping hand-written Japanese names is not "upstream has none" but "some
  // cannot be looked up"; whatever can be looked up has an official source of truth, and the
  // hand-written set shrinks to filling the gaps
  'ja_JP.lang': 'resource_pack/texts/ja_JP.lang',
};

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Builds a raw.githubusercontent.com URL. It pins a commit, so the result does not change when main moves */
export const rawUrl = (commit, path) =>
  `https://raw.githubusercontent.com/Mojang/bedrock-samples/${commit}/${path}`;

export function readSource() {
  if (!existsSync(SOURCE_PATH)) return null;
  return JSON.parse(readFileSync(SOURCE_PATH, 'utf-8'));
}

/**
 * A **pure function** that assembles the record. It is determined solely by the upstream state
 * (the commit and the bytes of each file).
 *
 * It holds no value that changes on every run, such as a fetch timestamp. Holding one would
 * make a tracked file dirty merely from refetching the same commit (#98 review). "When it was
 * taken in" is already held by git as the moment SOURCE.json was committed, and writing it into
 * the record would manage the same fact twice (which is the very structure #97 is removing).
 */
export function buildSource({ commit, files }) {
  return {
    _note:
      'The upstream files themselves are not redistributed (Mojang AB, All rights reserved / Minecraft EULA). data/bedrock/ is gitignored and only this record is committed. Fetch with npm run fetch-bedrock-snapshot. The contents are determined solely by the upstream state (no fetch timestamp; git log is the source of truth for when it was taken in).',
    repository: UPSTREAM_REPO,
    commit,
    // Keep the key order independent of the fetch order, so a reshuffle alone never produces a diff
    files: Object.fromEntries(
      Object.keys(files)
        .sort()
        .map((name) => [name, files[name]]),
    ),
  };
}

/** The single representation used when writing the record to a file. Comparison and writing both go through it */
export const formatSource = (source) => JSON.stringify(source, null, 2) + String.fromCharCode(10);

/**
 * A **pure function** deciding whether the record (SOURCE.json) agrees with the real bytes.
 *
 * It is separated from file reading because data/bedrock/ is gitignored, so CI has no real
 * files and the check itself could not be tested if it depended on them (the contract is
 * lifted out into a pure function).
 *
 * @returns a user-facing message when there is a problem, null otherwise
 */
export function verifySnapshotBytes({ name, bytes, source }) {
  if (!(name in SNAPSHOT_FILES)) {
    return `this file is outside the snapshot: ${name}`;
  }
  if (!source) {
    return [
      `there is no snapshot record (data/bedrock/SOURCE.json).`,
      `  npm run fetch-bedrock-snapshot -- --update`,
      `fetches it from upstream (a network connection is required).`,
    ].join(String.fromCharCode(10));
  }
  const expected = source.files?.[name]?.sha256;
  if (!expected) {
    return `data/bedrock/SOURCE.json has no record for ${name}. Refetch with npm run fetch-bedrock-snapshot -- --update`;
  }
  if (bytes === null) {
    return [
      `the real snapshot file is missing: data/bedrock/${name}`,
      `recorded commit: ${source.commit}`,
      `  npm run fetch-bedrock-snapshot`,
      `fetches it (refetching at the recorded commit).`,
    ].join(String.fromCharCode(10));
  }
  const actual = sha256(bytes);
  if (actual !== expected) {
    return [
      `the snapshot does not match the record: data/bedrock/${name}`,
      `  recorded: ${expected}`,
      `  actual:   ${actual}`,
      `either the fetch was cut short, or a file from a different commit is left behind.`,
      `  npm run fetch-bedrock-snapshot`,
      `refetches it.`,
    ].join(String.fromCharCode(10));
  }
  return null;
}

/**
 * Reads one snapshot file.
 *
 * **Both** the record (SOURCE.json) and the real file are checked. Looking at only one lets a
 * file whose fetch was cut short, or one left over from a different commit, be picked up and
 * written into the generated output (a kind of breakage that otherwise passes silently).
 *
 * @param {string} name a key of SNAPSHOT_FILES
 * @param {'utf-8'|'buffer'} encoding
 */
export function readSnapshot(name, encoding = 'utf-8') {
  const path = fileURLToPath(new URL(name, new URL('../data/bedrock/', import.meta.url)));
  const bytes = existsSync(path) ? readFileSync(path) : null;

  const problem = verifySnapshotBytes({ name, bytes, source: readSource() });
  if (problem) throw new Error(problem);

  return encoding === 'buffer' ? bytes : bytes.toString('utf-8');
}

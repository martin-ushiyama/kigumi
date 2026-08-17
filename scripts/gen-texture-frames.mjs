/**
 * Generates and verifies the frame counts of animated textures (src/data/texture-frames.json).
 *
 * **`frameCount` is not a value a human edits by hand.** The physical frame count is
 * determined only by the PNG's dimensions, so it is treated as a derived value that this
 * generation step updates when — and only when — the real files are all present.
 *
 * ## The verification has three depths, by how complete the inputs are
 *
 * Both the upstream snapshot (data/bedrock/) and the PNGs (public/textures/) are gitignored,
 * so which inputs are at hand differs per environment. What matters here is not **whether they
 * exist** but **whether they can be trusted**:
 *
 *   depth 0 … no snapshot. Only the structural consistency of the committed output
 *   depth 1 … the snapshot is verified down to its sha256. Membership and playback indices too
 *   depth 2 … additionally, **every referenced PNG is present and from the current commit**.
 *             Real-dimension agreement and the reverse-direction check
 *
 * The conditions for dropping a depth are strict so that a half-complete state never gets to
 * call itself verified:
 *
 * - if the snapshot **exists but disagrees with the record**, it does not fall back to depth 0
 *   — it is an **error** (a different commit, or a fetch cut short, is never silently treated
 *   as "there was nothing")
 * - **depth 1 uses no PNG in the generated values at all.** Measuring dimensions while only
 *   some are at hand makes just those new, mixing the record (a 5 → 4 mis-update really happened)
 * - the reverse-direction check (tall but not listed in flipbook) looks for **unknown
 *   candidates**, so absence cannot be proven from the known animations alone. Every
 *   referenced PNG is required
 *
 * Usage:
 *   node scripts/gen-texture-frames.mjs           # verify to whatever depth is reachable, and update if needed
 *   node scripts/gen-texture-frames.mjs --check   # do not rewrite; exit 1 if there is a diff
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSnapshot, readSource } from './bedrock-snapshot.mjs';
import { readTextureSource } from './gen-textures.mjs';
import {
  buildFlipbookMembership,
  frameCountFromSize,
  parseJsonc,
  verifyFrameStructure,
} from './flipbook.mjs';

const OUTPUT_PATH = fileURLToPath(new URL('../src/data/texture-frames.json', import.meta.url));
const MANIFEST_PATH = fileURLToPath(new URL('../src/data/textures.json', import.meta.url));
const TEXTURE_DIR = fileURLToPath(new URL('../public/textures/blocks/', import.meta.url));
const SNAPSHOT_FILE = fileURLToPath(new URL('../data/bedrock/flipbook_textures.json', import.meta.url));

const checkOnly = process.argv.includes('--check');

/** Reads the dimensions from a PNG's IHDR (the first 24 bytes, no dependencies) */
function pngSize(path) {
  const b = readFileSync(path);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function walkPngs(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkPngs(p));
    else if (name.endsWith('.png')) out.push(p);
  }
  return out;
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
const recorded = existsSync(OUTPUT_PATH) ? JSON.parse(readFileSync(OUTPUT_PATH, 'utf-8')) : {};

/** The set of files the manifest references (side / top) */
const referenced = new Set();
for (const entry of Object.values(manifest)) {
  for (const file of [entry.side, entry.top]) {
    if (typeof file === 'string') referenced.add(file);
  }
}

// ─── The state of the snapshot: absent / verified / disagreeing (= error) ────────

let membership = null;
if (existsSync(SNAPSHOT_FILE)) {
  // readSnapshot cross-checks against the sha256 in SOURCE.json. Doing this with a plain
  // readFileSync would let a file from a different commit, or a fetch cut short, become
  // depth 1/2 as-is
  membership = buildFlipbookMembership(parseJsonc(readSnapshot('flipbook_textures.json')));
}

// ─── The state of the PNG cache: absent / complete at the current generation / partial or unknown ───

const sourceCommit = readSource()?.commit ?? null;
const textureSource = readTextureSource();
const cacheGenerationOk = !!sourceCommit && textureSource?.commit === sourceCommit;
const missingReferenced = [...referenced].filter((f) => !existsSync(join(TEXTURE_DIR, f)));
const pngsComplete = cacheGenerationOk && missingReferenced.length === 0;

const depth = !membership ? 0 : pngsComplete ? 2 : 1;
const DEPTH_LABEL = {
  0: 'depth 0: committed only (structural consistency. No snapshot, so membership is unverified and so are the real PNG dimensions)',
  1: 'depth 1: + the snapshot (membership and playback indices. No PNG is used in the generated values)',
  2: 'depth 2: + every PNG (real-dimension agreement and the reverse-direction check)',
};

const problems = [];
const warnings = [];

if (depth === 1) {
  if (!cacheGenerationOk) {
    warnings.push(
      textureSource
        ? `the PNG cache is from a different generation than the current commit (${String(textureSource.commit).slice(0, 8)} ≠ ${String(sourceCommit).slice(0, 8)}). Refetch with npm run fetch-textures`
        : 'the generation of the PNG cache is unknown (public/textures/.source.json is missing). Refetch with npm run fetch-textures',
    );
  } else if (missingReferenced.length) {
    warnings.push(
      `${missingReferenced.length} of the ${referenced.size} referenced PNGs are missing. Refetch with npm run fetch-textures`,
    );
  }
  warnings.push('no PNG was used in the generated values (measuring while they are incomplete makes only some of them new and mixes the record)');
}

// ─── depth 0: the structural consistency visible from the committed files alone ───

for (const [file, count] of Object.entries(recorded)) {
  if (!referenced.has(file)) {
    problems.push(`${file}: a frame count is recorded although the manifest does not reference it`);
  }
  if (!Number.isInteger(count) || count < 2) {
    problems.push(`${file}: the frame count is ${count} (recording it as an animation requires 2 or more)`);
  }
}

// ─── Deciding the generated values ──────────────────────────────────────────────

const frames = {};

if (depth < 2) {
  // Not in a state where the real dimensions can be measured, so the record is carried over
  // as-is (never rewritten on a whim)
  Object.assign(frames, recorded);
} else {
  const animated = [...referenced].filter((f) => membership.has(f.replace(/\.png$/, ''))).sort();
  for (const file of animated) {
    const size = pngSize(join(TEXTURE_DIR, file));
    if (!size) {
      problems.push(`${file}: cannot be read as a PNG`);
      continue;
    }
    const r = frameCountFromSize(size);
    if (!r.ok) {
      problems.push(`${file}: ${r.reason}`);
      continue;
    }
    frames[file] = r.frameCount;
  }
}

// The record can only be checked against the membership when there is one
if (membership) problems.push(...verifyFrameStructure({ membership, frames, referenced }));

// ─── depth 2 only: the reverse gap (tall but not listed in flipbook) ─────────────

if (depth === 2) {
  for (const p of walkPngs(TEXTURE_DIR)) {
    const rel = relative(TEXTURE_DIR, p).replace(/\\/g, '/');
    const size = pngSize(p);
    if (!size || size.height <= size.width) continue;
    if (membership.has(rel.replace(/\.png$/, ''))) continue;
    warnings.push(
      `${rel} (${size.width}x${size.height}): tall but not listed in flipbook (either an upstream omission or one on our import side)`,
    );
  }
}

if (problems.length) {
  console.error(`there are problems with the texture frame counts (${DEPTH_LABEL[depth]}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const next = JSON.stringify(frames, null, 2) + String.fromCharCode(10);
/**
 * Normalize the line endings before comparing. A tracked JSON becomes CRLF in an environment
 * with core.autocrlf=true, so a raw byte comparison would fail even when the contents match
 * (.gitattributes pins it to LF, but this absorbs it here too, for existing checkouts and
 * differing settings)
 */
const normalize = (s) => (s === null ? null : s.replace(/\r\n/g, String.fromCharCode(10)));
const current = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, 'utf-8') : null;
const changed = normalize(current) !== next;

if (checkOnly) {
  if (changed) {
    console.error('src/data/texture-frames.json does not match the generated result.');
    console.error('  run npm run gen-texture-frames and commit the diff');
    process.exit(1);
  }
  console.log(`${Object.keys(frames).length} frame counts: matches the record — ${DEPTH_LABEL[depth]}`);
} else {
  if (changed) writeFileSync(OUTPUT_PATH, next);
  console.log(`${Object.keys(frames).length} frame counts → src/data/texture-frames.json — ${DEPTH_LABEL[depth]}`);
}

for (const w of warnings) console.warn(`  ! ${w}`);

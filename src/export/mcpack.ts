import { strToU8, zipSync } from 'fflate';

/** Structure namespace (called in-game as /structure load bs:<name>) */
export const STRUCTURE_NAMESPACE = 'bs';

/**
 * 32-bit hash derived from the project name (FNV-1a).
 *
 * **Every export identifier is derived from this.** The same project name always
 * produces the same value, so re-exporting yields the same structure name and the
 * same pack identity. Mixing in randomness or a timestamp would spawn a new pack
 * on every export.
 *
 * (Whether the game updates it in place on re-import is a separate concern that
 * needs version design)
 */
function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Short identifier derived from the project name (base36, 6 digits) */
function nameDigest(name: string): string {
  return hash32(name).toString(36).padStart(6, '0').slice(-6);
}

/**
 * The **canonical string that identification is based on**, after applying
 * equivalence rules. The export name derives its empty check, readable
 * portion, and identifier all from this.
 *
 * - Lowercase (case-insensitive)
 * - Collapse runs of whitespace and `_` into a single `_`
 * - Strip leading/trailing `_`
 *
 * **Unrepresentable characters are not stripped here.** To treat `road/a` and
 * `road?a` as different projects, characters that can be used to tell them
 * apart are kept at this stage.
 *
 * Deriving the identifier from the original name without going through this
 * step would give **names declared equivalent different identifiers**
 * (`Road/A` vs `road/a`, `___` vs empty input) — the place where the rule is
 * declared and the place it's applied would drift apart (review comment on
 * in review).
 */
function canonicalName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Whether, after applying equivalence rules, the string consists only of characters writable in a structure name */
const REPRESENTABLE = /^[a-z0-9_-]+$/;

/**
 * Normalize to a form usable as a structure name (lowercase alphanumerics,
 * `_`, and `-` only).
 *
 * ## Equivalence rules (the only place collapsing is intentional)
 *
 * - Case-insensitive (`My Road` = `my road`)
 * - A run of whitespace and `_` counts as a single `_` (`road a` = `road_a` = `road__a`)
 * - Leading/trailing whitespace and `_` are treated as absent
 *
 * Since structure names can't contain uppercase letters or whitespace anyway,
 * these three collapses are required by the namespace itself — adding an
 * identifier wouldn't make the display name readable again regardless.
 * **Only within this range can two different projects end up with the same
 * name**, and that's an intentional, documented tradeoff.
 *
 * ## Everything else must stay distinct
 *
 * If even one character outside the range above (Japanese / symbols / emoji)
 * is present, converting to a writable form loses the ability to recover the
 * original name. Use the readable portion plus an identifier derived from
 * the project name:
 *
 * - `🏠🛤️` → `structure-xxxxxx` (no writable characters remain)
 * - `📍A` and `📌A` → `a-xxxxxx` / `a-yyyyyy` (the remaining `a` alone
 *   can't disambiguate them)
 * - `road/a` and `road?a` → `road_a-xxxxxx` / `road_a-yyyyyy` (even a
 *   single-character substitution collapses to the same `_`)
 *
 * The comparison is done on **the result of `canonicalName`, not on the
 * strings after stripping unrepresentable characters**. Once characters are
 * stripped, their distinctions are already gone, so comparing the
 * post-strip strings misses cases like "one character became one `_`"
 * (raised in review).
 *
 * Names already written within the equivalence rules (`My Road v2` /
 * `ishi-mix_01`) pass through unchanged as before.
 */
export function sanitizeStructureName(name: string): string {
  // Derive the empty check, readable portion, and identifier **all from the
  // same canonical value**. Deriving even one of them from the original name
  // would make names declared equivalent diverge right at that point
  const canonical = canonicalName(name);
  if (!canonical) return 'structure'; // Empty input and whitespace/`_`-only both collapse to one case, so no collision
  const safe = canonical
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (REPRESENTABLE.test(canonical)) return safe;
  return safe ? `${safe}-${nameDigest(canonical)}` : `structure-${nameDigest(canonical)}`;
}

/**
 * UUID derived from the project name.
 *
 * **Must never change between exports.** Minecraft identifies packs by UUID,
 * so assigning a new UUID on every export would spawn a new pack for the
 * same project each time (raised in review). The same project name
 * always produces the same pack identity, so packs don't multiply.
 *
 * (Whether re-importing updates the pack in place is decided by the version;
 * see `revisionToVersion`.)
 *
 * The format looks like v4 (version/variant bits are set), but the contents
 * are a deterministic value derived from the name. `purpose` gives the
 * header and the module different values.
 */
function uuidFromName(name: string, purpose: string): string {
  const bytes: number[] = [];
  // 4 bytes at a time, 4 rounds, varying the seed to build 16 bytes
  for (let block = 0; block < 4; block++) {
    const h = hash32(`${purpose}:${block}:${name}`);
    bytes.push((h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Generate a behavior pack (.mcpack = zip) bundling a .mcstructure file.
 * Double-clicking imports it into Minecraft; once the pack is applied to a
 * world, it can be placed with a structure block (load) or via
 * /structure load bs:<name>.
 */
/**
 * Split the export count (`exportRevision`) into Bedrock's version triple.
 *
 * A Bedrock version is 3 integers. `major` is fixed at 1 (the pack format's
 * own version), and the export count is split into two base-1000 digits (up
 * to 1,000,000 exports). **Overflow is clamped at the max** — wrapping
 * around would produce a "same or lower version", causing the import to be
 * ignored and leaving the pack stuck unable to update.
 */
export function revisionToVersion(revision: number): [number, number, number] {
  const safe = Number.isInteger(revision) && revision > 0 ? Math.min(revision, 999_999) : 0;
  return [1, Math.floor(safe / 1000), safe % 1000];
}

/**
 * @param exportRevision Export count (remembered by the project file).
 *   **Increment and pass it every time.** With the same value, Bedrock
 *   treats the import as "same or lower version" and ignores it
 */
export function buildMcpack(structureName: string, mcstructure: Uint8Array, exportRevision = 0): Uint8Array {
  const name = sanitizeStructureName(structureName);
  const manifest = {
    format_version: 2,
    header: {
      // **Put the name the player types in-game here.** The pack list shows
      // this display name, but `/structure load` takes the name derived from
      // the structures/ path — the two don't match. Typing based on the
      // display name alone wouldn't work, so the literal command form is
      // included alongside it
      name: `blocksmith - ${name} (${STRUCTURE_NAMESPACE}:${name})`,
      // The pack manifest is data stored and kept on the Minecraft side,
      // independent of the editor's display language (a pack exported while
      // the editor was in Japanese might get opened in an English
      // environment). Keep it fixed in English rather than tying it to the
      // language switch
      description: 'Structures built with blocksmith (structures/bs/)',
      // **Derived from the project name.** If it were random, re-exporting
      // the same project would spawn a new pack in Minecraft each time
      uuid: uuidFromName(name, 'header'),
      // **A version that increases on every export.** Bedrock ignores an
      // import with "same UUID + same or lower version", so overwriting
      // requires a monotonically increasing version. The content hash isn't
      // guaranteed to increase with edit order (it can actually go down
      // going from 1 cell to 2 cells), so without persisted state there's no
      // way to guarantee monotonicity. The count is remembered by the
      // project file
      version: revisionToVersion(exportRevision),
      min_engine_version: [1, 21, 0],
    },
    modules: [
      {
        type: 'data',
        uuid: uuidFromName(name, 'module'),
        version: revisionToVersion(exportRevision),
      },
    ],
  };

  return zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    [`structures/${STRUCTURE_NAMESPACE}/${name}.mcstructure`]: mcstructure,
  });
}

/** Trigger a file download in the browser */
export function downloadBytes(bytes: Uint8Array, filename: string, mime = 'application/octet-stream'): void {
  const ab = new ArrayBuffer(bytes.length);
  new Uint8Array(ab).set(bytes);
  const blob = new Blob([ab], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * The **rules for reading** the upstream files (Mojang bedrock-samples). Pure functions only.
 *
 * They are separated from file reading because `data/bedrock/` is gitignored and CI has no
 * real copy of it; if the rules depended on the real files they could not be tested at all
 * (the same reason as bedrock-snapshot.mjs).
 *
 * Only "how to read upstream" belongs here. Decisions about what to include and how to
 * present it stay out (#97).
 */

/**
 * The upstream JSON sometimes carries line comments (JSONC).
 * `terrain_texture.json` starts with a one-line notice saying not to drop the file straight
 * into a resource pack.
 *
 * **Only lines that are entirely a comment are removed.** Inline and block comments are not
 * handled — hitting one stops the parse, because stripping them carelessly would also cut
 * into string contents and pass in a way that hides the damage.
 */
export function parseJsonc(text, label = 'JSON') {
  if (text.includes('/*')) {
    throw new Error(`${label}: block comments (/* */) are not handled — revisit the read rules`);
  }
  const stripped = text
    .split(/\r?\n/)
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join(String.fromCharCode(10));
  try {
    return JSON.parse(stripped);
  } catch (e) {
    throw new Error(`${label}: could not be read as JSON (${e.message})`, { cause: e });
  }
}

/**
 * Reads display names out of `en_US.lang`.
 *
 * - `exact`: a direct lookup of `tile.<id>.name`. **Only for ids without a dot** — older
 *   blocks are stored in a parent.variant form such as `tile.stone.granite.name`, which
 *   cannot be looked up from a block ID
 * - `values`: the set of strings that actually exist as display names. Used to check whether a
 *   mechanically generated name matches the official spelling
 *
 * Both gen-blocks.mjs and block-db need this rule. **Do not write the same rule in two
 * places** (that is the very structure #97 is trying to remove).
 */
export function parseLangEntries(text) {
  const exact = new Map();
  const values = new Set();
  for (const line of text.split(String.fromCharCode(10))) {
    const m = line.match(/^tile\.([A-Za-z0-9_.]+)\.name=(.+?)\s*(#.*)?$/);
    if (!m) continue;
    const [, key, value] = m;
    values.add(value.trim());
    if (!key.includes('.')) exact.set(key, value.trim());
  }
  return { exact, values };
}

/** The six faces of a block. The order matches the six-face form in upstream `resource_pack/blocks.json` */
export const FACES = ['down', 'up', 'north', 'south', 'east', 'west'];

/** The four faces (everything but up and down) that `side` stands for */
const SIDE_FACES = ['north', 'south', 'east', 'west'];

/**
 * Expands the `textures` value of `resource_pack/blocks.json` into six faces.
 *
 * Upstream uses three spellings (in the real data: 915 strings / 171 `{down,side,up}` /
 * 125 six-face). **The expanded result is not stored in the DB** because the upstream value is
 * the source of truth and the expansion follows from it. Holding one fact in two shapes lets
 * one of them go stale.
 *
 * @returns {{ faces: Record<string,string>|null, notes: string[] }}
 *   faces = face → texture name, or null when it cannot be interpreted. notes = a record of
 *   the decisions that were otherwise made silently
 */
export function expandFaceRefs(refs) {
  const notes = [];
  if (refs === undefined || refs === null) return { faces: null, notes: ['no texture specified'] };

  if (typeof refs === 'string') {
    if (!isTextureString(refs)) return { faces: null, notes: [describeBadValue('(uniform)', refs)] };
    return { faces: Object.fromEntries(FACES.map((f) => [f, refs])), notes };
  }
  if (typeof refs !== 'object' || Array.isArray(refs)) {
    return { faces: null, notes: [`unsupported shape: ${Array.isArray(refs) ? 'array' : typeof refs}`] };
  }

  const faces = {};
  const hasAllSides = SIDE_FACES.every((f) => f in refs);
  if ('side' in refs && hasAllSides) {
    // A shape that appears exactly twice in the real data (azalea / flowering_azalea). The
    // individual faces disagree with side, so the individual ones win and dropping side is
    // recorded. Choosing silently would leave no trail afterwards
    notes.push('both side and the four individual side faces are present; the individual ones win and side is unused');
  }
  for (const face of FACES) {
    if (face in refs) faces[face] = refs[face];
    else if (SIDE_FACES.includes(face) && 'side' in refs) faces[face] = refs.side;
  }

  const missing = FACES.filter((f) => !(f in faces));
  if (missing.length > 0) {
    return { faces: null, notes: [...notes, `missing faces: ${missing.join(', ')}`] };
  }
  // **Having all the keys is not enough.** The values are checked for being usable as texture
  // names too — six faces holding numbers or null were being treated as a success (#97 stage 2
  // review). Without stopping here, a value that cannot be picked up as a name drops out
  // silently and never appears in the diagnostics
  const badValues = FACES.filter((f) => !isTextureString(faces[f])).map((f) => describeBadValue(f, faces[f]));
  if (badValues.length > 0) {
    return { faces: null, notes: [...notes, ...badValues] };
  }
  return { faces, notes };
}

/**
 * Whether a value is usable as a texture name or path (empty and whitespace-only are rejected).
 *
 * The name side and the path side **use the same check**. If one is looser, an empty path
 * passes as "reached" (#97 stage 2 review).
 */
function isTextureString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

const describeBadValue = (face, value) =>
  `the value of ${face} is not a texture name: ${typeof value} ${JSON.stringify(value ?? null)}`;

/**
 * Normalizes one entry of `terrain_texture.json` into **an array of candidates**.
 *
 * Upstream mixes strings, arrays and `{path, overlay_color}` (in the real data: 980 strings /
 * 317 arrays / 3 other). **Only the array wrapping** is done and the elements are returned as
 * upstream wrote them — dropping `overlay_color` or `tint_color` would erase facts such as the
 * tinting of grass.
 *
 * Path strings are not shortened because some really do point outside `textures/blocks/`
 * (73 `textures/items/` / 10 `textures/environment/` / 1 `textures/misc/`).
 */
export function normalizeTextureVariants(entry) {
  if (entry === undefined || entry === null) return null;
  const textures = entry.textures;
  if (textures === undefined || textures === null) return null;
  return Array.isArray(textures) ? textures.slice() : [textures];
}

/**
 * Collects **every texture name** that appears in a `textures` value.
 *
 * Names are collected even for shapes that cannot expand into six faces (missing faces, etc.)
 * — whether the expansion succeeded and which names are referenced are separate facts, and
 * dropping the latter makes the reason for an unresolved texture untraceable. When both `side`
 * and individual faces are present, both are collected (the fact that the discarded side is
 * still referenced remains).
 */
export function collectRefNames(refs) {
  if (typeof refs === 'string') return isTextureString(refs) ? [refs] : [];
  if (!refs || typeof refs !== 'object') return [];
  const values = Array.isArray(refs) ? refs : Object.values(refs);
  return [...new Set(values.filter((v) => isTextureString(v)))].sort();
}

/**
 * Pulls the file path out of a single candidate (a string as-is, or `path` for an object).
 *
 * **An empty or whitespace-only path counts as not extractable.** Returning it as-is would
 * make the reachability check mistake it for "there is a path" and pass (#97 stage 2 review).
 * The same check as the name side is used.
 */
export function variantPath(variant) {
  if (typeof variant === 'string') return isTextureString(variant) ? variant : null;
  if (variant && typeof variant === 'object' && isTextureString(variant.path)) return variant.path;
  return null;
}

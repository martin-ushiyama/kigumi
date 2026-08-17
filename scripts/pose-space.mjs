/**
 * Builds the pose space from the upstream data (#131 PR 1). Pure functions only.
 *
 * The orientations a block can take are **declared by Bedrock as per-block block states**. We
 * fold those per shape and hold the result. This replaces writing "stairs have 4 directions ×
 * an upside-down flag" by hand.
 *
 * ## What comes from upstream / what we decide
 *
 * | | from where |
 * |---|---|
 * | which states it has | upstream (`data_items[].properties`) |
 * | their value ranges | upstream (`block_properties[].values`) |
 * | **which states are poses** | **us** (`POSE_STATES` below) |
 * | **which state is the higher digit** | **us** (same, the order is the weight order) |
 *
 * Upstream never says "is this a pose". `bone_block` really does declare `deprecated`
 * (values 0-3) alongside `pillar_axis`, so taking the full product mixes in 4 combinations
 * that have nothing to do with the pose space. **Only the selection of poses is declared by
 * us** — but the declaration is just the two arrays below, and not a single value range is
 * copied down.
 */

/**
 * The states that make up a pose. **The order is the digit weight** (the first is the highest
 * digit).
 *
 * It does not follow the upstream declaration order (`oak_stairs` declares `upside_down_bit`
 * → `weirdo_direction`). Following it would make the code `upside * 4 + weirdo` and **shift
 * the orientation of every existing saved file** (`orientation.ts` guarantees that "the
 * existing 0-15 keep pointing at the same orientation"). The weight order is part of the save
 * format, so it lives somewhere upstream's conventions cannot move it.
 */
export const POSE_STATES = ['pillar_axis', 'minecraft:vertical_half', 'weirdo_direction', 'upside_down_bit'];

/**
 * The states that have **already been judged** not to be poses.
 *
 * If a block arrives carrying a state that is neither here nor in `POSE_STATES`, it appears in
 * `unknownStates` and the check fails. This exists to avoid creating a path that "silently
 * ignores an unknown state", so **it must not be emptied**: ignoring is a decision, and
 * decisions are recorded.
 */
export const NON_POSE_STATES = [
  // A leftover from the old data values. The values are 0-3 but unrelated to pose (bone_block, etc.)
  'deprecated',
];

/**
 * Takes the pose states and value ranges of one block out of the upstream declaration.
 *
 * @param {{ properties?: Array<{ name: string }> }} dataItem one entry of `data_items` in `mojang-blocks.json`
 * @param {Map<string, unknown[]>} domains state name → value range (from `block_properties`)
 * @returns {{ pose: Record<string, unknown[]>, unknownStates: string[] }}
 */
export function poseStatesOf(dataItem, domains) {
  const pose = {};
  const unknownStates = [];
  const declared = (dataItem.properties ?? []).map((p) => p.name);
  // Collecting in POSE_STATES order = laying them out in digit-weight order
  for (const name of POSE_STATES) {
    if (!declared.includes(name)) continue;
    const values = domains.get(name);
    if (!values) {
      unknownStates.push(`${name} (its value range is not in block_properties)`);
      continue;
    }
    pose[name] = [...values];
  }
  for (const name of declared) {
    if (POSE_STATES.includes(name) || NON_POSE_STATES.includes(name)) continue;
    unknownStates.push(name);
  }
  return { pose, unknownStates };
}

/** The size of the pose space (the product of the value ranges) */
export const poseSpaceSize = (pose) => Object.values(pose).reduce((n, values) => n * values.length, 1);

/**
 * Folds the pose spaces per shape.
 *
 * The premise is that blocks of the same shape have the same pose space. **A break is
 * reported** — a break looks like "stairs that carry an open/closed state", i.e. the shape
 * classification itself is not fine enough, and silently picking one side makes the export and
 * the display disagree.
 *
 * A block with no pose states at all (plain stone) does not narrow the pose space of its shape
 * (a log with `pillar_axis` and a stone without it are both `full`).
 *
 * @param {Array<{ id: string, shape: string, pose: Record<string, unknown[]> }>} blocks
 * @returns {{ spaces: Record<string, Record<string, unknown[]>>, conflicts: string[] }}
 */
export function foldPoseSpacesByShape(blocks) {
  const spaces = {};
  const conflicts = [];
  for (const { id, shape, pose } of blocks) {
    const known = spaces[shape];
    if (!known) {
      if (Object.keys(pose).length > 0) spaces[shape] = pose;
      continue;
    }
    if (Object.keys(pose).length === 0) continue;
    const a = JSON.stringify(known);
    const b = JSON.stringify(pose);
    if (a !== b) conflicts.push(`${id}: the pose space of shape ${shape} differs from the others (${b} vs ${a})`);
  }
  // Shapes with no pose are listed as an empty space too (so the list of shapes matches the list of pose spaces)
  for (const { shape } of blocks) spaces[shape] ??= {};
  return { spaces, conflicts };
}

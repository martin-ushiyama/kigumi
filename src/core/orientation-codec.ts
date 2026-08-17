/**
 * **Serialization** of orientation codes — determines the orientation code ↔ block state
 * assignment mapping from upstream data.
 *
 * ## This is not the meaning model
 *
 * **The meaning model is `Orientation`, and only `Orientation`** (the completion condition
 * agreed for the first step). The state assignment handled here exists purely as a
 * **save/export convenience** for packing `Orientation` into a single number — it is not a
 * second pose representation. That's why it isn't exported — only `orientation.ts` uses it,
 * and every other module only ever sees `Orientation`.
 *
 * Hand-written per-shape branches (`if full / if slab / else stairs`) are folded down into
 * this instead. Branching that way means a new shape silently gets swallowed into the last
 * branch — adding a door would get it exported as stairs, that kind of breakage.
 *
 * The assignment space itself lives in `src/data/pose-spaces.json` (generated, sourced from
 * the upstream block state declarations). **Not a single value domain is hardcoded here.**
 */

import POSE_SPACES from '../data/pose-spaces.json';

/** A value a block state can take. The upstream value domain as-is (string / number / boolean) */
export type StateValue = string | number | boolean;

/** state name → value domain. **Key order is the digit weight order** (first key is the most significant) */
export type StateSpace = Readonly<Record<string, readonly StateValue[]>>;

/** A single assignment. state name → value. **Never passed around in place of `Orientation`** */
export type StateAssignment = Readonly<Record<string, StateValue>>;

const SPACES: Readonly<Record<string, StateSpace>> = POSE_SPACES;

/** The pose space for a shape. An unknown shape **throws** (silently returning empty would make orientation disappear) */
export function stateSpaceOf(shape: string): StateSpace {
  const space = SPACES[shape];
  if (!space) throw new Error(`Unknown shape, no orientation assignment for it: ${shape} (try regenerating pose-spaces.json)`);
  return space;
}

/** Total number of poses a shape can take */
export function stateCountOf(shape: string): number {
  return Object.values(stateSpaceOf(shape)).reduce((n, values) => n * values.length, 1);
}

/**
 * Orientation code → pose.
 *
 * Digit weight follows `pose-spaces.json`'s key order (first key is the most significant).
 *
 * **An out-of-range code falls back to the default (all digits 0).** Wrapping it with modulo
 * instead would fabricate a nonexistent orientation as some other orientation (e.g. `full`'s
 * code 7 becoming the x axis). Corrupted values from save files do reach this function, so we
 * don't reject them outright, but they always fall back to the default
 * (validity checking is owned by the reader side's `isValidOrientationCode`).
 */
export function decodeStates(shape: string, code: number): StateAssignment {
  const space = stateSpaceOf(shape);
  const states: Record<string, StateValue> = {};
  const inRange = Number.isInteger(code) && code >= 0 && code < stateCountOf(shape);
  let rest = inRange ? code : 0;
  // Extracted from the least significant digit, so keys are walked in reverse order
  for (const name of Object.keys(space).reverse()) {
    const values = space[name]!;
    states[name] = values[rest % values.length]!;
    rest = Math.floor(rest / values.length);
  }
  return states;
}

/**
 * Assignment → orientation code.
 *
 * **Checks at the entry point that the set of state keys matches what's expected** — both
 * missing and extra keys are rejected. Silently dropping extras would break the central
 * contract "never ignore an unknown state" right at the runtime entry point, even though it's
 * upheld during generation (`poseStatesOf`). Values outside the value
 * domain are rejected too (never let an unknown value through to export).
 */
export function encodeStates(shape: string, states: StateAssignment): number {
  const space = stateSpaceOf(shape);
  const expected = Object.keys(space);
  const given = Object.keys(states);
  // **Never use `in`.** It walks the prototype chain, which would let names inherited from
  // Object.prototype (like `toString`) slip through as "a known state"
  //
  const extra = given.filter((name) => !Object.hasOwn(space, name));
  const missing = expected.filter((name) => !Object.hasOwn(states, name));
  if (extra.length > 0 || missing.length > 0) {
    throw new Error(
      `${shape}'s states don't match what's expected (extra: ${extra.join(', ') || 'none'} / missing: ${missing.join(', ') || 'none'})`,
    );
  }
  let code = 0;
  for (const name of expected) {
    const values = space[name]!;
    const index = values.indexOf(states[name]!);
    if (index < 0) throw new Error(`${shape}'s ${name} has an unknown value: ${JSON.stringify(states[name])}`);
    code = code * values.length + index;
  }
  return code;
}

/**
 * Catches unhandled branches at compile time.
 *
 * When a shape is added, a spot that forgot to be added to a `switch` becomes a type error
 * here. Throws if this is ever reached at runtime (= reached from outside the type system) —
 * silently falling back to a default would let export quietly produce the wrong result.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled value ${JSON.stringify(value)}`);
}

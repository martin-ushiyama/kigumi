/**
 * The types of the pure functions in gen-textures.mjs that the tests reference.
 * The script itself stays JS (it is run directly from node).
 */

/**
 * The list of texture files to fetch (from the committed `src/data/textures.json` plus
 * `env-textures.json`). No side effects
 */
export declare function uniqueFiles(): string[];

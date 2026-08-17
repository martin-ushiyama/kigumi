// Verifies the layer dependency rules (docs/architecture.md is the source of truth)
// through filesystem resolution.
//
// Extracting imports with regular expressions can be sidestepped by other spellings —
// dynamic import / namespace import / ImportTypeNode / a different extension (an explicit
// `.js`) — as review demonstrated
// (probes: `import('../main')`, `import type * as S from '../state'`,
// `import type { X } from '../state.js'`). This module parses the AST with the TypeScript
// Compiler API before deciding the layer, so it holds regardless of how the import is written.
// CI runs it through tests/architecture.test.ts.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SRC_ROOT = resolve(__dirname, '../src');
export const REPO_ROOT = resolve(__dirname, '..');

// Dependency direction (docs/architecture.md):
//   core → editor → { input, ui, render, project, export } → state → services → main
// state.ts is the store for global mutable state. Reading and writing it as values and
// functions from the same tier (input/ui/render/project/export) is a legitimate use — what
// is forbidden is only the reverse flow of "borrowing a type from state" (clarified after
// review). services/ holds aggregate services constructed and injected by main.ts,
// the composition root (ProjectService and friends) — it may depend on the five
// horizontal layers and on state, but they never depend on services/ (only main assembles
// services/, which keeps the graph acyclic).
// main.ts is the composition root and is imported by nobody, so it is treated only as a
// dependency source and is excluded from the dependency-target check.
const LAYER_DIRS = ['core', 'editor', 'input', 'ui', 'render', 'project', 'export', 'services'];
const HORIZONTAL = ['input', 'ui', 'render', 'project', 'export'];

const ALLOWED = {
  core: [],
  editor: ['core'],
  input: ['core', 'editor', ...HORIZONTAL, 'state'],
  ui: ['core', 'editor', ...HORIZONTAL, 'state'],
  render: ['core', 'editor', ...HORIZONTAL, 'state'],
  project: ['core', 'editor', ...HORIZONTAL, 'state'],
  export: ['core', 'editor', ...HORIZONTAL, 'state'],
  state: ['core'],
  services: ['core', 'editor', ...HORIZONTAL, 'state'],
};

const CODE_EXTENSIONS = ['.ts', '.tsx'];
const KNOWN_MODULE_EXTENSIONS = /\.(js|mjs|cjs|jsx|ts|tsx)$/;

export function walkFiles(dir, extensions = CODE_EXTENSIONS) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, extensions));
    } else if (entry.isFile() && extensions.includes(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Collects every dependency in a file (static import / dynamic import / re-export /
 * ImportTypeNode) from the AST. Each entry is { spec, typeOnly } — `typeOnly` says whether the
 * dependency is used only as a type (the value part and the type part of a mixed import are
 * reported as separate entries).
 * `unresolvableDynamicImports` counts dynamic imports whose target cannot be determined
 * statically, such as `import(\`../\${x}\`)` where the argument is an interpolated template
 * literal (the project uses no dynamic imports at all, so these are treated as violations
 * across the board — raised again in review).
 */
function extractDependencies(file) {
  const text = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const deps = [];
  const allDeps = [];
  let unresolvableDynamicImports = 0;

  function push(spec, typeOnly) {
    if (typeof spec !== 'string') return;
    allDeps.push({ spec, typeOnly });
    if (spec.startsWith('.')) deps.push({ spec, typeOnly });
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (!clause) {
        push(spec, false); // side-effect import: import '../foo'
      } else if (clause.isTypeOnly) {
        push(spec, true); // import type {...} / import type X from '...' / import type * as X
      } else {
        let hasValue = !!clause.name; // default import
        let hasType = false;
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) {
          hasValue = true; // import * as X (the type-only form is handled by the isTypeOnly branch above)
        } else if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            if (el.isTypeOnly) hasType = true;
            else hasValue = true;
          }
        }
        if (hasValue) push(spec, false);
        if (hasType) push(spec, true);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      push(node.moduleReference.expression.text, !!node.isTypeOnly);
    } else if (node.moduleSpecifier && ts.isExportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (node.isTypeOnly) {
        push(spec, true); // export type {...} from '...' / export type * from '...'
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        // export { state, type Tool } from '../state' — inspect isTypeOnly on each specifier
        // (the group-level isTypeOnly alone misses the type part of a mixed export)
        let hasValue = false;
        let hasType = false;
        for (const el of node.exportClause.elements) {
          if (el.isTypeOnly) hasType = true;
          else hasValue = true;
        }
        if (hasValue) push(spec, false);
        if (hasType) push(spec, true);
      } else {
        push(spec, false); // export * from '...' / export * as X from '...' re-export values
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      // A template literal (`../main`) can also be the argument of a dynamic import, so match
      // with isStringLiteralLike rather than isStringLiteral (interpolated forms are out of
      // reach of static analysis)
      if (arg && ts.isStringLiteralLike(arg)) {
        push(arg.text, false); // dynamic import: import('...') / import(`...`)
      } else {
        // An interpolated form such as import(`../${x}`) has no statically determinable target,
        // so it is a violation across the board
        unresolvableDynamicImports += 1;
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      push(node.argument.literal.text, true); // import('../state').Tool
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { deps, allDeps, unresolvableDynamicImports };
}

/**
 * DOM primitives are the bottom of the UI layer and deliberately have no module
 * dependencies, including type-only and package imports.
 */
export function checkPrimitiveDependencies(
  srcRoot = SRC_ROOT,
  primitiveRelativePath = join('ui', 'primitives.ts'),
) {
  const file = join(srcRoot, primitiveRelativePath);
  const { allDeps, unresolvableDynamicImports } = extractDependencies(file);
  const rel = relative(srcRoot, file);
  const violations = allDeps.map(
    ({ spec, typeOnly }) =>
      `${rel}: DOM primitive dependency is forbidden (${typeOnly ? 'type ' : ''}import "${spec}")`,
  );
  if (unresolvableDynamicImports > 0) {
    violations.push(`${rel}: DOM primitive dynamic import must not contain interpolation`);
  }
  return violations;
}

/**
 * Classifies an absolute path under the src root as a regulated layer name ('core' and
 * friends), 'state', 'main', or null (not covered by the rules).
 */
function layerOf(absPath) {
  const rel = relative(SRC_ROOT, absPath);
  if (rel.startsWith('..')) return null; // outside src (this is where three and other packages drop out)
  const segments = rel.split(sep);
  const top = segments[0];
  if (LAYER_DIRS.includes(top)) return top;
  if (rel === 'state.ts') return 'state';
  if (rel === 'main.ts') return 'main';
  return null; // data/ and the like, outside the dependency rules
}

/**
 * Resolves a module specifier to a file path. On top of the omitted extension (bundler
 * resolution), an explicit `.js` (`../state.js`) must resolve to the same file, so a known
 * extension is stripped before `.ts` is appended (layerOf could be dodged by
 * spelling a different extension).
 */
function resolveSpecifier(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const stripped = base.replace(KNOWN_MODULE_EXTENSIONS, '');
  return `${stripped}.ts`;
}

/**
 * Detects every violation of the layer dependency graph (static import, dynamic import,
 * re-export and ImportTypeNode included).
 * @returns {string[]} the violation messages (empty when there are none)
 */
export function checkLayerDependencies(srcRoot = SRC_ROOT) {
  const violations = [];
  for (const file of walkFiles(srcRoot)) {
    const fromLayer = layerOf(file);
    if (fromLayer === null || fromLayer === 'main') continue; // main.ts does the wiring; not checked as a dependency source
    const { deps, unresolvableDynamicImports } = extractDependencies(file);
    if (unresolvableDynamicImports > 0) {
      violations.push(
        `${relative(srcRoot, file)}: a dynamic import whose target cannot be resolved statically (an interpolated template literal, etc.) is forbidden`,
      );
    }
    for (const { spec } of deps) {
      const resolved = resolveSpecifier(file, spec);
      const toLayer = layerOf(resolved);
      if (toLayer === null || toLayer === fromLayer) continue;
      if (toLayer === 'main') {
        violations.push(`${relative(srcRoot, file)}: depending on main (the composition root) is forbidden (import "${spec}")`);
        continue;
      }
      if (!ALLOWED[fromLayer].includes(toLayer)) {
        violations.push(`${relative(srcRoot, file)}: the ${fromLayer} → ${toLayer} dependency is forbidden (import "${spec}")`);
      }
    }
  }
  return violations;
}

/**
 * Detects type-only dependencies on state.ts (`import type`, a `type X` inside a mixed
 * import, a namespace type import, an ImportTypeNode, a type re-export — every spelling).
 * state.ts may be depended on by the five horizontal layers as the provider of values and
 * functions (it is the global store), but types are collected in core/types.ts by convention
 * (do not let the render → state type dependency come back; also close the
 * namespace-import and `.js`-extension escapes), so types alone are forbidden here.
 * @returns {string[]} the violation messages (empty when there are none)
 */
export function checkStateTypeImports(srcRoot = SRC_ROOT) {
  const violations = [];
  for (const file of walkFiles(srcRoot)) {
    const fromLayer = layerOf(file);
    if (fromLayer === null || fromLayer === 'main' || fromLayer === 'state') continue;
    const { deps } = extractDependencies(file);
    for (const { spec, typeOnly } of deps) {
      if (!typeOnly) continue;
      if (layerOf(resolveSpecifier(file, spec)) !== 'state') continue;
      violations.push(`${relative(srcRoot, file)}: a type import from state.ts is forbidden — put types in core/types.ts (import "${spec}")`);
    }
  }
  return violations;
}

/**
 * Detects Japanese literals written directly into a display layer.
 *
 * The contract is that "wording the user sees goes through t()", but at first that
 * contract rested on **the author enumerating the sites**. The same hole therefore appeared
 * twice: the 2D pane names (index.html), then the region aria-labels (index.html). Closing it
 * by enumeration guarantees a third occurrence, so it is caught by machine instead.
 *
 * The scope is **the layers the user's eye reaches** (input / ui / project / export /
 * services). core / editor / main are not display layers (core/i18n.ts is the dictionary
 * itself, editor is contracted to return keys, and main is the composition root that holds
 * the hotkey descriptions).
 *
 * Excluded:
 * - the argument of a `throw` — because **the display boundary is guaranteed by types not to
 *   emit a raw message** (the mandatory fallback in `state.errorText(e, fallback)`
 *   review round 3). Through round 2 this was explained as "a throw is for developers", which
 *   was wrong — the Japanese throw in `persistence.ts` reached a toast through the
 *   `ProjectService` catch. The grounds for the exclusion are not the nature of a throw but
 *   **that the boundary always resolves to localized wording**
 * - `ui/help.ts` — the bilingual table for the control guide (the pairing is the content)
 * - a line preceded by `// i18n-allow: <reason>` — the escape hatch for deliberate pairing,
 *   which forces a reason to be written
 *
 * index.html is read by the same rule. Looking only at `src/**` is what caused the round 1
 * oversight.
 * @returns {string[]} the violation messages (empty when there are none)
 */
const DISPLAY_LAYERS = ['input', 'ui', 'project', 'export', 'services'];
// Hiragana, katakana and Han, by Unicode script extensions rather than by hand-written ranges.
// Spelled out as ranges this kept missing things: half-width katakana, the ideographic zero, the
// extension blocks, the kanji outside the basic plane.
//
// Script *extensions* rather than Script, because several marks Japanese is written with — the
// prolonged sound mark, the closing mark, the ideographic full stop — have Common as their
// primary script and a bare Script= test lets them through on their own.
//
// U+00B7, the middle dot, is taken back out. Its extensions include Han, but it turns up in
// ordinary English and failing a change for it would be a puzzle rather than a finding.
//
// The characters themselves are not written here. This guard rejects them in a comment, and
// naming them would make the file that defines the rule the only one to break it.
const JAPANESE = /[[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]--[·]]/v;
const ALLOW_MARKER = 'i18n-allow';
const LITERAL_ALLOWED_FILES = [join('ui', 'help.ts')];

export function checkDisplayLiterals(srcRoot = SRC_ROOT, htmlFile = resolve(srcRoot, '..', 'index.html')) {
  const violations = [];

  for (const file of walkFiles(srcRoot)) {
    const rel = relative(srcRoot, file);
    if (!DISPLAY_LAYERS.includes(layerOf(file))) continue;
    if (LITERAL_ALLOWED_FILES.some((allowed) => rel === allowed)) continue;

    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

    const visit = (node) => {
      const isLiteral =
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node);
      if (isLiteral && JAPANESE.test(node.text)) {
        let insideThrow = false;
        for (let p = node.parent; p; p = p.parent) {
          if (ts.isThrowStatement(p)) {
            insideThrow = true;
            break;
          }
        }
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const allowed = (lines[line - 1] ?? '').includes(ALLOW_MARKER) || (lines[line] ?? '').includes(ALLOW_MARKER);
        if (!insideThrow && !allowed) {
          violations.push(
            `${rel}:${line + 1}: a Japanese literal in a display layer "${node.text.slice(0, 24)}" — route it through t() (if deliberate, put // ${ALLOW_MARKER}: <reason> on the line above)`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  // index.html — wording in the static markup goes through data-i18n-text / data-i18n-aria
  const html = readFileSync(htmlFile, 'utf8');
  html.split(/\r?\n/).forEach((line, i) => {
    if (!JAPANESE.test(line) || line.includes(ALLOW_MARKER)) return;
    violations.push(
      `index.html:${i + 1}: Japanese in the static markup — route it through t() with data-i18n-text / data-i18n-aria`,
    );
  });

  return violations;
}

/**
 * Detects places that read the raw `message` of an exception.
 *
 * What lets `checkDisplayLiterals` leave throws out of its scope is that "the display
 * boundary never emits a raw message". The mandatory fallback in `errorText(e, fallback)` put
 * those grounds into the type system **inside the boundary**, but **a path that bypasses the
 * boundary and assembles `e.message` by hand** could not be prevented by types (the
 * `file.text()` failure in `main.ts` was actually leaking that way).
 *
 * So "only `state.ts` (the implementation of the boundary) may read `.message`" is fixed by
 * machine. Writing the bypass makes CI fail on the spot, so the throw exclusion in
 * `checkDisplayLiterals` keeps its grounds alive.
 *
 * ## Detection scope (a non-blocking note from review)
 *
 * **This is a guard that rejects the *syntax* of reading `message`; it does not prove the
 * dataflow of whether an exception value reaches the display.** It cannot be read as "the
 * guard exists, therefore display paths are safe" — all it guarantees is that no spelling
 * which pulls a value out under the name `message` exists outside state.ts.
 *
 * Caught (**every read whose key is statically determined**):
 * - `e.message` (property access)
 * - `e['message']` / `` e[`message`] `` (string-literal index)
 * - `const { message } = e` / `const { message: m } = e` (destructuring)
 * - `const { 'message': m } = e` / `const { ['message']: m } = e`
 *
 * Not caught (**bypasses that can still be written**):
 * - `String(e)` / `` `${e}` `` — stringifies without reading message, so the raw wording of an
 *   exception can reach the display
 * - `e[key]` — a dynamic index. The key is not statically determined, so syntax cannot decide it
 * - any dataflow that goes through an intermediate variable
 *
 * These three are **not determined by syntax** (`String(x)` needs to know whether `x` is an
 * exception, `e[key]` needs the value of key, and dataflow needs reachability). Adding type
 * information (`ts.Program`) would still drag legitimate stringification into `String(x)`, so
 * it produces too many false positives and **was judged not worth the cost**.
 * When adding a display path, do not lean on this guard — go through
 * `state.errorText(e, fallback)`.
 *
 * Excluded:
 * - `src/state.ts` — the implementation of the display boundary itself
 * - inside a `throw` — rewrapping a developer-facing exception (it does not reach a display path)
 * - a line preceded by `// i18n-allow: <reason>`
 * @returns {string[]} the violation messages (empty when there are none)
 */
/**
 * Extracts the statically determined string from a binding name. Returns undefined when it is
 * not determined (a dynamic key).
 *
 * `{ message }` appears as an Identifier, `{ 'message': m }` as a StringLiteral, and
 * `{ ['message']: m }` as a StringLiteral inside a ComputedPropertyName.
 * @param {import('typescript').PropertyName | import('typescript').BindingName} name
 * @returns {string | undefined}
 */
function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return undefined;
}

export function checkErrorMessageLeaks(srcRoot = SRC_ROOT) {
  const violations = [];
  for (const file of walkFiles(srcRoot)) {
    const rel = relative(srcRoot, file);
    if (rel === 'state.ts') continue;

    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

    /** Treats `e.message` and `const { message } = e` the same way */
    const readsMessage = (node) => {
      if (ts.isPropertyAccessExpression(node)) return node.name.text === 'message';
      // `e['message']` / `` e[`message`] `` — a string-literal index is statically determined
      if (ts.isElementAccessExpression(node)) {
        return ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'message';
      }
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        // `{ message: m }` puts it on propertyName, `{ message }` on name
        return propertyNameText(node.propertyName ?? node.name) === 'message';
      }
      return false;
    };

    const visit = (node) => {
      if (readsMessage(node)) {
        let insideThrow = false;
        for (let p = node.parent; p; p = p.parent) {
          if (ts.isThrowStatement(p)) {
            insideThrow = true;
            break;
          }
        }
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const allowed = (lines[line - 1] ?? '').includes(ALLOW_MARKER) || (lines[line] ?? '').includes(ALLOW_MARKER);
        if (!insideThrow && !allowed) {
          violations.push(
            `${rel}:${line + 1}: reading the raw message of an exception — display it through state.errorText(e, fallback) (if deliberate, put // ${ALLOW_MARKER}: <reason> on the line above)`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations;
}

/**
 * Detects translations baked in at module initialization.
 *
 * `t(key)` resolves in **the language at the moment it is called**. Evaluating it at the top
 * level of a module freezes the value in the language at load time, so an old label survives
 * a language switch and a redraw. `CATEGORY_LABELS` in `blockchangepicker.ts` was exactly
 * this: start in EN, switch to JA, and only the picker categories stayed English.
 *
 * `palette.ts` had already hit the same trap and left a warning in a comment, but
 * **a comment could not stop the file next door from repeating it**. Close it by machine
 * rather than by the reader's attention.
 *
 * Decision: a `t(...)` call is a violation when it has no function, method or class among its
 * ancestors (= it sits where it is evaluated once, at module initialization). Inside a
 * function it resolves in the current language on every call, which is fine.
 *
 * Excluded:
 * - `src/core/i18n.ts` — the implementation of `t` itself
 * - a line preceded by `// i18n-allow: <reason>`
 * @returns {string[]} the violation messages (empty when there are none)
 */
export function checkFrozenTranslations(srcRoot = SRC_ROOT) {
  const violations = [];
  const FUNCTION_LIKE = (node) =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node);

  for (const file of walkFiles(srcRoot)) {
    const rel = relative(srcRoot, file);
    if (rel === join('core', 'i18n.ts') || rel === 'core/i18n.ts') continue;

    const text = readFileSync(file, 'utf8');
    if (!text.includes('t(')) continue;
    const lines = text.split(/\r?\n/);
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
        let insideFunction = false;
        for (let p = node.parent; p; p = p.parent) {
          if (FUNCTION_LIKE(p)) {
            insideFunction = true;
            break;
          }
        }
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const allowed = (lines[line - 1] ?? '').includes(ALLOW_MARKER) || (lines[line] ?? '').includes(ALLOW_MARKER);
        if (!insideFunction && !allowed) {
          violations.push(
            `${rel}:${line + 1}: a translation evaluated at module initialization — an old label survives a language switch. Resolve it in a function that runs on every draw (if deliberate, put // ${ALLOW_MARKER}: <reason> on the line above)`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations;
}

/**
 * Every comment in a tracked file must be written in English.
 *
 * This repository is published, so the explanation of the code has to be readable by anyone who
 * opens it. What is **not** restricted is Japanese inside string literals and data: this app
 * displays Japanese, so the translation dictionary, the block names, and the tests that assert
 * on the Japanese UI all legitimately contain it.
 *
 * The distinction is therefore not "which file" but "where in the file". Excluding by path was
 * considered and rejected: the dictionary, the block data, and roughly a dozen test files would
 * all end up on the exclusion list, and a list that long stops checking anything.
 *
 * Markdown is out of scope (it has no comments), which is also what lets README.ja.md exist.
 *
 * A line carrying `// i18n-allow: <reason>` (or preceded by one) is let through, for the case
 * where the comment is *about* Japanese and rewriting it in English would destroy the point.
 *
 * @returns {string[]} the violation messages (empty when there are none)
 */
const SCANNER_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts']);
const HASH_COMMENT_EXTENSIONS = new Set(['.yml', '.yaml']);
const HASH_COMMENT_NAMES = new Set(['.gitignore', '.gitattributes', '.nvmrc']);
// [open, close, whether quotes in this syntax delimit strings]
const BLOCK_COMMENT_DELIMITERS = new Map([
  ['.css', ['/*', '*/', true]],
  ['.html', ['<!--', '-->', false]],
  // SVG uses the same comment syntax as HTML. Without this entry a Japanese comment in a tracked
  // graphic would be read by nothing: this guard would skip the file, and the document guard
  // treats SVG as markup rather than prose.
  ['.svg', ['<!--', '-->', false]],
]);

/**
 * Every comment range in a TS/JS source, collected through the parser.
 *
 * Driving `ts.createScanner` by hand does not survive interpolated templates: after the `}` that
 * closes `${...}` the scanner has to be told to re-scan the template tail, and without that the
 * rest of the template swallows the tokens that follow. A comment sitting after such a template
 * was silently absorbed — the guard would pass a file it should have failed (review finding).
 * Walking the parsed tree and asking for the comment ranges around each node avoids the problem
 * entirely, because the parser already handled the re-scanning.
 */
function commentRanges(text, ext) {
  // JSX text is not TypeScript. Parsed as TS, a URL inside JSX text reads as the start of a
  // `//` comment and the guard rejects data (review finding).
  const tsx = ext === '.tsx';
  const sourceFile = ts.createSourceFile(
    tsx ? '__lint__.tsx' : '__lint__.ts',
    text,
    ts.ScriptTarget.ES2022,
    true,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found = new Map();
  const collect = (ranges) => {
    for (const range of ranges ?? []) found.set(range.pos, range);
  };
  // getChildren() rather than forEachChild(): the latter skips punctuation tokens, so a comment
  // that is the entire body of something — `function f() { /* ... */ }` — has no node next to it
  // and never gets queried (review finding). Descending to the tokens puts the closing brace in
  // reach, and the comment hangs off its leading trivia.
  const visit = (node) => {
    collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(text, node.getEnd()));
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  return [...found.values()];
}

function japaneseInScannedComments(text, ext) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (const range of commentRanges(text, ext)) {
    const body = text.slice(range.pos, range.end);
    if (!JAPANESE.test(body)) continue;
    const openedAt = text.slice(0, range.pos).split('\n').length;
    // A multi-line comment reports every line the Japanese is actually on, not the line the
    // comment opens on — otherwise a long block comment always points at its first line.
    body.split('\n').forEach((bodyLine, offset) => {
      if (!JAPANESE.test(bodyLine)) return;
      const line = openedAt + offset;
      if (bodyLine.includes(ALLOW_MARKER) || (lines[line - 2] ?? '').includes(ALLOW_MARKER)) return;
      hits.push({ line, sample: bodyLine.trim() });
    });
  }
  return hits.sort((a, b) => a.line - b.line);
}

/**
 * Where a `#` comment starts on this line, or -1 when the line has none.
 *
 * A bare `indexOf('#')` is not good enough: in YAML a hash inside a quoted scalar is data, and
 * flagging `name: "# ..."` would contradict the contract that Japanese is allowed in literals.
 * A `#` also only opens a comment at the start of the line or after whitespace, so `a#b` is a
 * value. That is as far as this goes — pulling in a full YAML parser to decide where a comment
 * begins would cost far more than it settles.
 */
function hashCommentStart(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return i;
  }
  return -1;
}

const INDENT_OF = (line) => line.length - line.trimStart().length;
// `run: |`, `description: >-`, `body: |2` — a block scalar header. Everything indented deeper
// than the header is data, not YAML, so a `#` in there does not open a comment.
const BLOCK_SCALAR_HEADER = /:\s*[|>][-+]?\d*\s*$/;

function japaneseInHashComments(text) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  let blockIndent = null;

  lines.forEach((line, i) => {
    if (blockIndent !== null) {
      // A blank line does not end a block scalar; a line at or left of the header's indent does.
      if (line.trim() === '' || INDENT_OF(line) > blockIndent) return;
      blockIndent = null;
    }
    const hash = hashCommentStart(line);
    // The header is recognised from the code part alone. A header may carry its own trailing
    // comment (`run: | # why`), and keying off "this line has no comment" would leave the block
    // unnoticed and report its data as comments (review finding). The trailing comment on the
    // header is still a real comment, so the check below continues to run on it.
    if (BLOCK_SCALAR_HEADER.test(hash < 0 ? line : line.slice(0, hash))) blockIndent = INDENT_OF(line);
    if (hash < 0) return;
    const comment = line.slice(hash);
    if (!JAPANESE.test(comment)) return;
    if (comment.includes(ALLOW_MARKER) || (lines[i - 1] ?? '').includes(ALLOW_MARKER)) return;
    hits.push({ line: i + 1, sample: comment.trim() });
  });
  return hits;
}

/**
 * The next `open` delimiter at or after `from`, skipping any that sit inside a string.
 *
 * CSS does have strings, and a `content` value that spells out the comment delimiters is data
 * rather than a comment (review finding). HTML is treated differently: its quotes only delimit
 * attribute values, and an apostrophe in ordinary prose would otherwise be read as opening a
 * string, so `respectStrings` is off for it.
 */
function delimiterOutsideStrings(text, open, from, respectStrings) {
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (respectStrings && (ch === '"' || ch === "'")) {
      quote = ch;
      continue;
    }
    if (text.startsWith(open, i)) return i;
  }
  return -1;
}

/**
 * Japanese inside `open`/`close` delimited comments (CSS, HTML).
 */
function japaneseInBlockComments(text, open, close, respectStrings) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  let cursor = 0;
  for (;;) {
    const start = delimiterOutsideStrings(text, open, cursor, respectStrings);
    if (start < 0) break;
    const endBody = text.indexOf(close, start + open.length);
    const end = endBody < 0 ? text.length : endBody + close.length;
    const body = text.slice(start, end);
    if (JAPANESE.test(body)) {
      const openedAt = text.slice(0, start).split('\n').length;
      body.split('\n').forEach((bodyLine, offset) => {
        if (!JAPANESE.test(bodyLine)) return;
        const line = openedAt + offset;
        if (bodyLine.includes(ALLOW_MARKER) || (lines[line - 2] ?? '').includes(ALLOW_MARKER)) return;
        hits.push({ line, sample: bodyLine.trim() });
      });
    }
    cursor = end;
  }
  return hits;
}

export function checkCommentLanguage(repoRoot = REPO_ROOT, relPaths = null) {
  const violations = [];
  const tracked =
    relPaths ??
    execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);

  for (const rel of tracked) {
    const ext = extname(rel);
    const base = rel.split('/').pop() ?? rel;
    const scanned = SCANNER_EXTENSIONS.has(ext);
    const hashed = HASH_COMMENT_EXTENSIONS.has(ext) || HASH_COMMENT_NAMES.has(base);
    const delimiters = BLOCK_COMMENT_DELIMITERS.get(ext);
    if (!scanned && !hashed && !delimiters) continue;

    let text;
    try {
      text = readFileSync(join(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    const hits = scanned
      ? japaneseInScannedComments(text, ext)
      : hashed
        ? japaneseInHashComments(text)
        : japaneseInBlockComments(text, delimiters[0], delimiters[1], delimiters[2]);
    for (const hit of hits) {
      violations.push(`${rel}:${hit.line}: a Japanese comment — comments must be written in English "${hit.sample.slice(0, 40)}"`);
    }
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = [
    ...checkLayerDependencies(),
    ...checkStateTypeImports(),
    ...checkPrimitiveDependencies(),
    ...checkDisplayLiterals(),
    ...checkErrorMessageLeaks(),
    ...checkFrozenTranslations(),
    ...checkCommentLanguage(),
  ];
  if (violations.length > 0) {
    console.error('architecture-lint: violations found\n');
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log('architecture-lint: OK (the DOM independence of editor is covered by the tsconfig.editor.json check in `npm run typecheck`)');
}

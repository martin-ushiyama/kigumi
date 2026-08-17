import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkCommentLanguage,
  checkDisplayLiterals,
  checkErrorMessageLeaks,
  checkFrozenTranslations,
  checkLayerDependencies,
  checkPrimitiveDependencies,
  checkStateTypeImports,
  SRC_ROOT,
} from '../scripts/architecture-lint.mjs';

const REPO_ROOT = join(SRC_ROOT, '..');

// Launching the .cmd wrapper through npx tends to hang under execFileSync on Windows, so we
// invoke tsc's JS entry point directly with node (works reliably on both Windows and Linux).
const TSC_ENTRY = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc6');

function runEditorTypecheck(): { ok: boolean; output: string } {
  try {
    const output = execFileSync(process.execPath, [TSC_ENTRY, '--noEmit', '-p', 'tsconfig.editor.json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('architecture-lint — the current source satisfies the layer dependency rules', () => {
  it('checkLayerDependencies: zero violations (covers static import / dynamic import / re-export / ImportTypeNode)', () => {
    expect(checkLayerDependencies()).toEqual([]);
  });

  it('checkStateTypeImports: zero violations (types live in core/types.ts; alternate forms such as namespace imports are checked too)', () => {
    expect(checkStateTypeImports()).toEqual([]);
  });

  it('checkPrimitiveDependencies: ui/primitives.ts has no module dependencies', () => {
    expect(checkPrimitiveDependencies()).toEqual([]);
  });

  it('checkDisplayLiterals: zero violations (no hardcoded Japanese in the display layer or index.html)', () => {
    expect(checkDisplayLiterals()).toEqual([]);
  });

  it('checkErrorMessageLeaks: zero violations (state.ts is the only place that reads a raw exception message)', () => {
    expect(checkErrorMessageLeaks()).toEqual([]);
  });

  it('checkFrozenTranslations: zero violations (translations are not baked in at module initialization)', () => {
    expect(checkFrozenTranslations()).toEqual([]);
  });

  it('checkCommentLanguage: zero violations (every comment in a tracked file is written in English)', () => {
    expect(checkCommentLanguage()).toEqual([]);
  });

  it('tsconfig.editor.json (DOM excluded from lib) type-checks everything under editor/ cleanly', () => {
    const result = runEditorTypecheck();
    expect(result.ok).toBe(true);
  });
});

describe('architecture-lint — the guards actually fire (regression tests keeping review findings from recurring)', () => {
  const probeFiles: string[] = [];
  const probeDirs: string[] = [];

  afterEach(() => {
    for (const f of probeFiles.splice(0)) {
      if (existsSync(f)) rmSync(f);
    }
    for (const d of probeDirs.splice(0).reverse()) {
      if (existsSync(d)) rmSync(d, { recursive: true });
    }
  });

  function writeProbe(relPath: string, content: string): string {
    const full = join(SRC_ROOT, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
    probeFiles.push(full);
    return full;
  }

  it('primitive dependency guard catches value, type-only, and package imports', () => {
    const probe = 'ui/__arch_probe_primitive__.ts';
    writeProbe(
      probe,
      "import type { Cell } from '../core/types';\nimport { state } from '../state';\nimport 'external-package';\nexport type _Probe = Cell;\nexport const value = state;\n",
    );
    const violations = checkPrimitiveDependencies(SRC_ROOT, probe);
    expect(violations).toHaveLength(3);
    expect(violations.some((v) => v.includes('type import "../core/types"'))).toBe(true);
    expect(violations.some((v) => v.includes('import "../state"'))).toBe(true);
    expect(violations.some((v) => v.includes('import "external-package"'))).toBe(true);
  });

  it('detects a reproduced render → state type import (keeps the violation fixed in that PR from returning)', () => {
    writeProbe('render/__arch_probe_state_type__.ts', "import type { DisplayMode } from '../state';\nexport type _Probe = DisplayMode;\n");
    const violations = checkStateTypeImports();
    expect(violations.some((v) => v.includes('render') && v.includes('state.ts'))).toBe(true);
  });

  it('detects the type portion of a mixed import (`import { type X, y } from "../state"`) too', () => {
    writeProbe(
      'ui/__arch_probe_state_mixed__.ts',
      "import { state, type DisplayMode } from '../state';\nexport const _probe = state;\nexport type _Probe = DisplayMode;\n",
    );
    const violations = checkStateTypeImports();
    expect(violations.some((v) => v.includes('ui'))).toBe(true);
  });

  it('detects a reproduced namespace type import (`import type * as X from "../state"`) (the loophole of only checking the {} form)', () => {
    writeProbe(
      'ui/__arch_probe_state_namespace__.ts',
      "import type * as StateTypes from '../state';\nexport type _Probe = StateTypes.Tool;\n",
    );
    const violations = checkStateTypeImports();
    expect(violations.some((v) => v.includes('ui') && v.includes('state.ts'))).toBe(true);
  });

  it('detects a reproduced state type dependency written with an extension (`from "../state.js"`) (dodging layerOf exact matching)', () => {
    writeProbe('render/__arch_probe_state_jsext__.ts', "import type { DisplayMode } from '../state.js';\nexport type _Probe = DisplayMode;\n");
    const violations = checkStateTypeImports();
    expect(violations.some((v) => v.includes('render') && v.includes('state.ts'))).toBe(true);
  });

  it('detects a reproduced template-literal dynamic import (`import(\\`../main\\`)`) (a repeat finding: missed because only StringLiteral was scanned)', () => {
    writeProbe('input/__arch_probe_dynamic_main_template__.ts', "export async function probe() {\n  return import(`../main`);\n}\n");
    const violations = checkLayerDependencies();
    expect(violations.some((v) => v.includes('input') && v.includes('main'))).toBe(true);
  });

  it('detects a reproduced type portion of a mixed re-export (`export { state, type Tool } from "../state"`) (a repeat finding: ExportSpecifier.isTypeOnly was not traversed)', () => {
    writeProbe('ui/__arch_probe_export_mixed__.ts', "export { state, type Tool } from '../state';\n");
    const violations = checkStateTypeImports();
    expect(violations.some((v) => v.includes('ui') && v.includes('state.ts'))).toBe(true);
  });

  it(
    'treats a dynamic import with interpolation (`import(\\`../${target}\\`)`) as a violation unconditionally, because the target cannot be resolved statically ' +
      '(a repeat finding: handling unused dynamic imports through a per-case allowlist leaves room for evasion; banning undecidability itself is safer)',
    () => {
      writeProbe(
        'input/__arch_probe_dynamic_interp__.ts',
        "const target = 'main';\nexport async function probe() {\n  return import(`../${target}`);\n}\n",
      );
      const violations = checkLayerDependencies();
      expect(violations.some((v) => v.includes('__arch_probe_dynamic_interp__') && v.includes('cannot be resolved statically'))).toBe(true);
    },
  );

  // --- Guard against hardcoded Japanese in the display layer ---
  // The same "missed translation" surfaced twice — first the 2D pane name, then the region
  // aria-label in index.html — so instead of enumerating cases we fail them mechanically.
  // These tests pin down that the guard actually fires.

  const CLEAN_HTML = join(SRC_ROOT, '..', 'index.html');

  function writeHtmlProbe(content: string): string {
    const full = join(SRC_ROOT, '__arch_probe_index__.html');
    writeFileSync(full, content);
    probeFiles.push(full);
    return full;
  }

  it('detects a Japanese literal in the display layer (ui)', () => {
    writeProbe('ui/__arch_probe_ja_literal__.ts', "export const label = '保存する';\n");
    const violations = checkDisplayLiterals(SRC_ROOT, CLEAN_HTML);
    expect(violations.some((v) => v.includes('__arch_probe_ja_literal__') && v.includes('保存する'))).toBe(true);
  });

  it('detects Japanese inside a template literal too (closing the string-literal-only loophole)', () => {
    writeProbe('input/__arch_probe_ja_template__.ts', 'export const label = (n: number) => `${n} 個を配置した`;\n');
    const violations = checkDisplayLiterals(SRC_ROOT, CLEAN_HTML);
    expect(violations.some((v) => v.includes('__arch_probe_ja_template__'))).toBe(true);
  });

  // throw can be excluded not because "throw is for developers" but because
  // **the type system guarantees the display boundary never emits a raw message** (raised in review).
  // That guarantee itself is pinned down by tests/i18n-boundary.test.ts.
  it('does not flag Japanese inside a throw (the display boundary never emits a raw message)', () => {
    writeProbe(
      'ui/__arch_probe_ja_throw__.ts',
      "export function probe(): never {\n  throw new Error('不正な状態');\n}\n",
    );
    expect(checkDisplayLiterals(SRC_ROOT, CLEAN_HTML).some((v) => v.includes('__arch_probe_ja_throw__'))).toBe(false);
  });

  it('a `// i18n-allow` on the preceding line permits an intentional bilingual label', () => {
    writeProbe(
      'ui/__arch_probe_ja_allow__.ts',
      "// i18n-allow: 切替ボタンは両言語を併記する\nexport const label = '日本語 / English';\n",
    );
    expect(checkDisplayLiterals(SRC_ROOT, CLEAN_HTML).some((v) => v.includes('__arch_probe_ja_allow__'))).toBe(false);
  });

  it('non-display layers (core / editor / main) are out of scope (they hold the dictionary and the key contract)', () => {
    writeProbe('core/__arch_probe_ja_core__.ts', "export const dictionaryEntry = '正面';\n");
    expect(checkDisplayLiterals(SRC_ROOT, CLEAN_HTML).some((v) => v.includes('__arch_probe_ja_core__'))).toBe(false);
  });

  // --- Guard against bypassing the display boundary ---
  // Making errorText's fallback mandatory protects "inside the boundary" through types, but a path
  // that assembles e.message on its own without passing through the boundary cannot be prevented by
  // types (the file.text() failure in main.ts actually leaked this way).

  it('detects a path that assembles e.message without going through the display boundary', () => {
    writeProbe(
      'ui/__arch_probe_msg_leak__.ts',
      'export function probe(e: unknown): string {\n  return e instanceof Error ? e.message : String(e);\n}\n',
    );
    const violations = checkErrorMessageLeaks();
    expect(violations.some((v) => v.includes('__arch_probe_msg_leak__') && v.includes('errorText'))).toBe(true);
  });

  it('detects the bypass in main.ts (composition root) too — this is where it actually leaked', () => {
    writeProbe(
      'input/__arch_probe_msg_leak_input__.ts',
      'export const show = (e: Error): string => e.message;\n',
    );
    expect(checkErrorMessageLeaks().some((v) => v.includes('__arch_probe_msg_leak_input__'))).toBe(true);
  });

  it('detects a bypass that pulls message out through destructuring', () => {
    writeProbe(
      'ui/__arch_probe_msg_destructure__.ts',
      'export function probe(e: Error): string {\n  const { message } = e;\n  return message;\n}\n',
    );
    expect(checkErrorMessageLeaks().some((v) => v.includes('__arch_probe_msg_destructure__'))).toBe(true);
  });

  it('detects renamed destructuring too', () => {
    writeProbe(
      'ui/__arch_probe_msg_renamed__.ts',
      'export function probe(e: Error): string {\n  const { message: text } = e;\n  return text;\n}\n',
    );
    expect(checkErrorMessageLeaks().some((v) => v.includes('__arch_probe_msg_renamed__'))).toBe(true);
  });

  it('does not flag destructuring of properties other than message (a false-positive guard)', () => {
    writeProbe(
      'ui/__arch_probe_msg_other__.ts',
      'export function probe(o: { name: string; cause: string }): string {\n  const { name, cause } = o;\n  return name + cause;\n}\n',
    );
    expect(checkErrorMessageLeaks().some((v) => v.includes('__arch_probe_msg_other__'))).toBe(false);
  });

  it('detects reading message through a string-literal index too', () => {
    writeProbe(
      'ui/__arch_probe_msg_bracket__.ts',
      "export const show = (e: Error): string => e['message'];\n",
    );
    expect(checkErrorMessageLeaks().some((v) => v.includes('__arch_probe_msg_bracket__'))).toBe(true);
  });

  it('detects destructuring with a computed key too', () => {
    writeProbe(
      'ui/__arch_probe_msg_computed__.ts',
      "export function probe(e: Error): string {\n  const { ['message']: text } = e;\n  return text;\n}\n",
    );
    expect(checkErrorMessageLeaks().some((v) => v.includes('__arch_probe_msg_computed__'))).toBe(true);
  });

  it('does not flag indexing with a dynamic key — the key is not determined statically', () => {
    // Pin down that this is out of scope. The reason it cannot be caught is
    // "not decidable from the syntax", not "type information is required".
    writeProbe(
      'ui/__arch_probe_msg_dynamic__.ts',
      "export const show = (e: Error, key: 'message'): string => e[key];\n",
    );
    expect(checkErrorMessageLeaks().some((v) => v.includes('__arch_probe_msg_dynamic__'))).toBe(false);
  });

  it('does not flag String(e) — pins down that it is outside the syntactic guard', () => {
    // Explicitly pin down what cannot be caught. So nobody later reads this as "the guard
    // exists, therefore we are safe", the detection scope is recorded in the tests and not
    // only in a doc comment (that assumption is exactly what caused four review rounds).
    writeProbe(
      'ui/__arch_probe_msg_stringify__.ts',
      'export const show = (e: unknown): string => String(e);\n',
    );
    expect(checkErrorMessageLeaks().some((v) => v.includes('__arch_probe_msg_stringify__'))).toBe(false);
  });

  it('allows re-wrapping an exception inside a throw (it never reaches the display path)', () => {
    writeProbe(
      'project/__arch_probe_msg_rethrow__.ts',
      "export function probe(e: unknown): never {\n  throw new Error(`wrapped: ${e instanceof Error ? e.message : ''}`, { cause: e });\n}\n",
    );
    expect(checkErrorMessageLeaks().some((v) => v.includes('__arch_probe_msg_rethrow__'))).toBe(false);
  });

  it('a `// i18n-allow` on the preceding line grants a case-by-case exemption', () => {
    writeProbe(
      'ui/__arch_probe_msg_allow__.ts',
      '// i18n-allow: 開発者向けの診断出力\nexport const show = (e: Error): string => e.message;\n',
    );
    expect(checkErrorMessageLeaks().some((v) => v.includes('__arch_probe_msg_allow__'))).toBe(false);
  });

  it('detects hardcoded Japanese in index.html (exactly the path missed in round 1)', () => {
    const html = writeHtmlProbe('<nav id="toolbar" aria-label="編集ツール"></nav>\n');
    const violations = checkDisplayLiterals(SRC_ROOT, html);
    expect(violations.some((v) => v.includes('index.html') && v.includes('data-i18n-aria'))).toBe(true);
  });

  it('passes index.html when it goes through data-i18n-aria', () => {
    const html = writeHtmlProbe('<nav id="toolbar" data-i18n-aria="aria.toolbar"></nav>\n');
    expect(checkDisplayLiterals(SRC_ROOT, html).some((v) => v.includes('index.html'))).toBe(false);
  });

  it('allows value imports from state.ts (state / setDisplayMode etc.) — legitimate as a global store', () => {
    writeProbe('render/__arch_probe_state_value__.ts', "import { state } from '../state';\nexport const _probe = state;\n");
    expect(checkLayerDependencies().some((v) => v.includes('state'))).toBe(false);
    expect(checkStateTypeImports().some((v) => v.includes('__arch_probe_state_value__'))).toBe(false);
  });

  it('detects a dependency from a core subdirectory to input regardless of nesting depth (dodging a fixed-depth pattern)', () => {
    probeDirs.push(join(SRC_ROOT, 'core', 'nested'));
    writeProbe('core/nested/__arch_probe_nested__.ts', "import type { Hit } from '../../input/picking';\nexport type _Probe = Hit;\n");
    const violations = checkLayerDependencies();
    expect(violations.some((v) => v.includes('core') && v.includes('input'))).toBe(true);
  });

  it('detects a static import dependency from input to main (main is the composition root; nothing may depend on it)', () => {
    writeProbe('input/__arch_probe_main__.ts', "import { state } from '../main';\nexport const _probe = state;\n");
    const violations = checkLayerDependencies();
    expect(violations.some((v) => v.includes('main'))).toBe(true);
  });

  it('detects a reproduced main dependency through a dynamic import (`import("../main")`) (the static-import-only loophole)', () => {
    writeProbe('input/__arch_probe_dynamic_main__.ts', "export async function probe() {\n  return import('../main');\n}\n");
    const violations = checkLayerDependencies();
    expect(violations.some((v) => v.includes('input') && v.includes('main'))).toBe(true);
  });

  it(
    'detects a reproduced dependency from a horizontal layer (input) to services ' +
      '(when the services layer was added it was only registered in ALLOWED — there was no regression fixture that actually violated the rule and failed)',
    () => {
      writeProbe('services/__arch_probe_services_target__.ts', 'export const probeValue = 1;\n');
      writeProbe(
        'input/__arch_probe_services_violation__.ts',
        "import { probeValue } from '../services/__arch_probe_services_target__';\nexport const _probe = probeValue;\n",
      );
      const violations = checkLayerDependencies();
      expect(violations.some((v) => v.includes('input') && v.includes('services'))).toBe(true);
    },
  );

  it(
    'catches editor referencing HTMLElement (a DOM type outside the 5 registered identifiers) through the tsconfig.editor.json type check ' +
      '(the limits of a fixed no-restricted-globals list. Dropping DOM from lib bans every DOM identifier without maintaining a fixed list)',
    () => {
      writeProbe('editor/__arch_probe_dom_type__.ts', 'export type T = HTMLElement;\nexport function probe(): string {\n  return document.title;\n}\n');
      const result = runEditorTypecheck();
      expect(result.ok).toBe(false);
      expect(result.output).toContain('HTMLElement');
    },
    15000,
  );

  it('detects a translation evaluated at module scope (keeps the regression where only the category kept its old label after a language switch from recurring)', () => {
    writeProbe(
      'ui/__arch_probe_frozen_t__.ts',
      "import { t } from '../state';\nconst LABELS = { a: t('palette.stone') };\nexport const probe = LABELS;\n",
    );
    const violations = checkFrozenTranslations();
    expect(violations.some((v) => v.includes('__arch_probe_frozen_t__'))).toBe(true);
  });

  it('does not flag a translation inside a function (it resolves in the current language on every call, which is the correct form)', () => {
    writeProbe(
      'ui/__arch_probe_live_t__.ts',
      "import { t } from '../state';\nexport function label(): string {\n  return t('palette.stone');\n}\n",
    );
    expect(checkFrozenTranslations().some((v) => v.includes('__arch_probe_live_t__'))).toBe(false);
  });

  it('passes a module-scope translation carrying an i18n-allow comment (an escape hatch for intentional baking)', () => {
    writeProbe(
      'ui/__arch_probe_allow_t__.ts',
      "import { t } from '../state';\n// i18n-allow: テスト用プローブ\nexport const label = t('palette.stone');\n",
    );
    expect(checkFrozenTranslations().some((v) => v.includes('__arch_probe_allow_t__'))).toBe(false);
  });

  it('comment-language guard catches Japanese in a line comment, a block comment, and a # comment', () => {
    const rel = 'src/ui/__arch_probe_comment_ja__.ts';
    writeProbe('ui/__arch_probe_comment_ja__.ts', '// これは日本語のコメント\n/**\n * ok\n * こちらも日本語\n */\nexport const probe = 1;\n');
    const violations = checkCommentLanguage(REPO_ROOT, [rel]);
    expect(violations).toHaveLength(2);
    // The block comment reports the line the Japanese is on, not the line it opens on.
    expect(violations.some((v) => v.includes(`${rel}:1`))).toBe(true);
    expect(violations.some((v) => v.includes(`${rel}:4`))).toBe(true);
  });

  it('does not flag Japanese inside string literals or data (this app displays Japanese, so it belongs there)', () => {
    const rel = 'src/ui/__arch_probe_comment_literal__.ts';
    writeProbe(
      'ui/__arch_probe_comment_literal__.ts',
      "// A dictionary entry, in English\nexport const dict = { layers: 'レイヤー', blocks: 'ブロック' };\nexport const note = '日本語のファイル名で書き出す';\n",
    );
    expect(checkCommentLanguage(REPO_ROOT, [rel])).toEqual([]);
  });

  it('passes a Japanese comment carrying an i18n-allow marker (for a comment that is itself about Japanese)', () => {
    const rel = 'src/ui/__arch_probe_comment_allow__.ts';
    writeProbe('ui/__arch_probe_comment_allow__.ts', '// i18n-allow: the wording matters — 「グループ」\nexport const probe = 1;\n');
    expect(checkCommentLanguage(REPO_ROOT, [rel])).toEqual([]);
  });

  it('comment-language guard reaches CSS and HTML comments too (review finding: those syntaxes were skipped entirely)', () => {
    const css = 'src/__arch_probe_comment__.css';
    const html = 'src/__arch_probe_comment__.html';
    writeProbe('__arch_probe_comment__.css', '/* 日本語のコメント */\n.probe { color: red; }\n');
    writeProbe('__arch_probe_comment__.html', '<!-- 日本語のコメント -->\n<p>ok</p>\n');
    expect(checkCommentLanguage(REPO_ROOT, [css])).toHaveLength(1);
    expect(checkCommentLanguage(REPO_ROOT, [html])).toHaveLength(1);
  });

  it('does not treat a hash inside a quoted YAML scalar as a comment (review finding: a bare indexOf flagged legitimate data)', () => {
    const rel = 'src/__arch_probe_comment__.yml';
    writeProbe('__arch_probe_comment__.yml', 'name: "# 日本語のデータ"\nsteps:\n  - run: echo ok # ok in English\n');
    expect(checkCommentLanguage(REPO_ROOT, [rel])).toEqual([]);
  });

  it('does not treat a hash inside a YAML block scalar as a comment (review finding: `run: |` bodies are data)', () => {
    const rel = 'src/__arch_probe_block_scalar__.yml';
    writeProbe('__arch_probe_block_scalar__.yml', 'steps:\n  - run: |\n      echo ok\n      # 日本語のデータ\n  - name: back to YAML # in English\n');
    expect(checkCommentLanguage(REPO_ROOT, [rel])).toEqual([]);
  });

  it('still catches a real YAML comment on the line after a block scalar ends', () => {
    const rel = 'src/__arch_probe_after_block__.yml';
    writeProbe('__arch_probe_after_block__.yml', 'steps:\n  - run: |\n      echo ok\n  # 日本語のコメント\n');
    expect(checkCommentLanguage(REPO_ROOT, [rel])).toHaveLength(1);
  });

  it('does not treat comment delimiters inside a CSS string as a comment (review finding: content: "/* ... */" is data)', () => {
    const rel = 'src/__arch_probe_css_string__.css';
    writeProbe('__arch_probe_css_string__.css', '.probe::after { content: "/* 日本語 */"; }\n');
    expect(checkCommentLanguage(REPO_ROOT, [rel])).toEqual([]);
  });

  it('catches a comment that follows an interpolated template (review finding: a hand-driven scanner swallowed it)', () => {
    const rel = 'src/ui/__arch_probe_template__.ts';
    writeProbe('ui/__arch_probe_template__.ts', 'const value = 1;\nexport const s = `x${value}y`; // 日本語のコメント\n');
    const violations = checkCommentLanguage(REPO_ROOT, [rel]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(`${rel}:2`);
  });

  it('does not report Japanese inside an interpolated template as if it were a comment', () => {
    const rel = 'src/ui/__arch_probe_template_literal__.ts';
    writeProbe('ui/__arch_probe_template_literal__.ts', 'const n = 1;\nexport const s = `${n} 個のブロック // これは文字列`;\n');
    expect(checkCommentLanguage(REPO_ROOT, [rel])).toEqual([]);
  });

  it('catches a comment that is the entire body of a block, with no node beside it (review finding)', () => {
    const rel = 'src/ui/__arch_probe_empty_body__.ts';
    writeProbe('ui/__arch_probe_empty_body__.ts', 'export function probe(): void {\n  /* 日本語のコメント */\n}\n');
    expect(checkCommentLanguage(REPO_ROOT, [rel])).toHaveLength(1);
  });

  it('catches a comment sitting after the last element, before a closing delimiter', () => {
    const rel = 'src/ui/__arch_probe_trailing_in_block__.ts';
    writeProbe('ui/__arch_probe_trailing_in_block__.ts', 'export const probe = [\n  1,\n  // 日本語のコメント\n];\n');
    expect(checkCommentLanguage(REPO_ROOT, [rel])).toHaveLength(1);
  });

  it('parses .tsx as TSX, so a URL in JSX text is not read as a comment (review finding)', () => {
    const rel = 'src/ui/__arch_probe_jsx__.tsx';
    writeProbe('ui/__arch_probe_jsx__.tsx', 'export const view = <p>https://example.test/日本語</p>;\n');
    expect(checkCommentLanguage(REPO_ROOT, [rel])).toEqual([]);
  });

  it('enters the block scalar even when its header carries a trailing comment (review finding)', () => {
    const rel = 'src/__arch_probe_block_inline__.yml';
    writeProbe('__arch_probe_block_inline__.yml', 'steps:\n  - run: | # explanation in English\n      echo ok\n      # 日本語のデータ\n');
    expect(checkCommentLanguage(REPO_ROOT, [rel])).toEqual([]);
  });

  it('still checks the trailing comment on a block-scalar header itself', () => {
    const rel = 'src/__arch_probe_block_header__.yml';
    writeProbe('__arch_probe_block_header__.yml', 'steps:\n  - run: | # 日本語の説明\n      echo ok\n');
    expect(checkCommentLanguage(REPO_ROOT, [rel])).toHaveLength(1);
  });
});

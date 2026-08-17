// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// The incompatibility between typescript@7 (the native compiler) and typescript-eslint
// (typescript-estree) is resolved by a side-by-side setup (see package.json): tsc / typecheck /
// build stay on TS7, and only what typescript-eslint `require('typescript')` resolves to is
// swapped for the TS6-compatible API (@typescript/typescript6). Official guidance:
// https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.shots/**', 'test-results/**', 'playwright-report/**'],
  },
  js.configs.recommended,
  {
    // Type-aware lint applies to what tsconfig.json includes (src / tests / e2e) plus the TS
    // config files at the repository root.
    files: ['src/**/*.ts', 'tests/**/*.ts', 'e2e/**/*.ts', 'vite.config.ts', 'playwright.config.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Layer dependency rules (docs/architecture.md is the source of truth):
    //   core/domain → editor/application → input / ui / render / project / export → main
    // core/domain cannot depend on any other layer (it is self-contained).
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['../editor/*', '../editor'], message: 'core cannot depend on editor (see docs/architecture.md)' },
            { group: ['../input/*', '../input'], message: 'core cannot depend on input (see docs/architecture.md)' },
            { group: ['../ui/*', '../ui'], message: 'core cannot depend on ui (see docs/architecture.md)' },
            { group: ['../render/*', '../render'], message: 'core cannot depend on render (see docs/architecture.md)' },
            { group: ['../project/*', '../project'], message: 'core cannot depend on project (see docs/architecture.md)' },
            { group: ['../export/*', '../export'], message: 'core cannot depend on export (see docs/architecture.md)' },
            { group: ['../state', '../main'], message: 'core cannot depend on state/main, the composition root (see docs/architecture.md)' },
          ],
        },
      ],
    },
  },
  {
    // editor/application may depend on core only (not on the DOM, Three.js, or other layers).
    files: ['src/editor/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['../input/*', '../input'], message: 'editor cannot depend on input (see docs/architecture.md)' },
            { group: ['../ui/*', '../ui'], message: 'editor cannot depend on ui (see docs/architecture.md)' },
            { group: ['../render/*', '../render'], message: 'editor cannot depend on render (see docs/architecture.md)' },
            { group: ['../project/*', '../project'], message: 'editor cannot depend on project (see docs/architecture.md)' },
            { group: ['../export/*', '../export'], message: 'editor cannot depend on export (see docs/architecture.md)' },
            { group: ['../state', '../main'], message: 'editor cannot depend on state/main, the composition root (see docs/architecture.md)' },
            { group: ['three', 'three/*'], message: 'editor cannot depend on the DOM or Three.js (see docs/architecture.md)' },
          ],
        },
      ],
      // The real guard for DOM independence is tsconfig.editor.json, which drops DOM from `lib`
      // and runs under `npm run typecheck`. Because it removes the whole DOM lib from type
      // resolution rather than listing identifiers, it also covers DOM *types* such as
      // HTMLElement (a review of #18 pointed out the limits of a fixed five-identifier
      // no-restricted-globals list). The rule below only gives immediate in-editor feedback for
      // the main global *values*; it cannot catch identifiers used as types, so it is a helper.
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'editor cannot depend on the DOM (document) (see docs/architecture.md)' },
        { name: 'window', message: 'editor cannot depend on the DOM (window) (see docs/architecture.md)' },
        { name: 'navigator', message: 'editor cannot depend on the DOM (navigator) (see docs/architecture.md)' },
        { name: 'localStorage', message: 'editor cannot depend on the DOM (localStorage) (see docs/architecture.md)' },
        { name: 'sessionStorage', message: 'editor cannot depend on the DOM (sessionStorage) (see docs/architecture.md)' },
      ],
    },
  },
  {
    // The five sibling layers (input / ui / render / project / export) may depend on each other,
    // on core, on editor, and on state (values and functions) — but never on main.ts, the
    // composition root.
    // Strict detection that does not depend on nesting depth, and the ban on type-only imports
    // from state.ts, are handled by scripts/architecture-lint.mjs (run in CI through
    // tests/architecture.test.ts). This rule only covers the flat same-layer case, to give
    // immediate in-editor feedback.
    files: ['src/{input,ui,render,project,export}/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['../main'], message: 'nothing may depend on main, the composition root (see docs/architecture.md)' }],
        },
      ],
    },
  },
  {
    // A type-contract test file that deliberately breaks type resolution with @ts-expect-error.
    // Typed lint (no-unsafe-*) sometimes reads a broken type as the equivalent of `any` (seen in
    // CI; locally it is non-deterministic because it depends on the environment — noted in a
    // review of #19). Disable no-unsafe-* for this one file to keep the blast radius small; type
    // safety for ordinary code is still checked everywhere else.
    files: ['tests/scenetree-readonly-contract.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);

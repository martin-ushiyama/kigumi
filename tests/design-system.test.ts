import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const srcRoot = join(root, 'src');
const designSystem = readFileSync(join(srcRoot, 'design-system.css'), 'utf8');

function tokenValue(name: string): string {
  const match = designSystem.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  if (!match?.[1]) throw new Error(`Missing design token: ${name}`);
  const value = match[1].trim();
  const alias = value.match(/^var\((--bs-[a-z0-9-]+)\)$/);
  return alias?.[1] ? tokenValue(alias[1]) : value;
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .match(/[a-f0-9]{2}/gi)
    ?.map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  if (!channels || channels.length !== 3) throw new Error(`Expected a six-digit hex color, got: ${hex}`);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

function walkCss(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkCss(path));
    else if (entry.isFile() && extname(entry.name) === '.css') files.push(path);
  }
  return files;
}

describe('design system contract', () => {
  it('defines every --bs-* token referenced by any source CSS file', () => {
    const css = walkCss(srcRoot).map((file) => readFileSync(file, 'utf8')).join('\n');
    const definitions = new Set([...css.matchAll(/(--bs-[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
    const references = new Set([...css.matchAll(/var\((--bs-[a-z0-9-]+)\)/g)].map((match) => match[1]));
    const missing = [...references].filter((name) => !definitions.has(name));

    expect(missing).toEqual([]);
  });

  it('keeps semantic tokens as aliases instead of raw values', () => {
    const semanticNames = '(?:surface|content|border|action|state|panel)-[a-z0-9-]+|focus-ring';
    const declarations = [...designSystem.matchAll(new RegExp(`--bs-(?:${semanticNames})\\s*:\\s*([^;]+);`, 'g'))];

    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) {
      expect(declaration[1]?.trim()).toMatch(/^var\(--bs-[a-z0-9-]+\)$/);
    }
  });

  it('does not leave unused color primitives behind', () => {
    const definitions = [...designSystem.matchAll(/(--bs-color-[a-z0-9-]+)\s*:/g)].map((match) => match[1]);
    const references = new Set(
      [...designSystem.matchAll(/var\((--bs-color-[a-z0-9-]+)\)/g)].map((match) => match[1]),
    );

    expect(definitions.filter((name) => !references.has(name))).toEqual([]);
  });

  it('keeps accent text and primary buttons at WCAG AA contrast', () => {
    const accent = tokenValue('--bs-action-accent');
    const onAccent = tokenValue('--bs-content-on-accent');
    const pressedSurface = tokenValue('--bs-surface-control-pressed');

    expect(contrastRatio(accent, onAccent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(accent, pressedSurface)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps compatibility aliases on semantic tokens', () => {
    expect(designSystem).toContain('--panel-bg: var(--bs-surface-panel)');
    expect(designSystem).toContain('--panel-border: var(--bs-border-default)');
    expect(designSystem).toContain('--text: var(--bs-content-primary)');
    expect(designSystem).toContain('--text-dim: var(--bs-content-secondary)');
    expect(designSystem).toContain('--accent: var(--bs-action-accent)');
  });

  it('separates pressed button state from the dedicated tabs contract', () => {
    const primitives = readFileSync(join(srcRoot, 'ui', 'primitives.ts'), 'utf8');
    const buttonSource = primitives.slice(
      primitives.indexOf('export function setButtonPressed'),
      primitives.indexOf('export interface InputOptions'),
    );
    const tabsSource = primitives.slice(primitives.indexOf('export function createTabList'));
    expect(buttonSource).toContain("'aria-pressed'");
    expect(buttonSource).not.toContain("'aria-selected'");
    expect(tabsSource).toContain("'aria-selected'");
    expect(tabsSource).toContain("'tablist'");
    expect(tabsSource).toContain("'aria-controls'");
  });

  it('exposes primary actions through the button primitive', () => {
    const primitives = readFileSync(join(srcRoot, 'ui', 'primitives.ts'), 'utf8');
    const toolbar = readFileSync(join(srcRoot, 'ui', 'toolbar.ts'), 'utf8');

    expect(primitives).toContain("'primary'");
    expect(toolbar).toContain("variant: 'primary'");
    expect(toolbar).not.toContain('export-button');
  });
});

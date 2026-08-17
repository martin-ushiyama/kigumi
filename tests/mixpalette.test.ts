import { describe, expect, it } from 'vitest';
import { averageColor, buildIndexOf, sampleRecipe, type MixRecipe } from '../src/core/mixpalette';
import { CATALOG } from '../src/data/blocks';

// Simple reproducible LCG
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const indexOf = buildIndexOf(CATALOG);

describe('mix palette sampling', () => {
  it('distributes according to the weight ratio (4:3:2:1, tolerance ±3%)', () => {
    const recipe: MixRecipe = {
      id: 'r1',
      name: 'Stone Path',
      entries: [
        { blockId: 'minecraft:stone_bricks', weight: 4 },
        { blockId: 'minecraft:cobblestone', weight: 3 },
        { blockId: 'minecraft:andesite', weight: 2 },
        { blockId: 'minecraft:mossy_cobblestone', weight: 1 },
      ],
    };
    const rng = lcg(42);
    const counts = new Map<number, number>();
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const v = sampleRecipe(recipe, indexOf, rng);
      expect(v).not.toBeNull();
      counts.set(v!, (counts.get(v!) ?? 0) + 1);
    }
    const expectRatio = (blockId: string, ratio: number) => {
      const actual = (counts.get(indexOf(blockId)!) ?? 0) / N;
      expect(Math.abs(actual - ratio)).toBeLessThan(0.03);
    };
    expectRatio('minecraft:stone_bricks', 0.4);
    expectRatio('minecraft:cobblestone', 0.3);
    expectRatio('minecraft:andesite', 0.2);
    expectRatio('minecraft:mossy_cobblestone', 0.1);
  });

  it('excludes weight 0 and unknown blockId from sampling', () => {
    const recipe: MixRecipe = {
      id: 'r2',
      name: 'x',
      entries: [
        { blockId: 'minecraft:stone', weight: 0 },
        { blockId: 'minecraft:does_not_exist', weight: 5 },
        { blockId: 'minecraft:cobblestone', weight: 1 },
      ],
    };
    const rng = lcg(7);
    for (let i = 0; i < 100; i++) {
      expect(sampleRecipe(recipe, indexOf, rng)).toBe(indexOf('minecraft:cobblestone'));
    }
  });

  it('no valid entries returns null', () => {
    const recipe: MixRecipe = { id: 'r3', name: 'empty', entries: [] };
    expect(sampleRecipe(recipe, indexOf)).toBeNull();
  });
});

describe('average color', () => {
  it('two equally-weighted colors produce the midpoint color', () => {
    const recipe: MixRecipe = {
      id: 'r4',
      name: 'c',
      entries: [
        { blockId: 'minecraft:stone', weight: 1 },
        { blockId: 'minecraft:cobblestone', weight: 1 },
      ],
    };
    // **Don't hardcode catalog colors as literals** — the representative color is generated
    // from the texture's average color, so it shifts when the texture is updated. What we
    // want to pin down here is that it lands "at the midpoint of the two colors"
    const channel = (id: string, at: number) =>
      parseInt(CATALOG.find((b) => b.id === id)!.color.slice(at, at + 2), 16);
    const mid = (at: number) =>
      Math.round((channel('minecraft:stone', at) + channel('minecraft:cobblestone', at)) / 2)
        .toString(16)
        .padStart(2, '0');
    expect(averageColor(recipe, CATALOG)).toBe(`#${mid(1)}${mid(3)}${mid(5)}`);
  });

  it('no entries returns white', () => {
    expect(averageColor({ id: 'r', name: 'n', entries: [] }, CATALOG)).toBe('#ffffff');
  });
});

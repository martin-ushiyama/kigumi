import { describe, expect, it } from 'vitest';
import { CATALOG } from '../src/data/blocks';

describe('Block catalog (scripts/gen-blocks.mjs output)', () => {
  it('every entry has shape / materialGroup', () => {
    for (const b of CATALOG) {
      expect(b.shape, b.id).toBeDefined();
      expect(['full', 'slab', 'stairs']).toContain(b.shape);
      expect(b.materialGroup, b.id).toBeTruthy();
    }
  });

  it('ids have no duplicates', () => {
    const ids = CATALOG.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('slab / stairs materialGroup matches an existing full block id in the same category', () => {
    const fullByCategory = new Map<string, Set<string>>();
    for (const b of CATALOG) {
      if (b.shape !== 'full') continue;
      const bare = b.id.replace('minecraft:', '');
      if (!fullByCategory.has(b.category)) fullByCategory.set(b.category, new Set());
      fullByCategory.get(b.category)!.add(bare);
    }
    for (const b of CATALOG) {
      if (b.shape === 'full') continue;
      const fulls = fullByCategory.get(b.category);
      expect(fulls?.has(b.materialGroup), `${b.id} materialGroup=${b.materialGroup}`).toBe(true);
    }
  });

  it('237 total (full 136 / slab 52 / stairs 49)', () => {
    const count = (s: string) => CATALOG.filter((b) => b.shape === s).length;
    expect(CATALOG.length).toBe(237);
    expect(count('full')).toBe(136);
    expect(count('slab')).toBe(52);
    expect(count('stairs')).toBe(49);
  });
});

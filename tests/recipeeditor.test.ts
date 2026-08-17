import { describe, expect, it } from 'vitest';
import { addBlockToRecipe } from '../src/ui/recipeeditor';

describe('addBlockToRecipe', () => {
  it('adds a new block with weight 1 without mutating the recipe', () => {
    const recipe = { id: 'r', name: 'mix', entries: [{ blockId: 'a', weight: 2 }] };
    expect(addBlockToRecipe(recipe, 'b')).toEqual([
      { blockId: 'a', weight: 2 },
      { blockId: 'b', weight: 1 },
    ]);
    expect(recipe.entries).toEqual([{ blockId: 'a', weight: 2 }]);
  });

  it('increments an existing block through the same path used by both editors', () => {
    const recipe = { id: 'r', name: 'mix', entries: [{ blockId: 'a', weight: 2 }] };
    expect(addBlockToRecipe(recipe, 'a')).toEqual([{ blockId: 'a', weight: 3 }]);
  });
});

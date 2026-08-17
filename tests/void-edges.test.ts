import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Cell } from '../src/core/cell';
import { VoidEdges, type VoidCellSource } from '../src/render/voidedges';

/** Minimal fake that only returns voidCells(). Contents can be swapped out */
function fakeSource(cells: Cell[]): VoidCellSource & { cells: Cell[] } {
  const source = {
    cells,
    *voidCells(): IterableIterator<Cell> {
      yield* source.cells;
    },
  };
  return source;
}

function lineSegmentsIn(scene: THREE.Scene): THREE.LineSegments {
  const found = scene.children.find((c): c is THREE.LineSegments => c instanceof THREE.LineSegments);
  if (!found) throw new Error('No LineSegments in scene');
  return found;
}

/** 12 cube edges = 24 vertices */
const VERTS_PER_CELL = 24;

describe('VoidEdges — outline of void cells', () => {
  it('draws nothing when there are no void cells', () => {
    const scene = new THREE.Scene();
    const edges = new VoidEdges(scene, fakeSource([]));
    edges.update();

    expect(lineSegmentsIn(scene).geometry.drawRange.count).toBe(0);
  });

  it('draws one cube worth of vertices per void cell', () => {
    const scene = new THREE.Scene();
    const edges = new VoidEdges(scene, fakeSource([[0, 0, 0]]));
    edges.update();

    expect(lineSegmentsIn(scene).geometry.drawRange.count).toBe(VERTS_PER_CELL);
  });

  it('the outline is positioned at the cell (no half-cell offset)', () => {
    const scene = new THREE.Scene();
    const edges = new VoidEdges(scene, fakeSource([[3, 4, 5]]));
    edges.update();

    const pos = lineSegmentsIn(scene).geometry.getAttribute('position');
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < VERTS_PER_CELL; i++) {
      minX = Math.min(minX, pos.getX(i)); maxX = Math.max(maxX, pos.getX(i));
      minY = Math.min(minY, pos.getY(i)); maxY = Math.max(maxY, pos.getY(i));
      minZ = Math.min(minZ, pos.getZ(i)); maxZ = Math.max(maxZ, pos.getZ(i));
    }
    // the cube occupying cell (3,4,5) = [3..4] × [4..5] × [5..6]
    expect([minX, maxX]).toEqual([3, 4]);
    expect([minY, maxY]).toEqual([4, 5]);
    expect([minZ, maxZ]).toEqual([5, 6]);
  });

  it('update() only rebuilds when dirty (does not rescan everything each frame)', () => {
    const scene = new THREE.Scene();
    const source = fakeSource([[0, 0, 0]]);
    const edges = new VoidEdges(scene, source);
    edges.update();

    // swapping the source while not dirty has no effect
    source.cells = [[0, 0, 0], [1, 0, 0]];
    edges.update();
    expect(lineSegmentsIn(scene).geometry.drawRange.count).toBe(VERTS_PER_CELL);

    edges.markDirty();
    edges.update();
    expect(lineSegmentsIn(scene).geometry.drawRange.count).toBe(VERTS_PER_CELL * 2);
  });

  it('the draw range shrinks when void cells decrease (no leftover outline for a filled hole)', () => {
    const scene = new THREE.Scene();
    const source = fakeSource([[0, 0, 0], [1, 0, 0]]);
    const edges = new VoidEdges(scene, source);
    edges.update();
    expect(lineSegmentsIn(scene).geometry.drawRange.count).toBe(VERTS_PER_CELL * 2);

    source.cells = [];
    edges.markDirty();
    edges.update();
    expect(lineSegmentsIn(scene).geometry.drawRange.count).toBe(0);
  });

  it('draws all cells even beyond initial capacity (grows the buffer)', () => {
    const scene = new THREE.Scene();
    const many: Cell[] = Array.from({ length: 200 }, (_, i) => [i, 0, 0] as Cell);
    const edges = new VoidEdges(scene, fakeSource(many));
    edges.update();

    const line = lineSegmentsIn(scene);
    expect(line.geometry.drawRange.count).toBe(VERTS_PER_CELL * 200);
    // the last cell is actually written (the full rewrite after growing works)
    const pos = line.geometry.getAttribute('position');
    let maxX = -Infinity;
    for (let i = 0; i < pos.count; i++) maxX = Math.max(maxX, pos.getX(i));
    expect(maxX).toBe(200);
  });

  it('is removed from the scene on dispose', () => {
    const scene = new THREE.Scene();
    const edges = new VoidEdges(scene, fakeSource([[0, 0, 0]]));
    expect(scene.children).toHaveLength(1);

    edges.dispose();
    expect(scene.children).toHaveLength(0);
  });
});

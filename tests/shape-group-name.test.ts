import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hit } from '../src/core/types';
import { CATALOG } from '../src/data/blocks';
import { initEditorControls, type EditorControlsHandle } from '../src/input/controls';
import { defaultName, setActiveBlock, setActiveRecipe, setLang, setPaintVoid, setShape, setTool, state } from '../src/state';
import { VOID_CATALOG_INDEX, VOID_CELL, isVoidCell } from '../src/core/orientation';
import { DocumentFixture } from './helpers/document-fixture';

/**
 * Groups created by the shape tool get a default name that **includes the material name**.
 *
 * If the layer tree were full of plain "Cuboid" entries they'd be indistinguishable, so the
 * name takes the form `Cuboid: Cobblestone`.
 *
 * The core rule: it's **fixed once from the material at creation time and never tracked
 * afterward**. The name is a record of that moment, not a derived value — following material
 * changes would overwrite a name the user manually re-typed (same treatment as the
 * defaultName contract from #70).
 */

function hitAt(cell: [number, number, number], normal: [number, number, number]): Hit {
  return { kind: 'voxel', cell, normal } as Hit;
}

function pointer(): PointerEvent {
  return { button: 0, shiftKey: false, altKey: false, clientX: 0, clientY: 0 } as PointerEvent;
}

function installWindowStub(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.CustomEvent ??= class {
    constructor(
      public type: string,
      public init?: { detail?: unknown },
    ) {}
  };
  g.window ??= { dispatchEvent: () => true };
}

describe('default names for shape groups include the material', () => {
  let doc: DocumentFixture;
  let controls: EditorControlsHandle;
  let nextHit: Hit | null;
  let planeCell: [number, number, number] | null;
  let extrudeTo: number | null;
  /** The display name of the material currently being painted, swapped by the test */
  let paintLabel: string;

  beforeEach(() => {
    installWindowStub();
    setLang('ja');
    doc = new DocumentFixture(() => 'full');
    nextHit = null;
    planeCell = null;
    extrudeTo = null;
    paintLabel = 'Cobblestone';
    setTool('fill');
    setShape('box');
    controls = initEditorControls({
      scene: new THREE.Scene(),
      world: doc.world,
      doc,
      getCatalog: () => CATALOG,
      getPaintBlock: () => 0,
      getPaintColor: () => '#ffffff',
      getPaintLabel: () => paintLabel,
      onHover: () => {},
      pickFromEvent: () => nextHit,
      resolvePlaceCell: (hit) => [hit.cell[0], hit.cell[1], hit.cell[2]],
      getPlacementGroup: () => null,
      resolveRangeFaceCell: () => planeCell,
      resolveRangeExtrudeCell: () => (extrudeTo === null ? null : [0, extrudeTo, 0]),
      isSpacePanActive: () => false,
    });
  });

  function hoverMove(): void {
    const fn = controls.route.onHoverMove;
    if (!fn) throw new Error('onHoverMove route is not registered');
    fn(pointer());
  }

  /** Click a face → expand the plane → release → extrude → commit */
  function fillBox(): void {
    nextHit = hitAt([0, 0, 0], [0, 1, 0]);
    const claim = controls.route.onPointerDown(pointer());
    if (claim === 'handled' || claim === null) throw new Error('claim was not returned');
    planeCell = [1, 0, 1];
    hoverMove();
    claim.onUp(pointer());
    extrudeTo = 1;
    nextHit = null;
    hoverMove();
    controls.route.onPointerDown(pointer());
  }

  const groupNames = (): string[] =>
    doc.tree.childrenOf(null).map((id) => doc.tree.getNode(id)?.name ?? '');

  it('the shape name gets the material name attached', () => {
    fillBox();
    expect(groupNames()).toEqual(['直方体：Cobblestone']);
  });

  it('creating with a different material attaches that material name', () => {
    paintLabel = 'Stone Bricks';
    fillBox();
    expect(groupNames()).toEqual(['直方体：Stone Bricks']);
  });

  it('changing the material after creation does not update the name (the name is a record of that moment)', () => {
    fillBox();
    paintLabel = 'Obsidian';
    expect(groupNames()).toEqual(['直方体：Cobblestone']);
  });

  it('changing the shape uses that shape name', () => {
    setShape('sphere');
    fillBox();
    expect(groupNames()).toEqual(['球：Cobblestone']);
  });

  it('uses a half-width colon in English (fixed by the language at creation time)', () => {
    setLang('en');
    paintLabel = 'Cobblestone';
    fillBox();
    expect(groupNames()).toEqual(['Cuboid: Cobblestone']);
  });

  it("switching the display language after creation doesn't corrupt the already-attached name (#70 contract)", () => {
    fillBox();
    setLang('en');
    expect(groupNames()).toEqual(['直方体：Cobblestone']);
  });
});

describe('filling in void with the shape tool (#113 stage 3)', () => {
  let doc: DocumentFixture;
  let controls: EditorControlsHandle;
  let nextHit: Hit | null;
  let planeCell: [number, number, number] | null;
  let extrudeTo: number | null;

  beforeEach(() => {
    installWindowStub();
    setLang('ja');
    setPaintVoid(false);
    doc = new DocumentFixture(() => 'full');
    nextHit = null;
    planeCell = null;
    extrudeTo = null;
    setTool('fill');
    setShape('box');
    controls = initEditorControls({
      scene: new THREE.Scene(),
      world: doc.world,
      doc,
      getCatalog: () => CATALOG,
      // reproduces the same rule as main.ts (void takes priority)
      getPaintBlock: () => (state.paintVoid ? VOID_CATALOG_INDEX : 0),
      getPaintColor: () => '#ffffff',
      getPaintLabel: () => (state.paintVoid ? defaultName('void') : 'Cobblestone'),
      onHover: () => {},
      pickFromEvent: () => nextHit,
      resolvePlaceCell: (hit) => [hit.cell[0], hit.cell[1], hit.cell[2]],
      getPlacementGroup: () => null,
      resolveRangeFaceCell: () => planeCell,
      resolveRangeExtrudeCell: () => (extrudeTo === null ? null : [0, extrudeTo, 0]),
      isSpacePanActive: () => false,
    });
  });

  function hoverMove(): void {
    const fn = controls.route.onHoverMove;
    if (!fn) throw new Error('onHoverMove route is not registered');
    fn(pointer());
  }

  function fillBox(to: [number, number, number], extrude: number): void {
    nextHit = hitAt([0, 0, 0], [0, 1, 0]);
    const claim = controls.route.onPointerDown(pointer());
    if (claim === 'handled' || claim === null) throw new Error('claim was not returned');
    planeCell = to;
    hoverMove();
    claim.onUp(pointer());
    extrudeTo = extrude;
    nextHit = null;
    hoverMove();
    controls.route.onPointerDown(pointer());
  }

  const rawsOf = (ownerId: string): number[] => [...doc.scene.cells.entriesOf(ownerId)].map(([, raw]) => raw);
  const groupIds = (): string[] => [...doc.tree.childrenOf(null)];

  it('placing while in void mode creates a void cell with no orientation code attached', () => {
    setPaintVoid(true);
    fillBox([0, 0, 0], 0);
    const raws = rawsOf(groupIds()[0]!);
    expect(raws).toHaveLength(1);
    expect(isVoidCell(raws[0]!)).toBe(true);
    expect(raws[0]).toBe(VOID_CELL); // no duplicate raw values with the same meaning get created
  });

  it('void is always grouped by the shape tool (because the affected range is determined by the group)', () => {
    setPaintVoid(true);
    fillBox([0, 0, 0], 0);
    expect(groupIds()).toHaveLength(1);
    expect(doc.tree.getNode(groupIds()[0]!)?.name).toBe('直方体：空白');
  });

  it('turning off void mode reverts to a normal block', () => {
    setPaintVoid(true);
    setPaintVoid(false);
    fillBox([0, 0, 0], 0);
    expect(isVoidCell(rawsOf(groupIds()[0]!)[0]!)).toBe(false);
  });

  it('selecting a block clears void mode', () => {
    setPaintVoid(true);
    setActiveBlock(0);
    expect(state.paintVoid).toBe(false);
  });

  it('moving to a tool other than the shape tool clears void mode', () => {
    setPaintVoid(true);
    setTool('place');
    expect(state.paintVoid).toBe(false);
  });

  it('entering void mode switches into the shape tool', () => {
    setTool('place');
    setPaintVoid(true);
    expect(state.tool).toBe('fill');
  });
});

describe('placement and exclusivity of void groups (#113 stage 3 review)', () => {
  let doc: DocumentFixture;
  let controls: EditorControlsHandle;
  let nextHit: Hit | null;
  let planeCell: [number, number, number] | null;
  let extrudeTo: number | null;
  let placementGroup: string | null;

  beforeEach(() => {
    installWindowStub();
    setLang('ja');
    setPaintVoid(false);
    setActiveRecipe(null);
    doc = new DocumentFixture(() => 'full');
    nextHit = null;
    planeCell = null;
    extrudeTo = null;
    placementGroup = null;
    setTool('fill');
    setShape('box');
    controls = initEditorControls({
      scene: new THREE.Scene(),
      world: doc.world,
      doc,
      getCatalog: () => CATALOG,
      getPaintBlock: () => (state.paintVoid ? VOID_CATALOG_INDEX : 0),
      getPaintColor: () => '#ffffff',
      getPaintLabel: () => (state.paintVoid ? defaultName('void') : 'Cobblestone'),
      onHover: () => {},
      pickFromEvent: () => nextHit,
      resolvePlaceCell: (hit) => [hit.cell[0], hit.cell[1], hit.cell[2]],
      getPlacementGroup: () => placementGroup,
      resolveRangeFaceCell: () => planeCell,
      resolveRangeExtrudeCell: () => (extrudeTo === null ? null : [0, extrudeTo, 0]),
      isSpacePanActive: () => false,
    });
  });

  function hoverMove(): void {
    const fn = controls.route.onHoverMove;
    if (!fn) throw new Error('onHoverMove route is not registered');
    fn(pointer());
  }

  /** Touches the anchor cell and fills a single cell */
  function fillAt(anchor: [number, number, number]): void {
    nextHit = hitAt(anchor, [0, 1, 0]);
    const claim = controls.route.onPointerDown(pointer());
    if (claim === 'handled' || claim === null) throw new Error('claim was not returned');
    planeCell = anchor;
    hoverMove();
    claim.onUp(pointer());
    extrudeTo = anchor[1];
    nextHit = null;
    hoverMove();
    controls.route.onPointerDown(pointer());
  }

  /** Creates one wall group and returns its owner id */
  function makeWall(): string {
    fillAt([0, 0, 0]);
    return [...doc.tree.childrenOf(null)][0]!;
  }

  it('a void group is created inside the group being dug into (not at root level)', () => {
    const wall = makeWall();
    setPaintVoid(true);
    fillAt([0, 0, 0]); // touches a wall cell

    // only the wall sits directly under root. the void is nested inside the wall
    expect([...doc.tree.childrenOf(null)]).toEqual([wall]);
    const children = [...doc.tree.childrenOf(wall)];
    expect(children).toHaveLength(1);
    expect(doc.tree.getNode(children[0]!)?.name).toBe('直方体：空白');
  });

  it('void is appended at the end of its siblings (it must come after to hide what is behind)', () => {
    const wall = makeWall();
    setPaintVoid(true);
    fillAt([0, 0, 0]);
    const hole = [...doc.tree.childrenOf(wall)].at(-1);
    expect(doc.tree.getNode(hole!)?.name).toBe('直方体：空白');
  });

  it('an explicitly selected group takes priority', () => {
    const wall = makeWall();
    setPaintVoid(true);
    placementGroup = wall;
    fillAt([5, 0, 0]); // even touching empty space, it goes into the selected group
    expect([...doc.tree.childrenOf(wall)]).toHaveLength(1);
  });

  /**
   * Shape fill is a two-stage gesture — "drag the plane and release → click a second time
   * to set the height" — and **there's no active claim in between**, so a different group can
   * be selected in the layer panel. The parent reflects the intent at the start, so it isn't
   * re-read at commit time (#119 review, round 2).
   */
  it('even if the layer selection changes after the plane is committed, the void still goes into the group from when it started', () => {
    const wall = makeWall();
    fillAt([5, 0, 0]); // creates one unrelated group
    const other = [...doc.tree.childrenOf(null)].at(-1)!;
    expect(other).not.toBe(wall);

    setPaintVoid(true);

    // plane stage: touch and release on the wall cell (the parent is decided here)
    nextHit = hitAt([0, 0, 0], [0, 1, 0]);
    const claim = controls.route.onPointerDown(pointer());
    if (claim === 'handled' || claim === null) throw new Error('claim was not returned');
    planeCell = [0, 0, 0];
    hoverMove();
    claim.onUp(pointer());

    // mid-height stage, the layer selection moves to a different group
    placementGroup = other;

    extrudeTo = 0;
    nextHit = null;
    hoverMove();
    controls.route.onPointerDown(pointer()); // commit

    expect([...doc.tree.childrenOf(wall)], 'goes into the wall touched at the start').toHaveLength(1);
    expect([...doc.tree.childrenOf(other)], 'does not go into the group selected afterward').toHaveLength(0);
  });

  it('a normal block is still created directly under root as before', () => {
    makeWall();
    fillAt([5, 0, 0]);
    expect([...doc.tree.childrenOf(null)]).toHaveLength(2);
  });

  it("selecting a mix recipe clears void mode (what's selected must match what happens)", () => {
    setPaintVoid(true);
    setActiveRecipe('recipe-1');
    expect(state.paintVoid).toBe(false);
  });

  it('deselecting the mix recipe does not bring void mode back', () => {
    setPaintVoid(true);
    setActiveRecipe('recipe-1');
    setActiveRecipe(null);
    expect(state.paintVoid).toBe(false);
  });
});

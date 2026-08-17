import * as THREE from 'three';
import type { Document, EditSession, WorldEditIntent } from '../core/document';
import { isValidCell } from '../core/limits';
import { axisToCode, decodeOrientation, defaultCode, encodeOrientation, packPaintCell, unpackCell } from '../core/orientation';
import { isPillarBlock, type BlockDef, type Tool } from '../core/types';
import type { WorldIndexReader } from '../core/worldindex';
import { buildVoxelHull } from '../core/voxelhull';
import { createShapeGeometry, slabHalfOffset, weirdoDirectionToYRotation } from '../render/geometry';
import type { GestureClaim, PointerRouteHandler } from './router';
import { defaultName, isShapeHollow, onStateChange, setActiveBlock, setPendingOrientation, setTool, state, t } from '../state';
import type { ShapeKind } from '../core/shapes';
import { resolveRangeCells } from '../editor/rangefill';
import type { DefaultNameKey } from '../core/i18n';
import { rangeSizeOf, type RangeSize } from '../core/rangesize';
import { bboxOfCorners } from '../core/shapes';
import { faceOf, type FaceRef } from '../core/axis';
import type { Hit } from '../core/types';

/** Default group name per shape (fixed and saved at creation time in the current language, per the defaultName contract in #70) */
const SHAPE_NAME_KEY: Record<ShapeKind, DefaultNameKey> = {
  box: 'cuboid',
  sphere: 'sphere',
  cylinder: 'cylinder',
  dome: 'dome',
  slope: 'slope',
};

/**
 * Determine a single "laid direction" axis from the three side lengths of a range
 * (Shift+click / Fill tool). Used to auto-orient pillar_axis blocks (e.g. logs) along
 * that direction. If Y is the largest (ties included), stay with y (ambiguous cubes and
 * tall ranges default to vertical as before); otherwise use whichever of X/Z is longer.
 */
function dominantAxis(spanX: number, spanY: number, spanZ: number): 'x' | 'y' | 'z' {
  const max = Math.max(spanX, spanY, spanZ);
  if (spanY === max) return 'y';
  return spanX >= spanZ ? 'x' : 'z';
}

/**
 * Clamp the extrusion endpoint to **outside the face only** (#101).
 *
 * The touched face is the boundary, so the extrusion direction is fixed to the single
 * normal direction. Pulling back toward the origin stops at a thickness of 1 (the face
 * itself).
 */
function extrudeOutward(anchorAt: number, projectedAt: number, sign: 1 | -1): number {
  return sign > 0 ? Math.max(anchorAt, projectedAt) : Math.min(anchorAt, projectedAt);
}

export interface EditorControlsOpts {
  scene: THREE.Scene;
  /** Derived read-model (#37 B1b). `WorldReader`-compatible, so `has`/`get` usage is unchanged */
  world: WorldIndexReader;
  doc: Document;
  getCatalog: () => BlockDef[];
  /** Returns the block index to place (drawn per-cell in mix mode). null = cannot place */
  getPaintBlock: () => number | null;
  /** Color for the ghost/fill preview (the blend's average color in mix mode) */
  getPaintColor: () => string;
  /**
   * Display name of the material currently being painted (the mix recipe name in mix mode).
   * Appended to the shape group's default name.
   *
   * Injected the same way as `getPaintBlock` / `getPaintColor` because knowing whether a
   * recipe exists belongs to the composition entry point (main.ts). Looking up the recipe
   * here would make controls depend on the mix palette.
   */
  getPaintLabel: () => string;
  onHover: (cell: [number, number, number] | null) => void;
  /**
   * Dimensions during a range operation (#83). Values only flow while dragging/extruding,
   * and become null on commit / cancel.
   *
   * "How many blocks" isn't visible from the preview solid alone, so it's surfaced to be
   * shown in the status bar. Passed as the dimensions themselves rather than a string
   * **so controls stays unaware of where it's displayed**.
   */
  onRangeSize?: (range: RangeSize | null) => void;
  /** Executes the raycast (main.ts builds this, injecting the camera) */
  pickFromEvent: (e: PointerEvent) => Hit | null;
  /** Resolves the placement-face cell (defaults to hit.cell + hit.normal if omitted). selecttool.ts etc. may inject their own */
  resolvePlaceCell?: (hit: Hit) => [number, number, number];
  /**
   * Cells of the component about to be placed (#69 Step 3b). `null` = not in placement mode.
   *
   * **Receives only the cell list, not a `ComponentTemplate`.** If controls knew the
   * component's type, the input layer would depend on the component layer just for the
   * placement operation.
   */
  getPendingComponentCells?: () => readonly [number, number, number][] | null;
  /** Clicked while in placement mode (passes the placement position; the caller actually does the placing) */
  onPlaceComponent?: (origin: [number, number, number]) => void;
  /** Destination group for new placements (the id if a single group is selected in the layer panel, otherwise null=root) */
  getPlacementGroup: () => string | null;
  /**
   * During the shape-fill plane phase, resolves the target cell by projecting onto **the
   * plane containing the touched face** (#101). The plane holds even if dragged past the
   * face's edge.
   *
   * **Required.** If injection is missing, the plane phase silently freezes (appears as
   * "not moving"), so this is enforced by the type instead of being swallowed by an
   * existence check (#120: replaces the old canProjectRange capability branch).
   */
  resolveRangeFaceCell: (
    e: PointerEvent,
    anchor: [number, number, number],
    face: FaceRef,
  ) => [number, number, number] | null;
  /**
   * During the shape-fill extrude phase, determines how many cells to extend **along the
   * face's axis** (#78 / #101). Resolves even over empty air. Required for the same reason
   * as `resolveRangeFaceCell`.
   */
  resolveRangeExtrudeCell: (
    e: PointerEvent,
    anchor: [number, number, number],
    face: FaceRef,
  ) => [number, number, number] | null;
  /** While true, yields tool operations to Space+left-drag panning (handled by OrbitControls) */
  isSpacePanActive?: () => boolean;
}

/** Return value of initEditorControls. Used to query an in-progress gesture, cancel it explicitly, and register the route */
export interface EditorControlsHandle {
  /** Whether an edit gesture is in progress with the button held (a continuous stroke or a Fill tool drag) */
  isDragging: () => boolean;
  /** Discards the in-progress stroke/range operation (called from an Escape broadcast / mode switch via InputRouter (#12)) */
  cancelActive: () => void;
  /** Route handler registered with InputRouter's (#12 PR2) pointerRoutes */
  route: PointerRouteHandler;
}

/**
 * Left-click editing operations. Applied immediately via stage() while dragging;
 * on pointerup, EditSession.commit() finalizes one stroke as one undo unit.
 */
export function initEditorControls(opts: EditorControlsOpts): EditorControlsHandle {
  const { scene, world, doc, getCatalog, getPaintBlock, getPaintColor, getPaintLabel, onHover, onRangeSize, pickFromEvent, resolvePlaceCell, getPlacementGroup, resolveRangeFaceCell, resolveRangeExtrudeCell, isSpacePanActive, getPendingComponentCells, onPlaceComponent } = opts;

  // Placement preview (semi-transparent, follows the selected block's shape/orientation)
  const ghost = new THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, depthWrite: false }),
  );
  ghost.visible = false;
  scene.add(ghost);
  let ghostGeometryKey = '';

  /**
   * Component placement preview (#69 Step 3b).
   *
   * Rather than a single ghost, **shows every cell that would be filled** — since a
   * component is a shape, committing without seeing what it occupies means noticing only
   * after placing and having to undo.
   */
  /**
   * Component placement preview (#69 Step 3b).
   *
   * **Don't line up boxes cell by cell.** Adjacent cells share a face on the same plane,
   * so drawing them semi-transparently turns that into a depth-fighting mess, producing
   * visible seams even though no lines were drawn (reported during testing). Instead, build
   * a single mesh from just the outward-facing surfaces (`buildVoxelHull`).
   */
  const componentGhostMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, depthWrite: false });
  const componentGhost = new THREE.Mesh(new THREE.BufferGeometry(), componentGhostMaterial);
  componentGhost.visible = false;
  scene.add(componentGhost);
  /** The cells the currently-built shape was derived from (skip rebuilding for the same shape) */
  let componentGhostKey = '';

  /** Shows the preview at the placement position. Returns true if placeable */
  function updateComponentGhost(cell: [number, number, number] | null): boolean {
    const cells = getPendingComponentCells?.() ?? null;
    if (!cells || !cells.length || !cell) {
      componentGhost.visible = false;
      return false;
    }
    const key = cells.map(([x, y, z]) => `${x},${y},${z}`).join('|');
    if (key !== componentGhostKey) {
      const hull = buildVoxelHull(cells);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(hull.positions, 3));
      geometry.setIndex(hull.indices);
      geometry.computeVertexNormals();
      componentGhost.geometry.dispose();
      componentGhost.geometry = geometry;
      componentGhostKey = key;
    }
    componentGhost.position.set(cell[0], cell[1], cell[2]);
    componentGhostMaterial.color.set(getPaintColor());
    componentGhost.visible = true;
    ghost.visible = false;
    return true;
  }

  /** Updates the ghost's geometry/rotation according to the selected block's shape (code is specified by the caller) */
  function updateGhostShape(cell: [number, number, number], code: number): void {
    const def = getCatalog()[state.activeBlock];
    const shape = def?.shape ?? 'full';
    const orientation = decodeOrientation(shape, code);
    const upsideDown = orientation.shape === 'stairs' && orientation.upsideDown;
    const key = `${shape}:${upsideDown ? 1 : 0}`;
    if (key !== ghostGeometryKey) {
      ghost.geometry.dispose();
      ghost.geometry = createShapeGeometry(shape, upsideDown);
      ghostGeometryKey = key;
    }
    let yOffset = 0;
    let yRotation = 0;
    if (orientation.shape === 'slab') yOffset = slabHalfOffset(orientation.half);
    else if (orientation.shape === 'stairs') yRotation = weirdoDirectionToYRotation(orientation.weirdoDirection);
    ghost.position.set(cell[0] + 0.5, cell[1] + 0.5 + yOffset, cell[2] + 0.5);
    ghost.rotation.set(0, yRotation, 0);
  }

  // Highlight for erase/eyedropper targets (wireframe)
  const highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
    new THREE.LineBasicMaterial({ color: '#ff5555' }),
  );
  highlight.visible = false;
  scene.add(highlight);

  // Range preview for the cuboid fill
  const fillPreview = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.25, depthWrite: false }),
  );
  fillPreview.visible = false;
  scene.add(fillPreview);

  /**
   * Keeping the baseline during a stroke and restoring it on cancel is the responsibility of
   * EditSession (Document.beginSession) (#11). Since #37 B1b, we no longer keep a "world
   * coordinate Edit array" — membership derivation is no longer needed, and the diff on
   * commit is computed by EditSession from the baseline, so the only state that needs to
   * live here is "whether a session is open" and "which world cells this stroke has already
   * touched".
   */
  let strokeSession: EditSession | null = null;
  /**
   * The tool at the start of the stroke (#57, from review). **Don't check state.tool while a
   * session is open.**
   *
   * Tool-switch keys still work during a gesture, so pressing `2` mid-placement-stroke would
   * make the same EditSession start accumulating erases, and pressing `1` mid-erase would
   * stop the stroke. The shortcut table also blocks this, but **the guarantee lives here** —
   * there's more than one path that can change the tool, so blocking only the entry point
   * would leave gaps (same idea as pinning the placement owner to "one owner per session").
   */
  let strokeTool: Tool | null = null;
  const strokeTouched = new Set<string>();
  /** Origin of the range operation (shape-fill drag). The Shift+click two-point mode was removed in #103 */
  let fillAnchor: [number, number, number] | null = null;
  /**
   * Parent to place a void group into (#113). **Resolved once, at the start of the
   * operation, and held.**
   *
   * Void placement scope is determined by **the group it's placed in**, so creating it
   * directly under the root would always affect everything. Placing it inside the same
   * group as the thing being dug into keeps the effect contained.
   *
   * An explicit selection takes priority (selection is the strongest signal of intent), but
   * **only the intent at the start of the operation**. Shape-fill is a two-phase gesture
   * ("drag and release on the plane → click again to set the height"), and there's no active
   * claim in between, so a different group could be selected in the layer panel meanwhile. If
   * this were re-read on commit, the void would end up in the group selected afterward
   * instead of the wall touched at the start (#119, second review pass). Same contract as
   * pinning the stroke's placement owner to "one owner per session".
   */
  let fillVoidParent: string | null = null;
  let lastTargetCell: [number, number, number] | null = null;
  /**
   * Whether a range operation (i.e. shape-fill) is in progress. There used to also be
   * 'place' | 'erase' (Shift+click range placement/erasure), but that overlapped in role with
   * the shape tools, so it was removed in #103. Kept as a named value rather than a boolean
   * so the commit path (commitRange), which was built assuming "a type of range operation"
   * exists, retains a traceable history.
   */
  let rangeMode: 'overlay' | null = null;
  /**
   * Input phase of shape-fill (overlay) (#78).
   *
   * `plane` = taking a planar-direction range via drag / `height` = after releasing the
   * button, setting the height via mouse up/down. **Split into two phases because aiming at
   * a single point in a space with depth doesn't work as a gesture** — mapping 3 degrees of
   * freedom onto 2D pointer input would depend on camera angle and give no depth cue. By
   * making each phase map "on-screen movement" to exactly one changing axis, the target is
   * always well-defined.
   *
   * The height phase holds no claim since the button is released (`isPointerHeld` is false).
   */
  let overlayPhase: 'plane' | 'height' | null = null;
  /**
   * The **face axis** that anchors the range operation (#101). Determined by the touched
   * face's normal, and fixed for the duration of the operation.
   *
   * The plane phase projects onto the plane perpendicular to this axis, and the extrude
   * phase moves along this axis. For a top/bottom face this is the familiar XZ plane + Y
   * extrusion; for a side face, the plane and extrusion axis are based on that face instead.
   * **Fixed at the start of the operation** — allowing it to change mid-operation would break
   * the "touched face is the anchor" guarantee (agreed in #101).
   */
  let fillFace: FaceRef = { axis: 1, sign: 1 };
  /**
   * True only while the pointer is actually held down (claim active). fillAnchor also gets
   * set while "waiting for the first point" of the Shift+click two-point mode (button
   * already released), so it can't be used to determine isDragging — noted in review (#25),
   * this restores the same meaning as the old implementation's activePointerId !== null
   */
  let isPointerHeld = false;

  function toast(message: string): void {
    window.dispatchEvent(new CustomEvent('bs-toast', { detail: message }));
  }

  /** Default placement-face resolution (hit cell + face normal). Used if main.ts doesn't inject resolvePlaceCell */
  function defaultPlaceCell(hit: Hit): [number, number, number] {
    return [
      hit.cell[0] + hit.normal[0],
      hit.cell[1] + hit.normal[1],
      hit.cell[2] + hit.normal[2],
    ];
  }

  const resolvePlaceCellFn = resolvePlaceCell ?? defaultPlaceCell;

  function inRange(c: readonly [number, number, number]): boolean {
    return isValidCell(c[0], c[1], c[2]);
  }

  /**
   * Determines the orientation code for the index being placed.
   * In mix mode, a single recipe can mix shapes (e.g. stairs + slab), so the
   * activeBlock-derived pendingOrientation must not be reused for an unrelated shape.
   * Mix mode always uses the default orientation for whichever shape was drawn. Only
   * single-material mode uses pendingOrientation (the orientation set via T/G).
   */
  function paintCodeFor(paintIndex: number): number {
    if (state.paintMode !== 'mix') return state.pendingOrientation;
    const def = getCatalog()[paintIndex];
    return def ? defaultCode(def.shape) : 0;
  }

  function stagePlace(cell: [number, number, number]): void {
    if (!strokeSession || !inRange(cell) || world.has(...cell)) return;
    const k = cell.join(',');
    if (strokeTouched.has(k)) return;
    const paintIndex = getPaintBlock();
    if (paintIndex === null) return;
    // Apply the same rule per cell even during a drag stroke (mix uses default orientation, single-material uses pendingOrientation).
    // Pass raw in **world orientation** — conversion to the placement owner's local orientation is handled by Document
    const afterWorldRaw = packPaintCell(paintIndex, paintCodeFor(paintIndex));
    strokeTouched.add(k);
    strokeSession.stagePreview([{ kind: 'place', worldCell: cell, afterWorldRaw }]);
  }

  function stageErase(cell: [number, number, number]): void {
    if (!strokeSession) return;
    if (world.get(...cell) === null) return;
    const k = cell.join(',');
    // Locked groups are protected from erasure (Document.resolveEraseTarget also rejects this,
    // but we filter it out earlier to avoid needlessly filling strokeTouched)
    if (world.isWorldCellLocked(cell)) return;
    if (strokeTouched.has(k)) return;
    strokeTouched.add(k);
    strokeSession.stagePreview([{ kind: 'erase', worldCell: cell }]);
  }

  function applyToolAt(hit: Hit | null): void {
    if (!hit) return;
    const tool = strokeTool ?? state.tool; // fixed to the tool at session start while a session is open
    if (tool === 'place') {
      stagePlace(resolvePlaceCellFn(hit));
    } else if (tool === 'erase' && hit.kind === 'voxel') {
      stageErase(hit.cell);
    }
  }

  function updateFillPreview(): void {
    if (!fillAnchor || !lastTargetCell) {
      fillPreview.visible = false;
      onRangeSize?.(null);
      return;
    }
    const { min, max } = bboxOfCorners(fillAnchor, lastTargetCell);
    (fillPreview.material).color.set(getPaintColor());
    fillPreview.scale.set(max[0] - min[0] + 1.01, max[1] - min[1] + 1.01, max[2] - min[2] + 1.01);
    fillPreview.position.set(
      (min[0] + max[0]) / 2 + 0.5,
      (min[1] + max[1]) / 2 + 0.5,
      (min[2] + max[2]) / 2 + 0.5,
    );
    fillPreview.visible = true;
    // Determining whether the limit is exceeded requires the shape — a hollow shape has fewer
    // actual cells than its bbox volume, so the bbox alone can't tell you it will be rejected (review, #83)
    onRangeSize?.(
      rangeSizeOf(fillAnchor, lastTargetCell, { kind: state.shape, hollow: isShapeHollow() }),
    );
  }

  /**
   * Commits a range operation (shape-fill). **Never modifies existing cells** — places the
   * generated cells into a new group. This also places on top of existing cells, producing
   * overlap (multiple owners at the same world coordinate, #37 B1b). Placing only into empty
   * space would leave holes wherever the shape overlaps existing geometry, so it wouldn't
   * form "a single cuboid"; overwrite protection must not be reinstated here (#46).
   *
   * Shift+click range placement/erasure (place / erase) used to go through here too, but that
   * overlapped in role with the shape tools, so it was removed in #103.
   */
  function commitRange(): void {
    if (!fillAnchor || !lastTargetCell || !rangeMode) return;
    const { min: rangeMin, max: rangeMax } = bboxOfCorners(fillAnchor, lastTargetCell);
    const [minX, minY, minZ] = rangeMin;
    const [maxX, maxY, maxZ] = rangeMax;

    // buildShape enforces the limit at its entry point — two stages: rejecting up front on
    // bbox volume before scanning, and rejecting on the actual generated cell count. Checking
    // bbox volume first here would reject cases like hollow shapes, whose actual cell count
    // is much smaller (#64)
    const shaped = resolveRangeCells({
      // **Pass the two unnormalized points as-is.** Replacing them with a bbox would lose
      // which point was dragged from, making it impossible to determine the slope's
      // direction (slopeDirectionFromCorners)
      anchor: fillAnchor,
      target: lastTargetCell,
      shape: state.shape,
      hollow: isShapeHollow(),
      axis: state.shapeAxis,
      step: state.shapeStep,
    });
    if (!shaped.ok) {
      const key = shaped.reason === 'bboxTooLarge' ? 'shape.bboxTooLarge' : 'shape.tooLarge';
      toast(t(key, { count: shaped.count.toLocaleString(), max: shaped.max.toLocaleString() }));
      return;
    }
    // Logs and other pillar_axis blocks get their axis auto-oriented to match the range's
    // direction (the direction laid from point A to point B). Doesn't affect blocks with no
    // concept of orientation (determined individually via isPillarBlock)
    const rangeAxis = dominantAxis(maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1);
    const intents: WorldEditIntent[] = [];
    // Iterate the array returned by buildShape directly. Re-scanning the bbox would undo the
    // point of removing the pre-pass for sparse shapes (a hollow dome would spin through tens
    // of times the actual generated count for nothing). The return value is already in the
    // same x → y → z ascending order as the existing fill, so the ordering contract still holds
    for (const [x, y, z] of shaped.cells) {
      const worldCell: [number, number, number] = [x, y, z];
      const paintIndex = getPaintBlock();
      if (paintIndex === null) continue;
      // A batch operation can't express a per-cell orientation, so default orientation is
      // used across the board. Only pillar_axis blocks automatically reflect the range's direction
      const def = getCatalog()[paintIndex];
      const code = def && isPillarBlock(def) ? axisToCode(rangeAxis) : def ? defaultCode(def.shape) : 0;
      intents.push({ kind: 'place', worldCell, afterWorldRaw: packPaintCell(paintIndex, code) });
    }
    // Grouped into a new group since it should be treated as a single unit, like a pillar,
    // wall, or cuboid. The generated object's name is determined by "what was placed" — if
    // the layer name were always "cuboid" even after adding a shape, it would be
    // indistinguishable in the layer tree (review, #64)
    // Appends the material name. **Fixed once, from the material at creation time**, and not
    // tracked afterward (swapping the material later doesn't change the name, same treatment
    // as the defaultName contract in #70)
    // Only voids are created **inside the group of the thing being dug into** (#113). The
    // parent is already fixed at the start of the operation, so it's not re-read here (see
    // the fillVoidParent declaration)
    const parentId = state.paintVoid ? fillVoidParent : null;
    doc.applyEditsAsNewGroup(
      intents,
      defaultName('shapeWithMaterial', {
        shape: defaultName(SHAPE_NAME_KEY[state.shape]),
        material: getPaintLabel(),
      }),
      parentId,
    );
    if (intents.length)
      toast(t('edit.placedOrErased', { count: intents.length.toLocaleString(), verb: t('edit.verbPlace') }));
    else toast(t('sel.nothingInRange'));
  }

  function updateGhost(hit: Hit | null, e?: PointerEvent): void {
    ghost.visible = false;
    highlight.visible = false;
    if (state.tool === 'select') {
      // The select tool manages its own range preview in selecttool.ts. Here we only keep
      // the status bar's cursor-coordinate display alive, and don't show the placement
      // tool's ghost/highlight
      if (!fillAnchor) fillPreview.visible = false;
      onHover(hit && hit.kind === 'voxel' ? hit.cell : null);
      return;
    }
    // The extrude phase **doesn't use hit** (#78). The extrusion amount is determined even
    // when the cursor is over empty air, so bailing out on a missing hit would commit
    // without ever showing the intended thickness. The two in-plane axes were already fixed
    // during the plane phase, so only **the face's axis** is taken from the projection (#101)
    if (fillAnchor && overlayPhase === 'height' && lastTargetCell) {
      const projected = e ? resolveRangeExtrudeCell(e, fillAnchor, fillFace) : null;
      if (projected) {
        const next: [number, number, number] = [...lastTargetCell];
        // **Only extend toward the normal's direction** (#101). The outside of the touched
        // face is the extrusion direction; it must not go into the inside (the original
        // block's side). Without checking the sign, the +face and -face would give the same
        // result, and near the boundary a 1px movement would bite into the original block
        next[fillFace.axis] = extrudeOutward(fillAnchor[fillFace.axis], projected[fillFace.axis], fillFace.sign);
        if (inRange(next)) {
          lastTargetCell = next;
          updateFillPreview();
          onHover(next);
        }
      }
      return;
    }
    // The plane phase also **doesn't use hit** (#101). It projects onto the plane containing
    // the face, so the target cell is determined even over empty air where the ray hits
    // neither ground nor a voxel. This must come before the `!hit` check — otherwise updates
    // would stop the moment the drag goes past the face's edge, defeating the point of
    // switching to projection
    if (fillAnchor && rangeMode) {
      // Looks at **the projection only**. Keeps the previous target if it's briefly null —
      // falling back to the hit path would cause the range to jump to a different surface,
      // like the ground (review, #101)
      const projected = e ? resolveRangeFaceCell(e, fillAnchor, fillFace) : null;
      if (projected && inRange(projected)) {
        lastTargetCell = projected;
        updateFillPreview();
        onHover(projected);
      }
      return;
    }
    if (!hit) {
      if (!fillAnchor) fillPreview.visible = false;
      onHover(null);
      return;
    }
    if (state.tool === 'fill') {
      const cell = resolvePlaceCellFn(hit);
      if (inRange(cell)) {
        const def = getCatalog()[state.activeBlock];
        (ghost.material).color.set(getPaintColor());
        updateGhostShape(cell, def ? defaultCode(def.shape) : 0); // Fill always uses the default orientation
        ghost.visible = true;
        onHover(cell);
        return;
      }
    }
    if (state.tool === 'place') {
      const cell = resolvePlaceCellFn(hit);
      if (inRange(cell)) {
        (ghost.material).color.set(getPaintColor());
        // In mix mode, placement always uses the default orientation regardless of what was drawn, so the ghost matches that
        updateGhostShape(cell, paintCodeFor(state.activeBlock));
        ghost.visible = true;
        onHover(cell);
        return;
      }
    } else if (hit.kind === 'voxel') {
      (highlight.material).color.set(
        state.tool === 'erase' ? '#ff5555' : '#55ccff',
      );
      highlight.position.set(hit.cell[0] + 0.5, hit.cell[1] + 0.5, hit.cell[2] + 0.5);
      highlight.visible = true;
      onHover(hit.cell);
      return;
    }
    onHover(hit.kind === 'voxel' ? hit.cell : null);
  }

  /**
   * Common teardown for an in-progress operation. pointerup / pointercancel /
   * lostpointercapture / window blur / Escape all converge here (#11).
   * - Stroke: if commit=true (a normal pointerup), finalize via EditSession.commit();
   *   otherwise (a cancel path), restore to baseline via EditSession.cancel() and discard,
   *   leaving world/tree matching the pre-operation state.
   *   Routing both commit and cancel through the same EditSession means restoration on a
   *   failed commit is also unified on the EditSession side (addressed in #21 review)
   * - Fill: only finalized when commit=true (a normal pointerup); discarded on cancel
   */
  function finishActiveOperation(commit: boolean): void {
    if (fillAnchor) {
      if (commit) commitRange();
      fillAnchor = null;
      fillVoidParent = null;
      rangeMode = null;
      overlayPhase = null;
      fillPreview.visible = false;
      onRangeSize?.(null); // clear on commit or cancel alike (don't leave stale numbers while not operating)
    }
    if (strokeSession) {
      // Membership-derivation ops have been removed — the placement owner is held by the
      // session itself, so there are no extraOps left to pass to commit (#37 B1b)
      if (commit) strokeSession.commit();
      else strokeSession.cancel();
      strokeSession = null;
      strokeTool = null;
      strokeTouched.clear();
    }
  }

  // The old window keydown handling (undo/redo, tool hotkeys, Escape) has been moved to
  // InputRouter's (#12 PR1) SHORTCUTS / Escape broadcast. Here we only expose canceling the
  // in-progress operation as cancelActive (no-op if neither fillAnchor nor stroke is active;
  // safe to call unconditionally).
  function cancelActive(): void {
    if (fillAnchor || strokeSession) finishActiveOperation(false);
  }

  /**
   * Discard the shape-fill height setting when the tool changes (review, #79).
   *
   * The height phase **holds no claim** (it proceeds with the button released), so there's
   * no path for the gesture layer to detect its end. Trying to catch this in `onPointerDown`'s
   * branches would miss the case where switching to the select tool returns early via
   * `state.tool === 'select'` before reaching that check (if missed, the first click after
   * returning to Fill would finalize the old extrusion instead of starting a new operation).
   * Unifying this through the change-notification handler keeps the behavior consistent even
   * as more tools are added.
   */
  onStateChange((event) => {
    if (event.kind === 'tool') {
      if (fillAnchor && overlayPhase === 'height' && state.tool !== 'fill') cancelActive();
      return;
    }
    /**
     * On a shape / hollow / axis / step change (setShape, toggleShapeHollow, setShapeAxis,
     * and setShapeStep all notify `shape`), **rebuild the in-progress dimensions**.
     *
     * The height phase holds no claim, so shape hotkeys still go through, and finalizing
     * (`commitRange`) reads `state` at that moment. If only the dimensions stayed fixed to
     * the shape at the start of the operation, an operation that would actually succeed
     * could be finalized while still showing a "rejected" indicator (review, #83).
     *
     * We don't take the approach of fixing to the shape at the start (having commit use a
     * snapshot too). Commit reading the current state is existing behavior from #64 / #78;
     * changing that would be a separate design decision from the dimension display.
     */
    if (event.kind === 'shape' && fillAnchor) updateFillPreview();
  });

  /** pointermove while a claim is active. Ghost/highlight tracking is handled by onHoverMove, which is called on every move (even during a claim) */
  function makeClaim(): GestureClaim {
    isPointerHeld = true;
    return {
      onMove: (e) => {
        if (!strokeSession) return;
        // **Placement is one click = one block** (#57). Dragging-to-place existed via the
        // cuboid tool (#46) and Shift+click two-point selection, which overlapped in role and
        // was a major cause of unintended placements. Erasing keeps continuous-stroke
        // behavior since "drag to erase" feels natural
        if ((strokeTool ?? state.tool) === 'place') return;
        applyToolAt(pickFromEvent(e));
      },
      onUp: (e) => {
        if (e.button !== 0) return 'ignore'; // releasing a button other than left doesn't end the operation (carried over from the old implementation's button check)
        isPointerHeld = false;
        // Shape-fill is **not finalized here** (#78). Releasing the button advances to the
        // height phase, and the next click finalizes it. **Not judged by whether the
        // projection succeeds at that instant** — the ray can be parallel to the plane and
        // return null, which would make the phase transition flip unpredictably
        if (rangeMode === 'overlay' && overlayPhase === 'plane') {
          overlayPhase = 'height';
          return 'commit';
        }
        finishActiveOperation(true);
        return 'commit';
      },
      onCancel: () => {
        isPointerHeld = false;
        finishActiveOperation(false);
      },
    };
  }

  /**
   * pointerdown route handler for InputRouter (#12 PR2). Branching is identical to the old
   * implementation's canvas pointerdown listener; only the return value is translated into
   * "create a claim (continue dragging) / handled (completes immediately) / null (yield)".
   */
  function onPointerDown(e: PointerEvent): GestureClaim | 'handled' | null {
    if (e.button !== 0) return null;
    if (isSpacePanActive?.()) return null; // yields to Space+left-drag panning (handled by OrbitControls)

    // **Component placement is checked before the tool branch** (#69 Step 3b). Placing it
    // later would let selecttool.ts consume the click while the select tool is active,
    // and the click meant to choose the placement position would never arrive
    if (getPendingComponentCells?.()) {
      const componentHit = pickFromEvent(e);
      const target = componentHit ? resolvePlaceCellFn(componentHit) : null;
      if (target) onPlaceComponent?.(target);
      componentGhost.visible = false;
      return 'handled';
    }

    if (state.tool === 'select') return null; // fully delegates to selecttool.ts's own listener (coexists until PR3)
    const hit = pickFromEvent(e);

    // Shift+click two-point range placement/erasure was removed in #103. Building a range as
    // a batch is now unified into shape-fill (plane → extrude)

    // Shape-fill's height-setting phase (#78): finalized by clicking.
    // If the tool has changed, the change notification already canceled it first, so this
    // path is only reached while fill is active
    if (fillAnchor && rangeMode === 'overlay' && overlayPhase === 'height') {
      finishActiveOperation(true);
      return 'handled';
    }

    // If the previous operation (a stroke or a pending range selection) is still active, commit/discard it before starting a new one
    if (strokeSession || fillAnchor) finishActiveOperation(false);

    if (state.tool === 'pick') {
      if (hit && hit.kind === 'voxel') {
        // The eyedropper picks up the raw value in **world orientation** (matches the
        // projected appearance, design rev.3)
        const target = doc.resolvePickTarget(hit.cell);
        if (target) {
          const { catalogIndex, code } = unpackCell(target.worldRaw);
          setActiveBlock(catalogIndex);
          // normalize against the shape before applying (overrides setActiveBlock's default reset)
          const shape = getCatalog()[catalogIndex]?.shape;
          if (shape) setPendingOrientation(encodeOrientation(decodeOrientation(shape, code)));
          setTool('place');
        }
      }
      return 'handled';
    }

    if (state.tool === 'fill') {
      if (hit) {
        const cell = resolvePlaceCellFn(hit);
        if (inRange(cell)) {
          fillAnchor = cell;
          rangeMode = 'overlay';
          overlayPhase = 'plane';
          // Fix the void's parent here (#113 / #119). Prefer an explicit selection; otherwise
          // fall back to the owner of the thing being dug into (the touched block). Doesn't
          // change for the rest of this operation
          fillVoidParent = getPlacementGroup() ?? world.winnerRefAt(hit.cell)?.ref.ownerId ?? null;
          // Fix the touched face here (#101). Doesn't change for the rest of this operation
          fillFace = faceOf(hit.normal);
          lastTargetCell = cell;
          updateFillPreview();
          return makeClaim();
        }
      }
      return 'handled'; // nothing happens on no hit / out of range (the old implementation would
      // grab capture and no-op, but this was intentionally changed since not creating a claim
      // matches the meaning of isDragging better, #12 PR2)
    }
    // placement owner is held by the session (one owner per session, even if the active group changes mid-stroke)
    strokeSession = doc.beginSession(getPlacementGroup());
    strokeTool = state.tool;
    strokeTouched.clear();
    applyToolAt(hit);
    return makeClaim();
  }

  function onHoverMove(e: PointerEvent): void {
    if (isSpacePanActive?.()) {
      ghost.visible = false;
      highlight.visible = false;
      if (!fillAnchor) fillPreview.visible = false;
      onHover(null);
      return;
    }
    const hit = pickFromEvent(e);
    // In placement mode, show the cells that would be filled (hide the normal ghost)
    if (getPendingComponentCells?.()) {
      const target = hit ? resolvePlaceCellFn(hit) : null;
      updateComponentGhost(target);
      highlight.visible = false;
      onHover(target);
      return;
    }
    componentGhost.visible = false;
    updateGhost(hit, e);
  }

  function onPointerLeave(): void {
    ghost.visible = false;
    highlight.visible = false;
    onHover(null);
  }

  return {
    isDragging: () => isPointerHeld,
    cancelActive,
    route: { id: 'edit-tools', onPointerDown, onHoverMove, onPointerLeave },
  };
}

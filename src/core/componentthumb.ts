import { parseCellKey } from './types';
import type { ComponentTemplate } from './component';

/**
 * Component thumbnail layout (#69 Step 3).
 *
 * Listing just a name doesn't tell you what a component looks like, since a component
 * is fundamentally a **shape**. Taking a screenshot of the scene isn't a good fix
 * either — camera angle, selection, and lighting would make **the same shape produce a
 * different picture every time**. Instead, this builds "a view from a fixed angle"
 * directly from the cells — **the same shape always produces the same picture**.
 *
 * ## How it's drawn
 *
 * An isometric view from above at an angle. Each cell is laid out as a hexagon (top
 * face + left face + right face).
 *
 * ```
 *      back
 *   ／     ＼        x increasing -> toward bottom-right
 *  ｜  top   ｜       z increasing -> toward bottom-left
 *   ＼     ／        y increasing -> upward
 * left ｜ right
 * ```
 *
 * **Cells closer to the viewer are drawn later.** Draw order directly encodes
 * front-to-back ordering, so the caller can just paint in the order returned
 * (depth logic doesn't need to live on the caller's side).
 */

/** A single cell in the isometric view. `x` / `y` are positions in the picture (origin at top-left), in units of one cell */
export interface ThumbCell {
  /** Position within the picture (fractional, in cell units) */
  x: number;
  y: number;
  /** The original cell's raw value (caller looks up the color) */
  raw: number;
}

export interface ThumbLayout {
  /** Closer-to-viewer cells come later (paint in this order to get correct front-to-back layering) */
  cells: ThumbCell[];
  /** Overall extent of the picture (in cell units). Caller uses this to decide the scale factor */
  width: number;
  height: number;
}

/** Apparent width/height of one cell in the isometric view (2:1 diamond) */
export const THUMB_CELL_WIDTH = 1;
export const THUMB_CELL_HEIGHT = 0.5;

/**
 * Lay out a component's cells into an isometric view.
 *
 * A node's `transform` is **not considered**. The thumbnail exists to convey "roughly
 * this shape" — accurately drawing rotated children would require computation that
 * steps outside of projection. Handling it halfway here risks a mismatch between the
 * picture and the real thing where **it's unclear which one is correct**.
 *
 * @returns An empty layout if there are no cells at all (caller treats this as "no picture")
 */
export function layoutComponentThumb(template: ComponentTemplate): ThumbLayout {
  if (!template.cells.length) return { cells: [], width: 0, height: 0 };

  const placed = template.cells.map(([, localKey, raw]) => {
    const [x, y, z] = parseCellKey(localKey);
    return { x, y, z, raw };
  });

  // Back to front. Front = larger x / larger z / smaller y
  const sorted = [...placed].sort((a, b) => a.x + a.z - (b.x + b.z) || b.y - a.y);

  const projected = sorted.map(({ x, y, z, raw }) => ({
    // x toward bottom-right, z toward bottom-left, y upward
    x: (x - z) * (THUMB_CELL_WIDTH / 2),
    y: (x + z) * (THUMB_CELL_HEIGHT / 2) - y * THUMB_CELL_HEIGHT,
    raw,
  }));

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const cell of projected) {
    minX = Math.min(minX, cell.x);
    maxX = Math.max(maxX, cell.x);
    minY = Math.min(minY, cell.y);
    maxY = Math.max(maxY, cell.y);
  }

  return {
    // Shift the top-left corner to the origin (makes it easy for the caller to add margins)
    cells: projected.map((cell) => ({ x: cell.x - minX, y: cell.y - minY, raw: cell.raw })),
    // Add one cell's apparent size (so the diamond's right/bottom edges are included)
    width: maxX - minX + THUMB_CELL_WIDTH,
    height: maxY - minY + THUMB_CELL_HEIGHT * 2,
  };
}

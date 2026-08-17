/**
 * Types for window.__bs (the E2E-only debug hook in main.ts).
 * Declaring `declare global` separately in each spec file would make the type definitions collide, so they are centralized here.
 * The actual object is a subset of the `__bs` object on the main.ts side (only the fields E2E uses).
 */
export {};

declare global {
  interface Window {
    __bs: {
      world: { size: number; get(x: number, y: number, z: number): number | null };
      /** The catalogIndex of a cell (null if empty). An API that keeps the radix of the packed representation out of the tests */
      catalogIndexAt(x: number, y: number, z: number): number | null;
      doc: {
        undoStack: unknown[];
        /** For assembling a work from E2E. The shape of an op is DocOp in core/document.ts */
        applyTransaction(tx: { ops: readonly unknown[] }): void;
        scene: { cells: { entriesOf(owner: string | null): IterableIterator<[string, number]> } };
        tree: {
          getNode(id: string):
            | {
                name: string;
                hidden?: boolean;
                locked?: boolean;
                transform?: { angleSteps: number; translate: readonly number[]; pivot2: readonly number[] };
              }
            | null
            | undefined;
          childrenOf(parentId: string | null): readonly string[];
        };
      };
      CATALOG: { id: string; nameJa: string; nameEn: string; shape: 'full' | 'slab' | 'stairs' }[];
      state: {
        activeBlock: number;
        tool: string;
        activeRecipeId: string | null;
        /** The shape of a range fill */
        shape: string;
        /** An explicit hollow setting. null means the per-shape default */
        shapeHollow: boolean | null;
        /** The axis a cylinder is extended along (0=X / 1=Y / 2=Z) */
        shapeAxis: number;
        /** The height of a slope step */
        shapeStep: number;
      };
      setActiveBlock(index: number): void;
      setActiveRecipe(id: string | null): void;
      selection: {
        get(): { kind: string; ids?: string[]; cells?: Set<string> };
        set(
          sel:
            | { kind: 'groups'; ids: string[] }
            | { kind: 'none' }
            | { kind: 'cells'; cells: Map<string, { ref: { ownerId: string | null; localCell: [number, number, number] }; worldCell: [number, number, number] }> },
        ): void;
      };
      recipeStore: {
        recipes: { id: string; name: string; entries: { blockId: string; weight: number }[] }[];
        replaceAll(recipes: { id: string; name: string; entries: { blockId: string; weight: number }[] }[]): void;
      };
      cellScreenPos(x: number, y: number, z: number): { x: number; y: number };
      groundScreenPos(x: number, z: number): { x: number; y: number };
      ctx: {
        camera: { position: { x: number; y: number; z: number } };
        /**
         * The scene actually used for rendering. Texture settings on the 3D side (repeat/offset) are
         * read from the **material actually handed to the renderer**, not from the internal BlockTypeMesh.
         */
        scene: {
          traverse(fn: (obj: { material?: unknown }) => void): void;
          /** The background color, for verifying the theme. Exposes the three.js Color as-is */
          background: { getHexString(): string };
        };
      };
      editorControls: { isDragging(): boolean };
      selectTool: { isDragging(): boolean; hasActiveDrag(): boolean };
    };
  }
}

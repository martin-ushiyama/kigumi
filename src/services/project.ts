import type { Document } from '../core/document';
import type { WorldReader } from '../core/voxels';
import type { RecipeStore } from '../core/mixpalette';
import type { ComponentStore } from '../core/component';
import type { BlockDef } from '../core/types';
import { buildMcpack, sanitizeStructureName, STRUCTURE_NAMESPACE } from '../export/mcpack';
import { buildMcstructure } from '../export/mcstructure';
import { loadProject, serializeProject, type ProjectFile } from '../project/persistence';
import { defaultName, errorText, t } from '../state';

/**
 * The browser I/O that ProjectService needs, carved out as a port (#14 PR1 review feedback).
 * ProjectService itself (this file) depends only on this port and never touches concrete
 * `document` / `Blob` / `URL` / `localStorage` / timer entities — the implementation
 * (`createBrowserProjectIO`, `./project-io-browser.ts`) is assembled and injected only by
 * main.ts (composition root).
 * Reading `File` contents (`file.text()`) is also the composition root's responsibility;
 * ProjectService's public API never exposes the `File` type (`loadProjectFromText` only takes text).
 */
export interface ProjectIO {
  /** Downloads a byte array as a file (for .mcpack export) */
  downloadBytes: (bytes: Uint8Array, filename: string, mime?: string) => void;
  /** Downloads text as a file (for JSON save. Encoding is the port implementation's responsibility, the service never touches TextEncoder) */
  downloadText: (text: string, filename: string, mime?: string) => void;
  /** Reads/writes autosave (localStorage etc.) */
  loadAutosave: () => ProjectFile | null;
  /** true if the save succeeded. **Never swallow this** — the caller branches on success/failure (#133) */
  saveAutosave: (project: ProjectFile) => boolean;
  /** Timer for debouncing. Return value/argument are treated as an opaque handle (can be swapped for a synchronous fake in tests) */
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** Dependency injection for ProjectService. #14: aside from io, only values/functions that don't depend on DOM/Three.js */
export interface ProjectServiceOpts {
  world: WorldReader;
  doc: Document;
  recipeStore: RecipeStore;
  /**
   * Component inventory (#69). **Not made optional on purpose** — forgetting to pass it would
   * leave `templateId` in the saved file without the component itself, resulting in an empty
   * instance the moment it's opened on another PC. Treated the same as recipes (`recipeStore`),
   * always required at construction time
   */
  componentStore: ComponentStore;
  /** Received via a getter called each time, in case the catalog can be swapped after load (main.ts's CATALOG is fixed today, but this is a future extension point) */
  getCatalog: () => BlockDef[];
  indexOfBlock: (blockId: string) => number | undefined;
  toast: (message: string) => void;
  /** Called when the project name changes via load/restore (the caller reflects it into e.g. a DOM input) */
  onNameChange: (name: string) => void;
  /**
   * Called when the autosave state changes. `pending` = waiting to save, `saved` = write finished.
   * The timestamp of "when it was saved" is the display side's concern, so it isn't held here
   * either (this service never touches browser entities including `Date`, same reasoning as `ProjectIO`'s design).
   */
  onSaveStateChange?: (kind: 'pending' | 'saved') => void;
  io: ProjectIO;
  /** Injectable so it can be shortened for tests (defaults to 1000ms, same as the original implementation) */
  autosaveDelayMs?: number;
}

export interface ProjectService {
  getName: () => string;
  /** For changes from the toolbar's name field. An empty string falls back to the default name (same as the original implementation) */
  setName: (name: string) => void;
  exportMcpack: () => void;
  saveProjectFile: () => void;
  /** Pass text already read from a File (reading the File itself is the composition root's responsibility, see main.ts) */
  loadProjectFromText: (text: string) => void;
  scheduleAutosave: () => void;
  /** Restores the previous autosave at startup. Does nothing if there's no save or it's corrupted (stays a fresh start) */
  restoreAutosave: () => void;
}

/** Project management extracted from main.ts (export / save / load / autosave). Behavior is unchanged (#14) */
export function createProjectService(opts: ProjectServiceOpts): ProjectService {
  const {
    world,
    doc,
    recipeStore,
    componentStore,
    getCatalog,
    indexOfBlock,
    toast,
    onNameChange,
    onSaveStateChange,
    io,
    autosaveDelayMs = 1000,
  } = opts;

  // The work name is data that gets saved, so it's fixed at **the language at creation time** (#70)
  let projectName = defaultName('project');
  /** Export count. The work file remembers it, and loading carries it forward (#133) */
  let exportRevision = 0;
  let autosaveTimer: unknown = null;

  /** The content that should be saved right now. Keeps how incidental state (components / export count) is assembled into the save in one place */
  function currentProjectFile(): ProjectFile {
    return serializeProject(projectName, doc, getCatalog(), recipeStore.recipes, {
      components: componentStore.templates,
      exportRevision,
    });
  }

  function getName(): string {
    return projectName;
  }

  function setName(name: string): void {
    projectName = name || defaultName('project');
    scheduleAutosave();
  }

  function exportMcpack(): void {
    try {
      const result = buildMcstructure(world, getCatalog());
      const name = sanitizeStructureName(projectName);
      // **Increment on every export.** Bedrock ignores an import with the same revision, so
      // re-exporting wouldn't update the Minecraft side (#133).
      // Increment first, then use it and flow it into the save — if the used revision fails to
      // save, the next export would reuse the same revision
      exportRevision += 1;
      const pack = buildMcpack(projectName, result.bytes, exportRevision);
      // **Save synchronously before starting the download.** Relying only on the autosave
      // schedule (1 second later) would lose the count if the tab closes right after exporting.
      // The next export would reuse the same revision and Bedrock would ignore the import —
      // #133 would reoccur as-is.
      //
      // **Don't export if the save fails.** Passing the count along without it having been
      // saved would quietly fall back into "imports don't trigger updates" next time. Better to
      // stop here than silently proceed
      if (!persistNow()) {
        exportRevision -= 1; // Roll back the local count too, since it couldn't be recorded
        toast(t('err.exportNotSaved'));
        return;
      }
      io.downloadBytes(pack, `${name}.mcpack`);
      const [sx, sy, sz] = result.size;
      if (result.oversized) {
        toast(t('export.doneOversize', { sx, sy, sz }));
      } else {
        toast(t('export.done', { sx, sy, sz, blocks: result.blockCount, ns: STRUCTURE_NAMESPACE, name }));
      }
    } catch (e) {
      toast(errorText(e, 'err.exportFailed'));
    }
  }

  function saveProjectFile(): void {
    const project = currentProjectFile();
    io.downloadText(JSON.stringify(project), `${sanitizeStructureName(projectName)}.blocksmith.json`, 'application/json');
    toast(t('project.saved'));
  }

  function loadProjectFromText(text: string): void {
    try {
      // loadProject is an atomic load that applies only after full validation. On failure, the existing state remains
      const parsed = loadProject(JSON.parse(text), doc, indexOfBlock, recipeStore, componentStore);
      const { name, loaded, skipped } = parsed;
      projectName = name || projectName;
      // The export count travels with the work. Failing to carry it forward would roll the
      // revision back, and Bedrock would ignore the import as "same or lower revision" (#133)
      exportRevision = parsed.exportRevision;
      onNameChange(projectName);
      toast(skipped ? t('load.doneWithSkipped', { count: loaded, skipped }) : t('load.done', { count: loaded }));
    } catch (e) {
      // Don't surface the raw message from a validation throw (would mix Japanese into the English UI).
      // errorText falls back non-DisplayableError cases to a generic message and keeps the detail in console
      toast(t('toast.loadFailed', { message: errorText(e, 'err.loadFailed') }));
    }
  }

  /**
   * Saves right now without waiting for the scheduled save. **Call this right after state that
   * would hurt to lose** (like the export count, where the correctness of the next operation
   * depends on this value, #133).
   *
   * If a save is still scheduled it would just write the same content again, so cancel it here
   */
  function persistNow(): boolean {
    if (autosaveTimer !== null) {
      io.clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
    const saved = io.saveAutosave(currentProjectFile());
    if (saved) onSaveStateChange?.('saved');
    return saved;
  }

  function scheduleAutosave(): void {
    if (autosaveTimer !== null) io.clearTimeout(autosaveTimer);
    onSaveStateChange?.('pending');
    autosaveTimer = io.setTimeout(() => {
      const saved = io.saveAutosave(currentProjectFile());
      autosaveTimer = null;
      // Don't report 'saved' if the write failed (never claim saved when it isn't)
      if (saved) onSaveStateChange?.('saved');
    }, autosaveDelayMs);
  }

  function restoreAutosave(): void {
    const saved = io.loadAutosave();
    if (!saved) return;
    try {
      const restored = loadProject(saved, doc, indexOfBlock, recipeStore, componentStore);
      const { name, loaded } = restored;
      projectName = name || projectName;
      exportRevision = restored.exportRevision;
      onNameChange(projectName);
      if (loaded) toast(t('load.restored', { count: loaded }));
    } catch {
      // Ignore a corrupted autosave and start fresh (same as the original implementation)
    }
  }

  return { getName, setName, exportMcpack, saveProjectFile, loadProjectFromText, scheduleAutosave, restoreAutosave };
}

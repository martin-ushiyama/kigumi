import { unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { ComponentStore } from '../../src/core/component';
import { buildIndexOf, RecipeStore } from '../../src/core/mixpalette';
import { packCell } from '../../src/core/orientation';
import { CATALOG } from '../../src/data/blocks';
import { createProjectService, type ProjectIO } from '../../src/services/project';
import type { ProjectFile } from '../../src/project/persistence';
import { DocumentFixture } from '../helpers/document-fixture';
import { setLang } from '../../src/state';

const indexOfBlock = buildIndexOf(CATALOG);

/**
 * A synchronous fake for ProjectIO. setTimeout does not use a real timer, it just holds onto
 * "the most recently scheduled fn" (on the assumption that debounce always leaves only one
 * pending call, same as the original implementation). Tests fire it explicitly via flushTimer().
 */
function makeFakeIO(): ProjectIO & {
  downloads: { kind: 'bytes' | 'text'; payload: Uint8Array | string; filename: string; mime?: string }[];
  autosaved: ProjectFile[];
  setAutosaveData: (data: ProjectFile | null) => void;
  failSaves: (fails: boolean) => void;
  flushTimer: () => void;
  hasPendingTimer: () => boolean;
} {
  const downloads: { kind: 'bytes' | 'text'; payload: Uint8Array | string; filename: string; mime?: string }[] = [];
  const autosaved: ProjectFile[] = [];
  let autosaveData: ProjectFile | null = null;
  let pending: (() => void) | null = null;
  let saveFails = false;

  return {
    downloadBytes: (bytes, filename, mime) => downloads.push({ kind: 'bytes', payload: bytes, filename, mime }),
    downloadText: (text, filename, mime) => downloads.push({ kind: 'text', payload: text, filename, mime }),
    loadAutosave: () => autosaveData,
    saveAutosave: (project) => {
      // A real browser may fail to write due to quota overflow etc. **Make failure reproducible too**
      if (saveFails) return false;
      autosaveData = project;
      autosaved.push(project);
      return true;
    },
    setTimeout: (fn) => {
      pending = fn;
      return {};
    },
    clearTimeout: () => {
      pending = null;
    },
    downloads,
    autosaved,
    setAutosaveData: (data) => {
      autosaveData = data;
    },
    /** Put save into a failing state (reproduces localStorage write failure) */
    failSaves: (fails: boolean) => {
      saveFails = fails;
    },
    flushTimer: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
    hasPendingTimer: () => pending !== null,
  };
}

function setup() {
  const doc = new DocumentFixture();
  const recipeStore = new RecipeStore(null);
  const componentStore = new ComponentStore(null);
  const toast = vi.fn();
  const onNameChange = vi.fn();
  const onSaveStateChange = vi.fn();
  const io = makeFakeIO();
  const service = createProjectService({
    world: doc.world,
    doc,
    recipeStore,
    componentStore,
    getCatalog: () => CATALOG,
    indexOfBlock,
    toast,
    onNameChange,
    onSaveStateChange,
    io,
  });
  return { doc, recipeStore, componentStore, toast, onNameChange, onSaveStateChange, io, service };
}

describe('ProjectService — getName/setName', () => {
  it('the initial name is the default language (EN) "Untitled"', () => {
    const { service } = setup();
    expect(service.getName()).toBe('Untitled');
  });

  it('setName changes the name', () => {
    const { service } = setup();
    service.setName('My Town');
    expect(service.getName()).toBe('My Town');
  });

  it('passing an empty string to setName falls back to the default name (same as the original implementation)', () => {
    const { service } = setup();
    service.setName('My Town');
    service.setName('');
    expect(service.getName()).toBe('Untitled');
  });
});

describe('ProjectService — exportMcpack', () => {
  it('when there are blocks, passes .mcpack byte data and filename to io.downloadBytes, and notifies export completion for a normal size', () => {
    const { doc, service, io, toast } = setup();
    doc.setCells([[0, 0, 0, packCell(0, 0)]]);
    // non-ASCII names get an identifier derived from the project name appended. Use an ASCII name here since we want to assert the filename exactly
    service.setName('my-castle');
    io.downloads.length = 0; // unrelated to setName's autosave path, clear explicitly

    service.exportMcpack();

    expect(io.downloads).toHaveLength(1);
    expect(io.downloads[0]!.kind).toBe('bytes');
    expect(io.downloads[0]!.filename).toBe('my-castle.mcpack');
    expect((io.downloads[0]!.payload as Uint8Array).length).toBeGreaterThan(0);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Exported'));
  });

  it('when there are no blocks at all, buildMcstructure throws, io.downloadBytes is not called, and an error message is passed to toast', () => {
    const { service, io, toast } = setup();
    service.exportMcpack();
    expect(io.downloads).toHaveLength(0);
    expect(toast).toHaveBeenCalledWith('No blocks have been placed');
  });
});

describe('ProjectService — saveProjectFile', () => {
  it('passes JSON reflecting the current world and a filename to io.downloadText, and notifies save completion', () => {
    const { doc, service, io, toast } = setup();
    doc.setCells([[1, 0, 0, packCell(0, 0)]]);
    service.setName('my-warehouse');
    io.downloads.length = 0;

    service.saveProjectFile();

    expect(io.downloads).toHaveLength(1);
    expect(io.downloads[0]!.kind).toBe('text');
    expect(io.downloads[0]!.filename).toBe('my-warehouse.blocksmith.json');
    const parsed = JSON.parse(io.downloads[0]!.payload as string) as { name: string; cells: unknown[] };
    expect(parsed.name).toBe('my-warehouse');
    expect(parsed.cells).toHaveLength(1); // v3: owner-local cells
    expect(toast).toHaveBeenCalledWith('Project saved'); // default language (EN)
  });
});

describe('ProjectService — loadProjectFromText', () => {
  function validJson(name = 'Test'): string {
    return JSON.stringify({
      app: 'blocksmith',
      version: 1,
      name,
      blocks: [[5, 0, 5, 'minecraft:stone_bricks']],
      recipes: [],
    });
  }

  it('loading valid JSON is reflected in doc, and onNameChange and toast (with a count) are called', () => {
    const { doc, service, onNameChange, toast } = setup();
    service.loadProjectFromText(validJson('New City'));

    expect(doc.world.size).toBe(1);
    expect(service.getName()).toBe('New City');
    expect(onNameChange).toHaveBeenCalledWith('New City');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Loaded'));
  });

  it('broken JSON (unparsable) keeps the existing state and notifies load failure', () => {
    const { doc, service, onNameChange, toast } = setup();
    doc.setCells([[0, 0, 0, packCell(0, 0)]]);
    service.setName('Original Name');

    service.loadProjectFromText('{ invalid json');

    expect(doc.world.size).toBe(1); // existing state is retained
    expect(service.getName()).toBe('Original Name'); // the name doesn't change either
    expect(onNameChange).not.toHaveBeenCalledWith(expect.not.stringMatching('Original Name'));
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Load failed'));
  });

  it('JSON with correct structure but failing validation (app mismatch) also notifies load failure and keeps existing state', () => {
    const { doc, service, toast } = setup();
    doc.setCells([[0, 0, 0, packCell(0, 0)]]);

    service.loadProjectFromText(JSON.stringify({ app: 'other', version: 1, name: 'x', blocks: [], recipes: [] }));

    expect(doc.world.size).toBe(1);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Load failed'));
  });

  /**
   * Raised in review. `persistence.ts`'s validation throws were in Japanese at the time, so putting
   * the raw `e.message` into the toast meant **Japanese leaking into the English UI**.
   * This went undetected because the test only checked "does it have the Load failed prefix".
   *
   * It doesn't reproduce with a syntax error (browser-originated English SyntaxError).
   * Pin it down with **JSON that is syntactically correct but fails validation**.
   *
   * Those throws have since been translated, so this path no longer carries Japanese. The guard stays: what it pins
   * down is that a raw `e.message` never reaches the toast, which holds whatever language it is in.
   */
  describe('load-failure wording does not mix in raw exception messages', () => {
    const JA = /[぀-ヿ一-鿿]/;

    /** JSON that is syntactically correct but fails validation (the path that goes through the validation throws) */
    const invalidProjects: Record<string, unknown> = {
      'app mismatch': { app: 'other', version: 1, name: 'x', blocks: [], recipes: [] },
      'groups is not an array': { app: 'blocksmith', version: 2, name: 'x', groups: 'no', blocks: [], recipes: [] },
      'blocks is not an array': { app: 'blocksmith', version: 1, name: 'x', blocks: 'no', recipes: [] },
      'blocks element is invalid': { app: 'blocksmith', version: 1, name: 'x', blocks: [[1, 2]], recipes: [] },
    };

    for (const [label, project] of Object.entries(invalidProjects)) {
      it(`reading ${label} in the English UI does not produce Japanese`, () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          const { service, toast } = setup();
          service.loadProjectFromText(JSON.stringify(project));

          const message = toast.mock.calls.at(-1)?.[0] as string;
          expect(message).toContain('Load failed');
          expect(JA.test(message), `Japanese is mixed into the toast: ${message}`).toBe(false);
          // details remain in the console (doesn't hurt debuggability)
          expect(consoleError).toHaveBeenCalled();
        } finally {
          consoleError.mockRestore();
        }
      });
    }

    it('in JA locale, Japanese is shown (not just forced to English)', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      setLang('ja');
      try {
        const { service, toast } = setup();
        service.loadProjectFromText(JSON.stringify(invalidProjects['app mismatch']));
        const message = toast.mock.calls.at(-1)?.[0] as string;
        expect(JA.test(message)).toBe(true);
        expect(message).not.toContain('Load failed');
      } finally {
        setLang('en');
        consoleError.mockRestore();
      }
    });

    it('even for a syntax error, does not show the browser-originated SyntaxError text as-is', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const { service, toast } = setup();
        service.loadProjectFromText('{ invalid json');
        const message = toast.mock.calls.at(-1)?.[0] as string;
        expect(message).not.toContain('JSON');
        expect(message).not.toContain('token');
      } finally {
        consoleError.mockRestore();
      }
    });
  });
});

describe('ProjectService — scheduleAutosave (debounce)', () => {
  it('consecutive calls still collapse into a single timer (clears the previous one before rescheduling)', () => {
    const { service, io } = setup();
    service.scheduleAutosave();
    expect(io.hasPendingTimer()).toBe(true);
    service.scheduleAutosave();
    service.scheduleAutosave();
    expect(io.hasPendingTimer()).toBe(true); // stays collapsed into one

    io.flushTimer();
    expect(io.autosaved).toHaveLength(1); // fires only once
  });

  it('when the timer fires, a ProjectFile reflecting the current world/name is passed to io.saveAutosave', () => {
    const { doc, service, io } = setup();
    doc.setCells([[2, 0, 2, packCell(0, 0)]]);
    service.setName('Fire Test'); // this itself also calls scheduleAutosave, but only the latest one remains
    io.flushTimer();

    expect(io.autosaved).toHaveLength(1);
    expect(io.autosaved[0]!.name).toBe('Fire Test');
    expect(io.autosaved[0]!.cells).toHaveLength(1); // v4 also inherits owner-local cells
  });

  it('scheduling notifies pending, then saved after the write finishes (if reversed, "saved" would appear first)', () => {
    const { service, onSaveStateChange, io } = setup();
    service.scheduleAutosave();
    expect(onSaveStateChange.mock.calls).toEqual([['pending']]);

    // saved fires **after** saveAutosave. Confirm, together with the saved count, that the
    // write has completed by the time of the notification
    onSaveStateChange.mockImplementation((kind: string) => {
      if (kind === 'saved') expect(io.autosaved).toHaveLength(1);
    });
    io.flushTimer();
    expect(onSaveStateChange.mock.calls).toEqual([['pending'], ['saved']]);
  });

  it('consecutive scheduling re-emits pending, and only the one that fires becomes saved', () => {
    const { service, onSaveStateChange, io } = setup();
    service.scheduleAutosave();
    service.scheduleAutosave();
    io.flushTimer();
    expect(onSaveStateChange.mock.calls).toEqual([['pending'], ['pending'], ['saved']]);
  });
});

describe('ProjectService — restoreAutosave', () => {
  it('does nothing when there is no saved data (toast/onNameChange are not called)', () => {
    const { service, toast, onNameChange } = setup();
    service.restoreAutosave();
    expect(toast).not.toHaveBeenCalled();
    expect(onNameChange).not.toHaveBeenCalled();
    expect(service.getName()).toBe('Untitled');
  });

  it('if there is saved data, it is reflected in doc, and onNameChange and a restore notification are called', () => {
    const { doc, service, io, toast, onNameChange } = setup();
    // also confirms that old autosave (v2) can be read — writes are v4 but old versions still load
    io.setAutosaveData({
      app: 'blocksmith',
      version: 2,
      name: 'Restore Target',
      blocks: [[3, 0, 3, 'minecraft:stone', 0, -1]],
      groups: [],
      recipes: [],
    } as unknown as ProjectFile);

    service.restoreAutosave();

    expect(doc.world.size).toBe(1);
    expect(service.getName()).toBe('Restore Target');
    expect(onNameChange).toHaveBeenCalledWith('Restore Target');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Restored'));
  });

  it('broken autosave data (fails validation) is ignored and treated as a fresh start with the existing state (no toast)', () => {
    const { doc, service, io, toast } = setup();
    io.setAutosaveData({ app: 'other' } as unknown as ProjectFile);

    expect(() => service.restoreAutosave()).not.toThrow();
    expect(doc.world.size).toBe(0);
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('ProjectService — the default name is determined by the language at creation time', () => {
  it('switching to JA before creating produces "作品", and the name does not change even after switching back to EN', () => {
    setLang('ja');
    try {
      const { service } = setup();
      expect(service.getName()).toBe('作品');
      // the default name is **saved data**, so it must not change retroactively when the language is switched
      setLang('en');
      expect(service.getName()).toBe('作品');
    } finally {
      setLang('en');
    }
  });
});

/**
 * The export count is **remembered by the project file**.
 * If it's only kept in the local browser, the version drops back down the moment you
 * switch PCs / clear data, returning to the state where Minecraft ignores the import
 * (= the symptom we're fixing right now).
 */
describe('ProjectService — export count', () => {
  const versionOfLastPack = (io: ReturnType<typeof makeFakeIO>) => {
    const pack = io.downloads.filter((download) => download.kind === 'bytes').at(-1)!;
    const files = unzipSync(pack.payload as Uint8Array);
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as {
      header: { version: number[] };
    };
    return manifest.header.version;
  };

  it('the version goes up every time you export', () => {
    const { doc, service, io } = setup();
    doc.setCells([[0, 0, 0, packCell(0, 0)]]);
    service.exportMcpack();
    const first = versionOfLastPack(io);
    service.exportMcpack();
    expect(versionOfLastPack(io)).not.toEqual(first);
    expect(versionOfLastPack(io)[2]).toBeGreaterThan(first[2]!);
  });

  it('the saved project file carries the count', () => {
    const { doc, service, io } = setup();
    doc.setCells([[0, 0, 0, packCell(0, 0)]]);
    service.exportMcpack();
    service.saveProjectFile();
    const saved = JSON.parse(io.downloads.filter((download) => download.kind === 'text').at(-1)!.payload as string) as {
      exportRevision?: number;
    };
    expect(saved.exportRevision).toBe(1);
  });

  it('a project file that has never been exported does not have the count written', () => {
    const { doc, service, io } = setup();
    doc.setCells([[0, 0, 0, packCell(0, 0)]]);
    service.saveProjectFile();
    const saved = JSON.parse(io.downloads.filter((download) => download.kind === 'text').at(-1)!.payload as string) as Record<
      string,
      unknown
    >;
    expect('exportRevision' in saved).toBe(false);
  });

  /** Without carrying it over, the version rolls back and imports stop updating again */
  it('loading a project file carries over the count', () => {
    const first = setup();
    first.doc.setCells([[0, 0, 0, packCell(0, 0)]]);
    first.service.exportMcpack();
    first.service.exportMcpack();
    first.service.saveProjectFile();
    const text = first.io.downloads.filter((download) => download.kind === 'text').at(-1)!.payload as string;

    const next = setup();
    next.service.loadProjectFromText(text);
    next.service.exportMcpack();
    // the loaded side's 1st export becomes a newer version than the original's 2nd
    expect(versionOfLastPack(next.io)[2]).toBe(3);
  });

  it('a broken count is treated as 0, without failing the whole load', () => {
    const first = setup();
    first.doc.setCells([[0, 0, 0, packCell(0, 0)]]);
    first.service.saveProjectFile();
    const saved = JSON.parse(first.io.downloads.filter((download) => download.kind === 'text').at(-1)!.payload as string) as Record<
      string,
      unknown
    >;
    saved.exportRevision = 'lots';

    const next = setup();
    next.service.loadProjectFromText(JSON.stringify(saved));
    next.service.exportMcpack();
    expect(versionOfLastPack(next.io)).toEqual([1, 0, 1]);
  });
});

/**
 * The export count is **saved before the download starts**.
 * With only the autosave schedule (1 second later), closing the tab right after exporting
 * would lose the count, and the next export would reuse the same version.
 */
describe('ProjectService — timing of saving the export count', () => {
  const versionOfLastPack = (io: ReturnType<typeof makeFakeIO>) => {
    const pack = io.downloads.filter((download) => download.kind === 'bytes').at(-1)!;
    const files = unzipSync(pack.payload as Uint8Array);
    return (
      JSON.parse(new TextDecoder().decode(files['manifest.json'])) as { header: { version: number[] } }
    ).header.version;
  };

  it('already saved at the moment of export (does not wait for the schedule to fire)', () => {
    const { doc, service, io } = setup();
    doc.setCells([[0, 0, 0, packCell(0, 0)]]);
    service.exportMcpack();
    expect(io.autosaved.at(-1)?.exportRevision).toBe(1);
    expect(io.hasPendingTimer(), 'does not leave a pending schedule (would just write the same content again)').toBe(false);
  });

  it('even if you quit right after exporting, the version increases the next time you open it', () => {
    const first = setup();
    first.doc.setCells([[0, 0, 0, packCell(0, 0)]]);
    first.service.exportMcpack();
    // don't fire the schedule = the situation of closing the tab right after downloading
    expect(first.io.hasPendingTimer()).toBe(false);
    const saved = first.io.autosaved.at(-1)!;

    const next = setup();
    next.io.setAutosaveData(saved);
    next.service.restoreAutosave();
    next.service.exportMcpack();
    expect(versionOfLastPack(next.io)).toEqual([1, 0, 2]);
  });
});

/**
 * A real browser's autosave can fail to write to `localStorage`. Swallowing that failure
 * means **the export goes through even though it wasn't saved, and the next export reuses
 * the same version**.
 */
describe('ProjectService — exporting when the save failed', () => {
  it('does not export if the save fails', () => {
    const { doc, service, io, toast } = setup();
    doc.setCells([[0, 0, 0, packCell(0, 0)]]);
    io.failSaves(true);
    service.exportMcpack();
    expect(io.downloads.filter((download) => download.kind === 'bytes')).toEqual([]);
    expect(toast).toHaveBeenCalled();
  });

  it('a failed save does not advance the count locally either (starts from the same version on the next success)', () => {
    const { doc, service, io } = setup();
    doc.setCells([[0, 0, 0, packCell(0, 0)]]);
    io.failSaves(true);
    service.exportMcpack();
    io.failSaves(false);
    service.exportMcpack();

    const pack = io.downloads.filter((download) => download.kind === 'bytes').at(-1)!;
    const files = unzipSync(pack.payload as Uint8Array);
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as {
      header: { version: number[] };
    };
    expect(manifest.header.version).toEqual([1, 0, 1]);
    expect(io.autosaved.at(-1)?.exportRevision).toBe(1);
  });
});

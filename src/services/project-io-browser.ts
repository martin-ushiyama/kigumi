import { autosave, loadAutosave } from '../project/persistence';
import type { ProjectIO } from './project';

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * The real browser implementation of `ProjectIO` (`document` / `Blob` / `URL` / `localStorage` / timer).
 * `../services/project.ts` (the ProjectService body) never imports this file — only main.ts
 * (composition root) assembles this and injects it, e.g. `createProjectService({ io: createBrowserProjectIO() })`
 * (#14 PR1 review feedback: separates the browser I/O implementation from the service body).
 */
export function createBrowserProjectIO(): ProjectIO {
  return {
    downloadBytes: (bytes, filename, mime) => {
      const ab = new ArrayBuffer(bytes.length);
      new Uint8Array(ab).set(bytes);
      downloadBlob(new Blob([ab], { type: mime }), filename);
    },
    downloadText: (text, filename, mime) => downloadBlob(new Blob([text], { type: mime }), filename),
    loadAutosave, // Reuses project/persistence.ts's implementation directly as the port (avoids a duplicate implementation hitting localStorage directly)
    saveAutosave: autosave,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

import { unzip } from 'fflate';
import textureManifest from '../data/textures.json';
import environmentTextures from '../data/env-textures.json';
import { staticTextureUrl, type TextureUrlResolver } from '../core/textureframe';

const DB_NAME = 'kigumi-textures';
const DB_VERSION = 1;
const STORE_NAME = 'files';
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_TEXTURE_BYTES = 8 * 1024 * 1024;
const MAX_STORED_BYTES = 64 * 1024 * 1024;

type TextureEntry = { side: string; top?: string };

export const REQUIRED_TEXTURE_FILES = [
  ...new Set([
    ...Object.values(textureManifest as Record<string, TextureEntry>).flatMap((entry) =>
      entry.top ? [entry.side, entry.top] : [entry.side],
    ),
    environmentTextures.grassTop,
  ]),
].sort();

const REQUIRED_BY_LOWERCASE = new Map(REQUIRED_TEXTURE_FILES.map((file) => [file.toLowerCase(), file]));

export type TexturePackErrorCode =
  | 'archive-too-large'
  | 'invalid-archive'
  | 'no-matching-textures'
  | 'texture-too-large';

export class TexturePackError extends Error {
  constructor(readonly code: TexturePackErrorCode) {
    super(code);
    this.name = 'TexturePackError';
  }
}

export interface TextureImportResult {
  imported: number;
  required: number;
}

function normalizedEntryPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Maps a zip entry (including optional wrapper folders) to a manifest-relative filename. */
export function textureFileForArchiveEntry(path: string): string | null {
  const normalized = normalizedEntryPath(path);
  const marker = 'textures/blocks/';
  const markerIndex = normalized.toLowerCase().lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const relative = normalized.slice(markerIndex + marker.length);
  return REQUIRED_BY_LOWERCASE.get(relative.toLowerCase()) ?? null;
}

function unzipRequiredTextures(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    let selectedBytes = 0;
    let oversized = false;
    unzip(
      bytes,
      {
        filter: (entry) => {
          if (textureFileForArchiveEntry(entry.name) === null) return false;
          selectedBytes += entry.originalSize;
          if (entry.originalSize > MAX_TEXTURE_BYTES || selectedBytes > MAX_STORED_BYTES) {
            oversized = true;
            return false;
          }
          return true;
        },
      },
      (error, files) => {
        if (oversized) reject(new TexturePackError('texture-too-large'));
        else if (error) reject(new TexturePackError('invalid-archive'));
        else resolve(files);
      },
    );
  });
}

/** Extracts only files used by the committed texture manifest. */
export async function extractRequiredTextures(bytes: Uint8Array): Promise<Map<string, Blob>> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = await unzipRequiredTextures(bytes);
  } catch (error) {
    if (error instanceof TexturePackError) throw error;
    throw new TexturePackError('invalid-archive');
  }

  const selected = new Map<string, Blob>();
  let totalBytes = 0;
  for (const [path, data] of Object.entries(entries).sort(([a], [b]) => a.length - b.length)) {
    const file = textureFileForArchiveEntry(path);
    if (!file || selected.has(file)) continue;
    if (data.byteLength > MAX_TEXTURE_BYTES || totalBytes + data.byteLength > MAX_STORED_BYTES) {
      throw new TexturePackError('texture-too-large');
    }
    totalBytes += data.byteLength;
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    selected.set(file, new Blob([copy.buffer], { type: 'image/png' }));
  }
  if (selected.size === 0) throw new TexturePackError('no-matching-textures');
  return selected;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(new Error('IndexedDB request failed', { cause: request.error })), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('abort', () => reject(new Error('IndexedDB transaction aborted', { cause: transaction.error })), { once: true });
    transaction.addEventListener('error', () => reject(new Error('IndexedDB transaction failed', { cause: transaction.error })), { once: true });
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener(
      'upgradeneeded',
      () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      },
      { once: true },
    );
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(new Error('Could not open the texture database', { cause: request.error })), { once: true });
  });
}

export interface TexturePackService {
  resolveUrl: TextureUrlResolver;
  count: () => Promise<number>;
  importFile: (file: File) => Promise<TextureImportResult>;
  clear: () => Promise<void>;
  dispose: () => void;
}

/** Browser-owned storage for user-supplied resource-pack textures. */
export function createTexturePackService(): TexturePackService {
  const resolvedUrls = new Map<string, Promise<string>>();
  const objectUrls = new Set<string>();
  let databasePromise: Promise<IDBDatabase> | null = null;
  let urlGeneration = 0;

  function database(): Promise<IDBDatabase> {
    databasePromise ??= openDatabase().catch((error) => {
      databasePromise = null;
      throw error;
    });
    return databasePromise;
  }

  function invalidateUrls(): void {
    urlGeneration++;
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
    resolvedUrls.clear();
  }

  const resolveUrl: TextureUrlResolver = (file) => {
    const fallback = staticTextureUrl(file);
    if (typeof indexedDB === 'undefined' || typeof URL.createObjectURL !== 'function') return Promise.resolve(fallback);
    const cached = resolvedUrls.get(file);
    if (cached) return cached;
    const generation = urlGeneration;
    const pending = database()
      .then((database) => {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).get(file) as IDBRequest<Blob | undefined>;
        return requestResult(request);
      })
      .then((blob) => {
        if (!blob || generation !== urlGeneration) return fallback;
        const url = URL.createObjectURL(blob);
        objectUrls.add(url);
        return url;
      })
      .catch(() => fallback);
    resolvedUrls.set(file, pending);
    return pending;
  };

  async function count(): Promise<number> {
    if (typeof indexedDB === 'undefined') return 0;
    const open = await database();
    return requestResult(open.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).count());
  }

  async function importFile(file: File): Promise<TextureImportResult> {
    if (file.size > MAX_ARCHIVE_BYTES) throw new TexturePackError('archive-too-large');
    const selected = await extractRequiredTextures(new Uint8Array(await file.arrayBuffer()));
    const open = await database();
    const transaction = open.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.clear();
    for (const [name, blob] of selected) store.put(blob, name);
    await transactionDone(transaction);
    invalidateUrls();
    return { imported: selected.size, required: REQUIRED_TEXTURE_FILES.length };
  }

  async function clear(): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    const open = await database();
    const transaction = open.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).clear();
    await transactionDone(transaction);
    invalidateUrls();
  }

  function dispose(): void {
    invalidateUrls();
    if (databasePromise) void databasePromise.then((open) => open.close()).catch(() => undefined);
    databasePromise = null;
  }

  return { resolveUrl, count, importFile, clear, dispose };
}

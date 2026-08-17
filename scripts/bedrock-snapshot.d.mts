export const SNAPSHOT_DIR: string;
export const SOURCE_PATH: string;
export const UPSTREAM_REPO: string;
export const SNAPSHOT_FILES: Readonly<Record<string, string>>;

export interface SnapshotFileRecord {
  path: string;
  bytes: number;
  sha256: string;
}

export interface SnapshotSource {
  repository: string;
  commit: string;
  files: Record<string, SnapshotFileRecord>;
}

export function sha256(buf: Uint8Array | string): string;
export function rawUrl(commit: string, path: string): string;
export function readSource(): SnapshotSource | null;
export function buildSource(args: {
  commit: string;
  files: Record<string, SnapshotFileRecord>;
}): SnapshotSource;
export function formatSource(source: SnapshotSource): string;
export function verifySnapshotBytes(args: {
  name: string;
  bytes: Uint8Array | null;
  source: SnapshotSource | null;
}): string | null;
export function readSnapshot(name: string, encoding?: 'utf-8'): string;
export function readSnapshot(name: string, encoding: 'buffer'): Buffer;

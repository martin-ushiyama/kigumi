import { describe, expect, it } from 'vitest';
import sourceJson from '../data/bedrock/SOURCE.json';
import {
  buildSource,
  formatSource,
  rawUrl,
  sha256,
  SNAPSHOT_FILES,
  UPSTREAM_REPO,
  verifySnapshotBytes,
} from '../scripts/bedrock-snapshot.mjs';

/**
 * The upstream snapshot contract (#97 stage 1).
 *
 * The real files (data/bedrock/*.json and friends) belong to Mojang under All rights reserved,
 * so they are gitignored and **do not exist in CI**. The checks are therefore pinned to two things:
 *
 *   - the shape of the record (SOURCE.json, the only file that gets committed)
 *   - verifySnapshotBytes, the pure function that reconciles the record against the bytes
 *
 * Depending on the real files would stop the checks themselves from running in CI.
 */

const source = sourceJson as {
  repository: string;
  commit: string;
  files: Record<string, { path: string; bytes: number; sha256: string }>;
};

describe('SOURCE.json — the record of which commit and which files were assumed', () => {
  it('pins the upstream repository and commit (following main would make the output depend on the run date)', () => {
    expect(source.repository).toBe(UPSTREAM_REPO);
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  /**
   * "When was it imported" is already held by git, as the moment SOURCE.json was committed.
   * Keeping a timestamp in the record would make a tracked file go dirty just from re-fetching
   * the same commit (#98 review finding). The same fact is not written down in two places.
   */
  it('holds no value that changes on every run, such as a fetch timestamp', () => {
    const keys = Object.keys(source);
    expect(keys.filter((k) => /at$|time|date/i.test(k))).toEqual([]);
  });

  it('keeps the fetch targets and the record as the same set (growing only one side leaves the other silently stale)', () => {
    expect(Object.keys(source.files).sort()).toEqual(Object.keys(SNAPSHOT_FILES).sort());
  });

  it('gives every record an upstream path, size, and hash', () => {
    for (const [name, rel] of Object.entries(SNAPSHOT_FILES)) {
      const record = source.files[name];
      expect(record, name).toBeDefined();
      expect(record!.path, name).toBe(rel);
      expect(record!.sha256, name).toMatch(/^[0-9a-f]{64}$/);
      expect(record!.bytes, name).toBeGreaterThan(1024);
    }
  });
});

describe('rawUrl — fetches by commit (pointing at main would defeat the purpose of pinning)', () => {
  it('puts the recorded commit into the URL', () => {
    const url = rawUrl(source.commit, 'metadata/vanilladata_modules/mojang-blocks.json');
    expect(url).toContain(`/${source.commit}/`);
    expect(url).not.toContain('/main/');
  });
});

describe('buildSource — the record is determined solely by the upstream state', () => {
  const files = Object.fromEntries(
    Object.entries(SNAPSHOT_FILES).map(([name, path]) => [
      name,
      { path, bytes: 2048, sha256: sha256(Buffer.from('a'.repeat(2048))) },
    ]),
  );
  const commit = 'f'.repeat(40);

  /**
   * The regression contract requested in review (#98):
   * "re-fetching the same commit with the same bytes is byte-identical to SOURCE.json".
   * Pinned down without depending on the clock or the network.
   */
  it('is byte-identical however many times it is built, given the same commit and bytes', () => {
    const a = formatSource(buildSource({ commit, files }));
    const b = formatSource(buildSource({ commit, files }));
    expect(a).toBe(b);
  });

  it('keeps the record identical when the file order changes (fetch order produces no diff)', () => {
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    expect(formatSource(buildSource({ commit, files: reversed }))).toBe(
      formatSource(buildSource({ commit, files })),
    );
  });

  it('changes the record when the commit changes', () => {
    const a = formatSource(buildSource({ commit, files }));
    const b = formatSource(buildSource({ commit: '0'.repeat(40), files }));
    expect(a).not.toBe(b);
  });

  it('changes the record when even one file\'s bytes change', () => {
    const changed = {
      ...files,
      'en_US.lang': { ...files['en_US.lang']!, sha256: sha256(Buffer.from('b')) },
    };
    expect(formatSource(buildSource({ commit, files }))).not.toBe(
      formatSource(buildSource({ commit, files: changed })),
    );
  });

  it('makes the committed SOURCE.json byte-identical to a rebuild from its own contents', () => {
    // Verifies against the real artifact that the record is "a pure function of the upstream state".
    // If this drifts, a value unrelated to upstream has crept into the record
    const rebuilt = formatSource(buildSource({ commit: source.commit, files: source.files }));
    expect(rebuilt).toBe(JSON.stringify(sourceJson, null, 2) + String.fromCharCode(10));
  });
});

describe('verifySnapshotBytes — reconciling the record against the real bytes', () => {
  const name = 'mojang-blocks.json';
  const bytes = Buffer.from('a'.repeat(2048));
  const ok = {
    repository: UPSTREAM_REPO,
    commit: 'f'.repeat(40),
    files: {
      ...Object.fromEntries(
        Object.entries(SNAPSHOT_FILES).map(([n, path]) => [
          n,
          { path, bytes: bytes.length, sha256: sha256(bytes) },
        ]),
      ),
    },
  };

  it('reports no problem when they match', () => {
    expect(verifySnapshotBytes({ name, bytes, source: ok })).toBeNull();
  });

  it('detects a difference of even a single byte', () => {
    const tampered = Buffer.concat([bytes, Buffer.from('x')]);
    expect(verifySnapshotBytes({ name, bytes: tampered, source: ok })).toContain('does not match the record');
  });

  it('detects a missing real file and includes how to re-fetch it', () => {
    const message = verifySnapshotBytes({ name, bytes: null, source: ok });
    expect(message).toContain('the real snapshot file is missing');
    expect(message).toContain('fetch-bedrock-snapshot');
  });

  it('detects a missing record entirely', () => {
    expect(verifySnapshotBytes({ name, bytes, source: null })).toContain('SOURCE.json');
  });

  it('detects a file absent from the record (when only the fetch targets were extended)', () => {
    const partial = { ...ok, files: { ...ok.files } };
    delete partial.files[name];
    expect(verifySnapshotBytes({ name, bytes, source: partial })).toContain('has no record for');
  });

  it('does not accept a name outside the fetch targets', () => {
    expect(verifySnapshotBytes({ name: 'passwd', bytes, source: ok })).toContain('outside the snapshot');
  });
});

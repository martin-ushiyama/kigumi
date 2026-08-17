/**
 * Fetches a snapshot of the upstream files from Mojang bedrock-samples.
 *
 * gen-blocks.mjs used to fetch main on every run. main moves, so the generated output changed
 * with *when* it was run, and nothing recorded which point in time of Bedrock the catalogue
 * assumed. This pins a commit for the fetch and keeps the record in SOURCE.json.
 *
 * The fetched upstream files themselves are not committed
 * (`(c) Mojang AB. All rights reserved.`). See the head of bedrock-snapshot.mjs.
 *
 * **Only a call that names a commit** may write the record (SOURCE.json). A fetch with no
 * arguments is the operation "restore exactly what the record says", so it is given no
 * authority to rewrite it. On a disagreement it stops instead of overwriting silently
 * (overwriting would hide the fact that the record broke).
 *
 * There are two reasons the record changes, and each is a deliberate, distinct operation:
 *   - bumping the upstream version → --update (resolves the HEAD of main)
 *   - adding to or removing from the fetch set (SNAPSHOT_FILES) / returning to a specific
 *     commit → --commit <sha>. The upstream version stays put while only the record changes,
 *     so it has its own entrance (with --update, adding one file would move the upstream
 *     version too)
 *
 * Usage:
 *   node scripts/fetch-bedrock-snapshot.mjs                # refetch at the commit in SOURCE.json (reproduce; writes no record)
 *   node scripts/fetch-bedrock-snapshot.mjs --update        # update to the latest upstream main (a deliberate version bump)
 *   node scripts/fetch-bedrock-snapshot.mjs --commit <sha>  # refetch at a fixed commit and write the record too
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SNAPSHOT_DIR,
  SNAPSHOT_FILES,
  SOURCE_PATH,
  UPSTREAM_REPO,
  buildSource,
  formatSource,
  rawUrl,
  readSource,
  sha256,
} from './bedrock-snapshot.mjs';

const wantUpdate = process.argv.includes('--update');
const pinnedCommit = parsePinnedCommit(process.argv);

/**
 * Reads `--commit <sha>` / `--commit=<sha>`. Only a full 40-digit SHA is accepted — allowing an
 * abbreviation would put a short value into the record, which could later match a different
 * commit.
 */
function parsePinnedCommit(argv) {
  const at = argv.findIndex((a) => a === '--commit' || a.startsWith('--commit='));
  if (at === -1) return null;
  const raw = argv[at].startsWith('--commit=') ? argv[at].slice('--commit='.length) : argv[at + 1];
  if (!raw || !/^[0-9a-f]{40}$/.test(raw)) {
    throw new Error(`--commit takes a 40-digit commit SHA (received: ${JSON.stringify(raw ?? null)})`);
  }
  return raw;
}

if (wantUpdate && pinnedCommit) {
  throw new Error('--update and --commit cannot be given together (it would be undecided whether to bump the upstream version or hold it)');
}

/** Resolves the HEAD of upstream main. Uses ls-remote rather than the GitHub API (no auth, no rate limit) */
function resolveMainCommit() {
  const out = execFileSync('git', ['ls-remote', UPSTREAM_REPO, 'refs/heads/main'], {
    encoding: 'utf-8',
  });
  const sha = out.split(String.fromCharCode(9))[0]?.trim();
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`could not resolve the commit of main: ${JSON.stringify(out)}`);
  }
  return sha;
}

const previous = readSource();

/** Whether the record may be rewritten. Only a call that names a commit has the authority */
const mayWriteSource = wantUpdate || pinnedCommit !== null;

let commit;
if (pinnedCommit) {
  commit = pinnedCommit;
  if (previous && previous.commit !== commit) {
    console.log(`fetching at the named commit: ${previous.commit.slice(0, 8)} → ${commit.slice(0, 8)}`);
  } else {
    console.log(`fetching at the named commit: ${commit.slice(0, 8)} (the upstream version stays put)`);
  }
} else if (wantUpdate) {
  commit = resolveMainCommit();
  if (previous && previous.commit === commit) {
    console.log(`upstream main is unchanged (${commit.slice(0, 8)})`);
  } else if (previous) {
    console.log(`updating upstream main: ${previous.commit.slice(0, 8)} → ${commit.slice(0, 8)}`);
  } else {
    console.log(`first fetch of upstream main: ${commit.slice(0, 8)}`);
  }
} else {
  if (!previous) {
    throw new Error(
      [
        'data/bedrock/SOURCE.json is missing (the first run has to decide a commit).',
        '  node scripts/fetch-bedrock-snapshot.mjs --update',
        'fetches from upstream main.',
      ].join(String.fromCharCode(10)),
    );
  }
  commit = previous.commit;
  console.log(`fetching at the recorded commit: ${commit.slice(0, 8)}`);
}

mkdirSync(SNAPSHOT_DIR, { recursive: true });

/** @type {Record<string, { path: string, bytes: number, sha256: string }>} */
const files = {};

for (const [name, path] of Object.entries(SNAPSHOT_FILES)) {
  const url = rawUrl(commit, path);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());

  // Reject an empty or unreasonably small response. raw returns 404 for a path that does not
  // exist, but this stops the case where the transport hiccups and the body is truncated with
  // a 200, before anything is written
  if (buf.length < 1024) {
    throw new Error(`the response is too small (${buf.length} bytes): ${url}`);
  }

  writeFileSync(join(SNAPSHOT_DIR, name), buf);
  files[name] = { path, bytes: buf.length, sha256: sha256(buf) };
  console.log(`  ${name} (${buf.length} bytes)`);
}

const next = formatSource(buildSource({ commit, files }));

if (!mayWriteSource) {
  // An ordinary fetch is a restore. On a disagreement with the record it stops instead of overwriting
  const current = existsSync(SOURCE_PATH) ? readFileSync(SOURCE_PATH, 'utf-8') : null;
  if (current !== next) {
    throw new Error(
      [
        'what was fetched does not match the record in data/bedrock/SOURCE.json.',
        `recorded commit: ${commit}`,
        'either the same commit is returning different contents, or the record is broken.',
        'If you changed the fetch set (SNAPSHOT_FILES), rewrite the record with --commit <sha>.',
        'If you meant to bump the version, pass --update.',
      ].join(String.fromCharCode(10)),
    );
  }
  console.log('matched the record in data/bedrock/SOURCE.json (the record is unchanged)');
} else {
  const current = existsSync(SOURCE_PATH) ? readFileSync(SOURCE_PATH, 'utf-8') : null;
  if (current === next) {
    console.log('data/bedrock/SOURCE.json is unchanged (the upstream state is the same)');
  } else {
    writeFileSync(SOURCE_PATH, next);
    console.log('updated data/bedrock/SOURCE.json');
  }
}

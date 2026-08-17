// Guards the rules in CLAUDE.md that a machine can decide (#155).
//
// The three rules are "write with the owner's account", "write in English", and "do not write
// personal names". Prose alone cannot hold them — a session that never reads CLAUDE.md still
// gets to push — so each one is checked here and wired into CI.
//
// Split of responsibility with `architecture-lint.mjs`:
//   - architecture-lint owns *source* language policy: Japanese in comments (checkCommentLanguage)
//     and Japanese display literals inside src/ (checkDisplayLiterals)
//   - this module owns *repository* policy: prose files, the whole tracked set, and the commits
//
// The two do not overlap. Comments are not re-scanned here, and this module never looks inside
// src/ for literals.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');

// Mirrors the range used by architecture-lint.mjs so the two guards agree on what "Japanese" is.
const JAPANESE = /[぀-ゟ゠-ヿ一-鿿]/;

// The account every commit is written with. This one is public by construction — it is the
// owner segment of the repository URL and the copyright line in LICENSE — so it is spelled out
// rather than hashed.
export const OWNER_NAME = 'martin-ushiyama';
export const OWNER_EMAIL = '202099411+martin-ushiyama@users.noreply.github.com';

/**
 * The forbidden words, as SHA-256 of the lowercased token (first 16 hex characters).
 *
 * **Storing them hashed is the point, not a flourish.** A blocklist of personal names, written
 * out in a tracked file, publishes the very names the rule exists to keep out of this
 * repository. Hashing lets CI reject them without disclosing them.
 *
 * The consequence is that matching is per whole Latin token — no substrings, no fuzzy forms.
 * That is enough here because the other half of the policy already covers the rest: Japanese is
 * rejected in every place a person writes prose, so a name in kana cannot reach a comment, a
 * document, or a commit message either.
 *
 * This is a hygiene guard, not a secret store. Short words are cheap to brute-force, and the
 * design does not pretend otherwise — the goal is to avoid *printing* the list, not to make it
 * unrecoverable.
 *
 * To add one: `node scripts/public-repo-lint.mjs --hash <word>` and paste the line it prints.
 */
const FORBIDDEN_TOKEN_HASHES = new Set([
  'b6f8d434a847fb0f', // the owner's given name on its own (the full handle is allowed)
  '19fccce0c35373db', // the owner's family name on its own
  'b9f633dc43572056',
  'e2b1b60b481aa493',
]);

/**
 * The co-author trailer. Unlike a name this is a git convention rather than a personal detail,
 * so it is matched literally.
 *
 * Rejected because a trailer is how another identity gets recorded into a commit that the author
 * field says belongs to one account — the "one account" rule would otherwise hold only on the
 * surface.
 */
const COAUTHOR_TRAILER = /^[ \t]*co-authored-by[ \t]*:/im;

const TOKEN = /[A-Za-z][A-Za-z0-9]*/g;

// Separators for `git log --format`. Chosen because neither can occur inside a commit message.
const FIELD_SEP = '\u0000';
const RECORD_END = '\u001e';

function hashToken(token) {
  return createHash('sha256').update(token.toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * The forbidden tokens in `text`, deduplicated, each reported with the line it sits on.
 *
 * The owner handle is removed before tokenizing. Splitting `martin-ushiyama` on the hyphen
 * yields both halves, and each half on its own is forbidden, so leaving the handle in would make
 * LICENSE and every repository URL fail. Removing it first keeps "the handle is fine, either
 * half alone is not" decidable.
 * @param {string} text
 * @returns {{ line: number, hash: string }[]}
 */
function forbiddenTokens(text) {
  const hits = [];
  const seen = new Set();
  const lines = text.split(/\r?\n/);
  // Replaced with a space rather than deleted: dropping it would splice the surrounding
  // characters together and could manufacture a token that is not in the file.
  const handle = new RegExp(OWNER_NAME.replace(/-/g, '[-]'), 'gi');
  lines.forEach((raw, i) => {
    const line = raw.replace(handle, ' ');
    for (const match of line.matchAll(TOKEN)) {
      const hash = hashToken(match[0]);
      if (!FORBIDDEN_TOKEN_HASHES.has(hash) || seen.has(hash)) continue;
      seen.add(hash);
      hits.push({ line: i + 1, hash });
    }
  });
  return hits;
}

function trackedFiles(repoRoot) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
}

/**
 * Reads a tracked file as text, or returns null when it is binary or unreadable.
 *
 * A NUL byte is the test for binary. Decoding a PNG as UTF-8 and running regular expressions
 * over the result produces matches that mean nothing.
 */
function readText(repoRoot, rel) {
  let buf;
  try {
    buf = readFileSync(join(repoRoot, rel));
  } catch {
    return null;
  }
  if (buf.includes(0)) return null;
  return buf.toString('utf8');
}

/**
 * Rejects Japanese in prose files (#155 rule 2).
 *
 * The rule is "write everything in English", but taken as "no Japanese character anywhere in a
 * tracked file" it would delete the product: this app ships a Japanese UI, so the locale
 * dictionary (`src/core/i18n.ts`), the block names (`src/data/blocks.json`), the bilingual
 * control guide (`src/ui/help.ts`) and the tests that assert on Japanese labels all hold
 * Japanese *as data*. What the rule is actually about is what a person writes: comments and
 * documents.
 *
 * So the policy is split by where the text lives, not by path:
 *   - comments — architecture-lint's `checkCommentLanguage`, over every tracked file
 *   - documents — here
 *   - string literals and JSON data — allowed, because that is where the shipped UI lives
 *
 * A document may be written in Japanese when its name says so: `*.ja.md`. That is a naming
 * convention rather than a list of exempt paths, so it does not grow one exception at a time.
 * @param {string} [repoRoot]
 * @param {readonly string[] | null} [relPaths] the files to check (defaults to every tracked file)
 * @returns {string[]} the violation messages (empty when there are none)
 */
export function checkProseLanguage(repoRoot = REPO_ROOT, relPaths = null) {
  const violations = [];
  for (const rel of relPaths ?? trackedFiles(repoRoot)) {
    if (!rel.endsWith('.md')) continue;
    if (rel.endsWith('.ja.md')) continue;
    const text = readText(repoRoot, rel);
    if (text === null) continue;
    text.split(/\r?\n/).forEach((line, i) => {
      if (!JAPANESE.test(line)) return;
      violations.push(`${rel}:${i + 1}: Japanese in a document — write it in English, or put it in a *.ja.md file "${line.trim().slice(0, 40)}"`);
    });
  }
  return violations;
}

/**
 * Rejects personal names and co-author trailers in tracked files (#155 rule 3).
 *
 * Every tracked text file is read, including generated ones. A name reaches a public repository
 * the same way whether a person typed it or a generator emitted it, and exempting the generated
 * files would leave the larger surface unchecked.
 * @param {string} [repoRoot]
 * @param {readonly string[] | null} [relPaths] the files to check (defaults to every tracked file)
 * @returns {string[]} the violation messages (empty when there are none)
 */
export function checkForbiddenWords(repoRoot = REPO_ROOT, relPaths = null) {
  const violations = [];
  for (const rel of relPaths ?? trackedFiles(repoRoot)) {
    const text = readText(repoRoot, rel);
    if (text === null) continue;
    for (const hit of forbiddenTokens(text)) {
      violations.push(`${rel}:${hit.line}: a forbidden word (hash ${hit.hash}) — personal names do not go in this repository`);
    }
    const trailer = text.split(/\r?\n/).findIndex((line) => COAUTHOR_TRAILER.test(line));
    if (trailer >= 0) {
      violations.push(`${rel}:${trailer + 1}: a co-author trailer — every commit here is written with a single account`);
    }
  }
  return violations;
}

/**
 * The commits in `range`, as `{ sha, authorName, authorEmail, subject, body }`.
 *
 * NUL separates the fields and a record separator ends each commit, because a commit message may
 * contain any newline arrangement it likes and splitting on lines would lose the boundary.
 */
function commitsIn(repoRoot, range) {
  // git's own %x00 / %x1e placeholders, not literal control characters in this string. argv is
  // NUL terminated, so a real NUL put into the format would truncate the argument git receives —
  // the log would come back with the fields silently missing rather than with an error.
  const raw = execFileSync('git', ['log', '--format=%H%x00%an%x00%ae%x00%B%x1e', range], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return raw
    .split(RECORD_END)
    .map((chunk) => chunk.replace(/^\r?\n/, ''))
    .filter((chunk) => chunk.trim() !== '')
    .map((chunk) => {
      const [sha, authorName, authorEmail, message] = chunk.split(FIELD_SEP);
      return { sha, authorName, authorEmail, message: message ?? '' };
    });
}

/**
 * Rejects commits whose author is not the owner's account (#155 rule 1).
 *
 * **The author is checked; the committer is not.** Merging through the GitHub web UI records
 * `GitHub <noreply@github.com>` as the committer, so requiring the owner there would fail every
 * merge for a reason that has nothing to do with who wrote the change. The author field is the
 * one that says whose work this is, and it is the one the rule is about.
 * @param {string} repoRoot
 * @param {string} range a git revision range, e.g. `base..head`
 * @returns {string[]} the violation messages (empty when there are none)
 */
export function checkCommitAuthors(repoRoot, range) {
  const violations = [];
  for (const commit of commitsIn(repoRoot, range)) {
    if (commit.authorName === OWNER_NAME && commit.authorEmail === OWNER_EMAIL) continue;
    violations.push(
      `${commit.sha.slice(0, 8)}: the author is ${commit.authorName} <${commit.authorEmail}> — commits here are written with ${OWNER_NAME}`,
    );
  }
  return violations;
}

/**
 * Rejects Japanese and forbidden words in commit messages (#155 rules 2 and 3).
 *
 * A commit message is prose a person wrote, and it is as public as the files — it shows on the
 * commit list, in blame, and in the release notes. Checking only the working tree would leave
 * the whole history unguarded.
 * @param {string} repoRoot
 * @param {string} range a git revision range, e.g. `base..head`
 * @returns {string[]} the violation messages (empty when there are none)
 */
export function checkCommitMessages(repoRoot, range) {
  const violations = [];
  for (const commit of commitsIn(repoRoot, range)) {
    const short = commit.sha.slice(0, 8);
    const firstJapanese = commit.message.split(/\r?\n/).find((line) => JAPANESE.test(line));
    if (firstJapanese !== undefined) {
      violations.push(`${short}: a Japanese commit message — write it in English "${firstJapanese.trim().slice(0, 40)}"`);
    }
    for (const hit of forbiddenTokens(commit.message)) {
      violations.push(`${short}: a forbidden word in the commit message (hash ${hit.hash})`);
    }
    if (COAUTHOR_TRAILER.test(commit.message)) {
      violations.push(`${short}: a co-author trailer — every commit here is written with a single account`);
    }
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);

  const hashAt = args.indexOf('--hash');
  if (hashAt >= 0) {
    const word = args[hashAt + 1];
    if (!word) {
      console.error('usage: node scripts/public-repo-lint.mjs --hash <word>');
      process.exit(2);
    }
    console.log(`  '${hashToken(word)}',`);
    process.exit(0);
  }

  const commitsAt = args.indexOf('--commits');
  const range = commitsAt >= 0 ? args[commitsAt + 1] : null;
  if (commitsAt >= 0 && !range) {
    console.error('usage: node scripts/public-repo-lint.mjs [--commits <range>]');
    process.exit(2);
  }

  const violations = [
    ...checkProseLanguage(),
    ...checkForbiddenWords(),
    ...(range ? checkCommitAuthors(REPO_ROOT, range) : []),
    ...(range ? checkCommitMessages(REPO_ROOT, range) : []),
  ];
  if (violations.length > 0) {
    console.error('public-repo-lint: violations found\n');
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`public-repo-lint: OK${range ? ` (files and commits in ${range})` : ' (files; pass --commits <range> to check commits too)'}`);
}

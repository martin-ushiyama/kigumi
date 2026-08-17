// Guards the rules in CLAUDE.md that a machine can decide.
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
// Over the working tree the two do not overlap: comments are not re-scanned here, and this
// module never looks inside src/ for literals. Over history they combine — `checkCommitContents`
// runs both, so what a commit added is held to exactly the rules the working tree is held to.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkCommentLanguage } from './architecture-lint.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..');

// The same class architecture-lint.mjs uses, so the two guards agree on what "Japanese" is.
const JAPANESE = /[〆\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

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

// Source, markup, config and data. Japanese inside these is either a comment — which
// architecture-lint's checkCommentLanguage owns — or a string literal holding the shipped UI,
// which is allowed. Everything else tracked counts as prose.
const NON_PROSE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.json',
  '.css',
  '.html',
  '.svg',
  '.yml',
  '.yaml',
]);
const NON_PROSE_NAMES = new Set(['.gitignore', '.gitattributes', '.nvmrc']);

/** Whether this tracked path is a document, i.e. a file whose whole content is writing. */
function isProse(rel) {
  const base = rel.split('/').pop() ?? rel;
  // The `.ja.` marker declares the document's language, on any name rather than on `.md` alone.
  if (base.includes('.ja.')) return false;
  if (NON_PROSE_NAMES.has(base)) return false;
  const dot = base.lastIndexOf('.');
  return dot <= 0 || !NON_PROSE_EXTENSIONS.has(base.slice(dot));
}

function trackedFiles(repoRoot) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
}

/**
 * Reads a tracked file as text, or returns null when it is binary or unreadable.
 *
 * A NUL byte is the test for binary. Decoding a PNG as UTF-8 and running regular expressions
 * over the result produces matches that mean nothing. UTF-16 is decoded from its byte order mark
 * first, because ordinary UTF-16 text is full of NUL bytes and would otherwise look binary and be
 * skipped without a word.
 *
 * **A symlink is read as its own content — the path it points at — not as its target's.** What
 * git tracks for a symlink is the link text, and that is what would be published. Following it
 * instead would check something outside the repository and skip a dangling link silently, so a
 * link whose path spelled out a name would pass.
 */
function readText(repoRoot, rel) {
  const full = join(repoRoot, rel);
  try {
    if (lstatSync(full).isSymbolicLink()) return readlinkSync(full);
  } catch {
    return null;
  }
  let buf;
  try {
    buf = readFileSync(full);
  } catch {
    return null;
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return buf.subarray(2).swap16().toString('utf16le');
  if (buf.includes(0)) return null;
  return buf.toString('utf8');
}

/**
 * Rejects Japanese in prose files (CLAUDE.md rule 2).
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
 * A document may be written in Japanese when its name says so — `README.ja.md`, and the same
 * `.ja.` marker on any other name. That is a naming convention rather than a list of exempt
 * paths, so it does not grow one exception at a time.
 *
 * **"Prose" is decided by exclusion, not by an inventory of document names.** Anything tracked
 * that is not source, markup, config or data is prose — `LICENSE` has no extension and would be
 * skipped by a list of suffixes, while no list of document names stays complete as the
 * repository grows. Excluding the code and data extensions is the bounded side of the split,
 * because those are the files the comment guard and the display-literal guard already own.
 * @param {string} [repoRoot]
 * @param {readonly string[] | null} [relPaths] the files to check (defaults to every tracked file)
 * @returns {string[]} the violation messages (empty when there are none)
 */
export function checkProseLanguage(repoRoot = REPO_ROOT, relPaths = null) {
  const violations = [];
  for (const rel of relPaths ?? trackedFiles(repoRoot)) {
    if (!isProse(rel)) continue;
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
 * Rejects personal names and co-author trailers in tracked files (CLAUDE.md rule 3).
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
    // The path itself is published, in the file listing and in every link to the file. A name
    // put there rather than in the contents would otherwise be the one place nothing looks.
    for (const hit of forbiddenTokens(rel)) {
      violations.push(`${rel}: a forbidden word in the path (hash ${hit.hash}) — personal names do not go in this repository`);
    }
    if (JAPANESE.test(rel)) {
      violations.push(`${rel}: Japanese in the path — file and directory names are written in English`);
    }

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
 * Rejects commits whose author is not the owner's account (CLAUDE.md rule 1).
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
 * Rejects violations anywhere in the range, not only in the tree it ends at.
 *
 * A name added in one commit and taken out again in a later one leaves the final tree clean while
 * the content stays in the branch history, which is as public as the files are once the branch is
 * pushed. So each commit is inspected as it stood.
 *
 * **The patch text is not parsed.** Deciding what a line of a diff means — a header, a hunk, a
 * line of content that happens to start the same way — is guesswork that keeps producing new
 * wrong answers, and git escapes non-ASCII paths in that output as well. Instead the files each
 * commit touched are listed with NUL separators, their blobs at that commit are written to a
 * scratch directory, and the very same guards that run over the working tree run over it. There
 * is one definition of a violation, and history is held to it.
 * @param {string} repoRoot
 * @param {string} range a git revision range, e.g. `base..head`
 * @returns {string[]} the violation messages (empty when there are none)
 */
export function checkCommitContents(repoRoot, range) {
  const shas = execFileSync('git', ['rev-list', range], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const violations = [];
  for (const sha of shas) {
    // `-m` and `--root` are both load-bearing. Without `-m` a merge prints nothing at all, so a
    // conflict resolution that introduced something would be skipped in silence; without
    // `--root` the first commit of a repository prints nothing either, for want of a parent to
    // compare against. `-m` lists a merge once per parent, hence the deduplication.
    const paths = [
      ...new Set(
        execFileSync('git', ['diff-tree', '-r', '--no-commit-id', '--name-only', '-z', '-m', '--root', sha], {
          cwd: repoRoot,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        })
          .split('\0')
          .filter(Boolean),
      ),
    ];
    if (paths.length === 0) continue;

    const short = sha.slice(0, 8);
    const dir = mkdtempSync(join(tmpdir(), 'public-repo-lint-'));
    try {
      // The path of an entry that has no readable blob still has to be checked. A submodule is a
      // commit object rather than a blob, and a name that cannot be written to this filesystem
      // has no file either, yet both publish their path.
      const checkPathOnly = (rel) => {
        for (const hit of forbiddenTokens(rel)) {
          violations.push(`${short}: a forbidden word in the path ${rel} (hash ${hit.hash})`);
        }
        if (JAPANESE.test(rel)) violations.push(`${short}: Japanese in the path ${rel}`);
      };

      const present = [];
      for (const rel of paths) {
        let type;
        try {
          type = execFileSync('git', ['cat-file', '-t', `${sha}:${rel}`], { cwd: repoRoot, encoding: 'utf8' }).trim();
        } catch {
          // Not in this commit's tree — the commit deleted it. Whatever it held was read at the
          // commit that introduced it, and a change that removes something is not at fault for it.
          continue;
        }
        if (type !== 'blob') {
          checkPathOnly(rel);
          continue;
        }
        const blob = execFileSync('git', ['cat-file', 'blob', `${sha}:${rel}`], {
          cwd: repoRoot,
          encoding: 'buffer',
          maxBuffer: 256 * 1024 * 1024,
        });
        const full = join(dir, rel);
        try {
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, blob);
        } catch {
          // A name git accepts but this filesystem does not. The path is still checked, and the
          // contents are reported as unread rather than passed over in silence.
          checkPathOnly(rel);
          violations.push(`${short}: the contents of ${rel} could not be read for inspection`);
          continue;
        }
        present.push(rel);
      }
      if (present.length === 0) continue;
      for (const violation of [
        ...checkProseLanguage(dir, present),
        ...checkForbiddenWords(dir, present),
        ...checkCommentLanguage(dir, present),
      ]) {
        violations.push(`${short}: ${violation}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return violations;
}

/**
 * Rejects Japanese and forbidden words in commit messages (CLAUDE.md rules 2 and 3).
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
    violations.push(...checkText(`${commit.sha.slice(0, 8)}: the commit message`, commit.message));
  }
  return violations;
}

/**
 * Rejects Japanese, personal names and co-author trailers in a piece of writing that is not a
 * file — a commit message, or the title and body of a pull request.
 *
 * Pull request text needs this as much as the files do. It is public the moment
 * it is opened, and on a squash merge the title becomes the commit subject, so leaving it out
 * would let the rule be broken in the one place that later ends up in the history.
 * @param {string} label how to name this text in a violation message
 * @param {string} text
 * @returns {string[]} the violation messages (empty when there are none)
 */
export function checkText(label, text) {
  const violations = [];
  const firstJapanese = text.split(/\r?\n/).find((line) => JAPANESE.test(line));
  if (firstJapanese !== undefined) {
    violations.push(`${label}: Japanese — write it in English "${firstJapanese.trim().slice(0, 40)}"`);
  }
  for (const hit of forbiddenTokens(text)) {
    violations.push(`${label}: a forbidden word (hash ${hit.hash}) — personal names do not go in this repository`);
  }
  if (COAUTHOR_TRAILER.test(text)) {
    violations.push(`${label}: a co-author trailer — every commit here is written with a single account`);
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

  const USAGE = 'usage: node scripts/public-repo-lint.mjs [--commits <range>] [--text-file <path> [--label <label>]]';

  const valueOf = (flag) => {
    const at = args.indexOf(flag);
    if (at < 0) return null;
    const value = args[at + 1];
    if (!value || value.startsWith('--')) {
      console.error(USAGE);
      process.exit(2);
    }
    return value;
  };

  const range = valueOf('--commits');
  const textFile = valueOf('--text-file');
  const label = valueOf('--label') ?? 'the text';

  // `--text-file` checks that piece of writing on its own. Reading it from a file rather than an
  // argument is deliberate: pull request text is arbitrary, multi-line, and attacker-influenced,
  // and putting it on a command line invites the shell to interpret it.
  const checked = [];
  const violations = [];
  if (!textFile) {
    checked.push('files');
    violations.push(...checkProseLanguage(), ...checkForbiddenWords());
  }
  if (range) {
    checked.push(`commits in ${range}`);
    violations.push(
      ...checkCommitAuthors(REPO_ROOT, range),
      ...checkCommitMessages(REPO_ROOT, range),
      ...checkCommitContents(REPO_ROOT, range),
    );
  }
  if (textFile) {
    checked.push(label);
    violations.push(...checkText(label, readFileSync(textFile, 'utf8')));
  }

  if (violations.length > 0) {
    console.error('public-repo-lint: violations found\n');
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`public-repo-lint: OK (${checked.join(', ')})`);
}

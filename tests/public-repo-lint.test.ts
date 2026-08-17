import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkCommitAuthors,
  checkCommitContents,
  checkCommitMessages,
  checkForbiddenWords,
  checkProseLanguage,
  checkText,
  OWNER_EMAIL,
  OWNER_NAME,
  REPO_ROOT,
} from '../scripts/public-repo-lint.mjs';
import { checkCommentLanguage } from '../scripts/architecture-lint.mjs';

// The forbidden words are stored hashed on purpose (see the module), so the fixtures cannot
// spell one out — a fixture in a tracked file would put the name into this repository, which is
// the thing the guard exists to prevent. `OWNER_NAME` is the one forbidden token that is public
// anyway, so each half of it stands in for "a personal name" in these tests.
const [GIVEN_NAME = '', FAMILY_NAME = ''] = OWNER_NAME.split('-');

const scratches: string[] = [];

function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'public-repo-lint-'));
  scratches.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', OWNER_NAME);
  git('config', 'user.email', OWNER_EMAIL);
  git('config', 'commit.gpgsign', 'false');
  return dir;
}

function commit(dir: string, message: string, opts: { author?: string } = {}): void {
  const args = ['commit', '-q', '--allow-empty', '-m', message];
  if (opts.author) args.push(`--author=${opts.author}`);
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('public-repo-lint — this repository satisfies the rules in CLAUDE.md', () => {
  it('checkProseLanguage: zero violations across the tracked documents', () => {
    expect(checkProseLanguage()).toEqual([]);
  });

  it('checkForbiddenWords: zero violations across the tracked files', () => {
    expect(checkForbiddenWords()).toEqual([]);
  });
});

describe('checkProseLanguage', () => {
  it('rejects Japanese in a document, reporting the line it is on', () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, 'guide.md'), '# Guide\n\nEnglish line.\nこれは日本語です。\n', 'utf8');
    const violations = checkProseLanguage(dir, ['guide.md']);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('guide.md:4');
  });

  it('allows Japanese in a *.ja.md document', () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, 'README.ja.md'), '# 見出し\n\n日本語の本文。\n', 'utf8');
    expect(checkProseLanguage(dir, ['README.ja.md'])).toEqual([]);
  });

  it('leaves source and data files to the comment guard — Japanese in a literal is allowed', () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, 'strings.ts'), "export const label = 'ブロック';\n", 'utf8');
    writeFileSync(join(dir, 'data.json'), '{ "nameJa": "石" }\n', 'utf8');
    expect(checkProseLanguage(dir, ['strings.ts', 'data.json'])).toEqual([]);
  });

  it('exempts the marker, not the letters — a file simply named ja.md is still checked', () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, 'ja.md'), '日本語\n', 'utf8');
    expect(checkProseLanguage(dir, ['ja.md'])).toHaveLength(1);
  });

  it('checks a document with no extension, such as LICENSE', () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, 'LICENSE'), 'MIT License\n\n日本語の一文。\n', 'utf8');
    expect(checkProseLanguage(dir, ['LICENSE'])).toHaveLength(1);
  });

  it('honours the .ja. marker on names other than .md', () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, 'NOTES.ja.txt'), '日本語のメモ。\n', 'utf8');
    expect(checkProseLanguage(dir, ['NOTES.ja.txt'])).toEqual([]);
  });

  it('leaves the files the comment guard owns alone, even outside src', () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, 'config.yml'), "name: 'ブロック'\n", 'utf8');
    writeFileSync(join(dir, '.gitignore'), 'dist\n', 'utf8');
    expect(checkProseLanguage(dir, ['config.yml', '.gitignore'])).toEqual([]);
  });
});

describe('checkForbiddenWords', () => {
  it('rejects a personal name in any tracked file, not just documents', () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, 'app.ts'), `// written by ${GIVEN_NAME}\nexport const x = 1;\n`, 'utf8');
    const violations = checkForbiddenWords(dir, ['app.ts']);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('app.ts:1');
    // The message must not print the word back out, or the guard would leak what it protects.
    expect(String(violations[0]).toLowerCase()).not.toContain(GIVEN_NAME.toLowerCase());
  });

  it('allows the full owner handle while still rejecting either half on its own', () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, 'LICENSE'), `Copyright (c) 2026 ${OWNER_NAME}\n`, 'utf8');
    expect(checkForbiddenWords(dir, ['LICENSE'])).toEqual([]);

    writeFileSync(join(dir, 'CREDITS'), `Thanks to ${FAMILY_NAME}.\n`, 'utf8');
    expect(checkForbiddenWords(dir, ['CREDITS'])).toHaveLength(1);
  });

  it('matches whole tokens only — a longer word that contains one is not a hit', () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, 'words.txt'), `${GIVEN_NAME}gale ${GIVEN_NAME}s x${GIVEN_NAME}\n`, 'utf8');
    expect(checkForbiddenWords(dir, ['words.txt'])).toEqual([]);
  });

  it('rejects a co-author trailer wherever it appears', () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, 'NOTES'), 'a line\nCo-Authored-By: someone <a@b.c>\n', 'utf8');
    const violations = checkForbiddenWords(dir, ['NOTES']);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('NOTES:2');
  });

  // Creating a symbolic link needs elevation on Windows, so the assertion runs where it can and
  // the case is skipped where it cannot. CI is Linux, so the path is covered there.
  it('reads a symlink as its own link text rather than following it to the target', () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, 'target.txt'), 'clean english text\n', 'utf8');
    try {
      symlinkSync(`${GIVEN_NAME}-notes.txt`, join(dir, 'link.txt'));
    } catch {
      return; // no permission to make one here
    }
    // The link text carries the name; the target it points at does not.
    expect(checkForbiddenWords(dir, ['link.txt'])).toHaveLength(1);
    expect(checkForbiddenWords(dir, ['target.txt'])).toEqual([]);
  });

  it('rejects a name that appears only in the path, with clean contents', () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, 'notes.txt'), 'clean english text\n', 'utf8');
    const violations = checkForbiddenWords(dir, [`docs/${GIVEN_NAME}-notes.txt`]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('in the path');
  });

  it('rejects Japanese in a path', () => {
    const dir = scratchRepo();
    const violations = checkForbiddenWords(dir, ['docs/日本語.txt']);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('Japanese in the path');
  });

  it('skips binary files instead of matching bytes decoded as text', () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]));
    expect(checkForbiddenWords(dir, ['blob.bin'])).toEqual([]);
  });

  it('reads UTF-16 text rather than mistaking its NUL bytes for a binary file', () => {
    const dir = scratchRepo();
    const text = `Reviewed by ${GIVEN_NAME}.\n`;
    writeFileSync(join(dir, 'le.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
    writeFileSync(
      join(dir, 'be.txt'),
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]),
    );
    expect(checkForbiddenWords(dir, ['le.txt'])).toHaveLength(1);
    expect(checkForbiddenWords(dir, ['be.txt'])).toHaveLength(1);
  });
});

describe('checkCommitAuthors', () => {
  it('passes when every commit in the range is authored by the owner', () => {
    const dir = scratchRepo();
    commit(dir, 'initial');
    commit(dir, 'second');
    expect(checkCommitAuthors(dir, 'HEAD~1..HEAD')).toEqual([]);
  });

  it('rejects a commit authored by anyone else', () => {
    const dir = scratchRepo();
    commit(dir, 'initial');
    commit(dir, 'second', { author: 'Someone Else <else@example.com>' });
    const violations = checkCommitAuthors(dir, 'HEAD~1..HEAD');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('else@example.com');
  });

  it('rejects the right name paired with a different address', () => {
    const dir = scratchRepo();
    commit(dir, 'initial');
    commit(dir, 'second', { author: `${OWNER_NAME} <someone@example.com>` });
    expect(checkCommitAuthors(dir, 'HEAD~1..HEAD')).toHaveLength(1);
  });
});

describe('checkCommitContents', () => {
  function track(dir: string, rel: string, body: string): void {
    writeFileSync(join(dir, rel), body, 'utf8');
    execFileSync('git', ['add', rel], { cwd: dir, encoding: 'utf8' });
  }

  it('passes a range that adds only English, name-free content', () => {
    const dir = scratchRepo();
    commit(dir, 'initial');
    track(dir, 'guide.md', '# Guide\n\nAll English.\n');
    commit(dir, 'docs: add a guide');
    expect(checkCommitContents(dir, 'HEAD~1..HEAD')).toEqual([]);
  });

  it('rejects content added in one commit and removed in a later one', () => {
    const dir = scratchRepo();
    commit(dir, 'initial');
    track(dir, 'notes.md', `Reviewed by ${GIVEN_NAME}.\n`);
    commit(dir, 'docs: add notes');
    track(dir, 'notes.md', 'Reviewed internally.\n');
    commit(dir, 'docs: take the name out again');

    // The final tree is clean, so the working-tree guard sees nothing wrong.
    expect(checkForbiddenWords(dir, ['notes.md'])).toEqual([]);
    // The history is not, and that is what stays public.
    const violations = checkCommitContents(dir, 'HEAD~2..HEAD');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('notes.md');
  });

  it('rejects Japanese added to a document, and allows it in a source literal', () => {
    const dir = scratchRepo();
    commit(dir, 'initial');
    track(dir, 'guide.md', '日本語\n');
    track(dir, 'labels.ts', "export const label = 'ブロック';\n");
    commit(dir, 'add both');
    const violations = checkCommitContents(dir, 'HEAD~1..HEAD');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('guide.md');
  });

  it('rejects a name in a path that a later commit renames away', () => {
    const dir = scratchRepo();
    commit(dir, 'initial');
    track(dir, `${GIVEN_NAME}-notes.md`, 'All English.\n');
    commit(dir, 'docs: add notes');
    const violations = checkCommitContents(dir, 'HEAD~1..HEAD');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('in the path');
  });

  it('rejects a Japanese comment that history keeps, even in a source file', () => {
    const dir = scratchRepo();
    commit(dir, 'initial');
    track(dir, 'labels.ts', "// 日本語のコメント\nexport const label = 'ブロック';\n");
    commit(dir, 'add labels');
    track(dir, 'labels.ts', "// an English comment\nexport const label = 'ブロック';\n");
    commit(dir, 'translate the comment');

    // The final tree passes both working-tree guards; the history does not.
    expect(checkProseLanguage(dir, ['labels.ts'])).toEqual([]);
    expect(checkCommitContents(dir, 'HEAD~2..HEAD')).toHaveLength(1);
  });

  it('handles a path git would escape in patch output', () => {
    const dir = scratchRepo();
    commit(dir, 'initial');
    track(dir, '日本語.md', 'All English inside.\n');
    commit(dir, 'add a file');
    const violations = checkCommitContents(dir, 'HEAD~1..HEAD');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('Japanese in the path');
  });

  it('inspects a merge commit, where the plain diff of a merge shows nothing', () => {
    const dir = scratchRepo();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    track(dir, 'base.md', 'Base.\n');
    commit(dir, 'initial');
    git('checkout', '-q', '-b', 'side');
    track(dir, 'side.md', 'Side.\n');
    commit(dir, 'docs: side');
    git('checkout', '-q', 'main');
    track(dir, 'main.md', 'Main.\n');
    commit(dir, 'docs: main');
    git('merge', '-q', '--no-ff', 'side', '-m', 'merge side');
    // The merge resolution itself introduces the name, and nothing after it does.
    track(dir, 'main.md', `Main, reviewed by ${GIVEN_NAME}.\n`);
    execFileSync('git', ['commit', '-q', '--amend', '--no-edit'], { cwd: dir, encoding: 'utf8' });

    expect(checkCommitContents(dir, 'HEAD~2..HEAD')).not.toEqual([]);
  });

  it('inspects the first commit of a repository, which has no parent to compare against', () => {
    const dir = scratchRepo();
    track(dir, 'notes.md', `Reviewed by ${GIVEN_NAME}.\n`);
    commit(dir, 'initial');
    expect(checkCommitContents(dir, 'HEAD')).toHaveLength(1);
  });

  it('checks the path of an entry that is not a blob, such as a submodule', () => {
    const dir = scratchRepo();
    track(dir, 'base.md', 'Base.\n');
    commit(dir, 'initial');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    // A gitlink: the entry resolves to a commit object, so there is no blob to read.
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${head},${GIVEN_NAME}-vendor`], {
      cwd: dir,
      encoding: 'utf8',
    });
    commit(dir, 'add a submodule');
    const violations = checkCommitContents(dir, 'HEAD~1..HEAD');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('in the path');
  });

  it('does not fail a commit for content it removes', () => {
    const dir = scratchRepo();
    track(dir, 'notes.md', `Reviewed by ${GIVEN_NAME}.\n`);
    commit(dir, 'initial');
    track(dir, 'notes.md', 'Reviewed internally.\n');
    commit(dir, 'docs: take the name out');
    expect(checkCommitContents(dir, 'HEAD~1..HEAD')).toEqual([]);
  });

  it('reports one violation per commit even when the name repeats down the patch', () => {
    const dir = scratchRepo();
    commit(dir, 'initial');
    track(dir, 'notes.md', `${GIVEN_NAME}\n${GIVEN_NAME}\n${GIVEN_NAME}\n`);
    commit(dir, 'docs: add notes');
    expect(checkCommitContents(dir, 'HEAD~1..HEAD')).toHaveLength(1);
  });
});

describe('checkCommitMessages', () => {
  it('passes an English message with no names in it', () => {
    const dir = scratchRepo();
    commit(dir, 'initial');
    commit(dir, 'fix: keep the export order stable');
    expect(checkCommitMessages(dir, 'HEAD~1..HEAD')).toEqual([]);
  });

  it('rejects a Japanese commit message', () => {
    const dir = scratchRepo();
    commit(dir, 'initial');
    commit(dir, 'fix: 書き出しの順序を安定させる');
    const violations = checkCommitMessages(dir, 'HEAD~1..HEAD');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('the commit message');
  });

  // Each of these is Japanese that a hand-written kana-and-kanji range misses.
  it.each([
    ['half-width katakana', 'ﾆﾎﾝｺﾞ'],
    ['the ideographic zero', '〇'],
    ['the closing mark', '〆'],
    ['a kanji outside the basic plane', '𠮷'],
    ['the prolonged sound mark, whose primary script is Common', 'ー'],
    ['the ideographic full stop', '。'],
  ])('rejects %s in a commit message', (_label, sample) => {
    const dir = scratchRepo();
    commit(dir, 'initial');
    commit(dir, `fix: ${sample}`);
    expect(checkCommitMessages(dir, 'HEAD~1..HEAD')).toHaveLength(1);
  });

  // The middle dot is script-extended to Han but belongs to ordinary English too, so it is
  // deliberately excluded. The rest guards against the expression collapsing into its own letters.
  it.each([
    ['plain words', 'fix: p S c r i p t Han Hiragana Katakana'],
    ['a middle dot', 'fix: read A · B as one'],
    ['accents and dashes', 'fix: café — naïve … résumé'],
  ])('does not mistake %s for Japanese', (_label, message) => {
    const dir = scratchRepo();
    commit(dir, 'initial');
    commit(dir, message);
    expect(checkCommitMessages(dir, 'HEAD~1..HEAD')).toEqual([]);
  });

  it('rejects a name and a co-author trailer in the body', () => {
    const dir = scratchRepo();
    commit(dir, 'initial');
    commit(dir, `fix: something\n\nreviewed by ${GIVEN_NAME}\n\nCo-Authored-By: someone <a@b.c>\n`);
    const violations = checkCommitMessages(dir, 'HEAD~1..HEAD');
    expect(violations).toHaveLength(2);
  });

  it('reads a multi-line message as one commit rather than splitting it into several', () => {
    const dir = scratchRepo();
    commit(dir, 'initial');
    commit(dir, 'feat: a subject\n\na body paragraph\n\nand another\n');
    commit(dir, 'feat: 日本語');
    // Only the last commit is at fault; the multi-line one before it must not be miscounted.
    expect(checkCommitMessages(dir, 'HEAD~2..HEAD')).toHaveLength(1);
  });
});

describe('checkText — pull request text and anything else that is not a file', () => {
  it('passes English text with no names in it', () => {
    expect(checkText('the pull request text', 'Adds a guard for the repository rules.')).toEqual([]);
  });

  it('rejects Japanese, a name, and a co-author trailer, and names the text in the message', () => {
    const violations = checkText(
      'the pull request text',
      `日本語のタイトル\n\nreviewed by ${GIVEN_NAME}\n\nCo-Authored-By: someone <a@b.c>\n`,
    );
    expect(violations).toHaveLength(3);
    for (const violation of violations) expect(violation).toContain('the pull request text');
  });
});

describe('the guards agree with the repository they ship in', () => {
  it('REPO_ROOT points at this repository', () => {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    expect(top.replace(/\\/g, '/').toLowerCase()).toBe(REPO_ROOT.replace(/\\/g, '/').toLowerCase());
  });
});

describe('the two guards leave no file type unread', () => {
  it('a Japanese comment in an SVG is caught by the comment guard', () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, 'logo.svg'), '<svg><!-- 日本語のコメント --><rect /></svg>\n', 'utf8');
    // The document guard treats SVG as markup, so the comment guard is the one that has to see it.
    expect(checkProseLanguage(dir, ['logo.svg'])).toEqual([]);
    expect(checkCommentLanguage(dir, ['logo.svg'])).toHaveLength(1);
  });
});

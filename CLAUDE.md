# CLAUDE.md

Rules for any session that writes to this repository.

## This repository is public

Four rules. Three of them are decided by CI; the fourth is the one left to whoever is working here.

1. **Write with the `martin-ushiyama` account only.** Every commit's author is that account, and
   no commit carries a co-author trailer.
2. **Write everything in English** — comments, documents, commit messages, pull request text.
3. **Do not write personal names.** Not in files, not in commit messages.
4. **Do not carry development context in here.** Internal discussion, planning notes, the reasons
   a decision was reached elsewhere, references to work that lives in other repositories — none of
   that belongs in a public repository. Write what a reader outside the project needs, and stop
   there.

Rule 4 cannot be checked by a machine. That is exactly why the other three are: it keeps the
judgement needed down to one rule instead of four.

### The Japanese the app does ship

Rule 2 is about what a person writes. It is not about the product's Japanese UI, which is data:
the locale dictionary (`src/core/i18n.ts`), the block names (`src/data/blocks.json`), the
bilingual control guide (`src/ui/help.ts`), and the tests that assert on Japanese labels.

So Japanese is allowed in string literals and JSON data, and rejected in comments, documents,
and file names. A document written in Japanese says so in its own name, with a `.ja.` marker:
`README.ja.md`. That is a naming convention, not a list of exempt paths, so it cannot grow one
exception at a time.

"Document" is decided by exclusion: anything tracked that is not source, markup, config or data
is one. A list of document names would never stay complete, and `LICENSE` has no extension to
match on.

## What CI checks

| Rule | Guard | Where |
|---|---|---|
| Japanese in comments | `checkCommentLanguage` | `scripts/architecture-lint.mjs` (run by `tests/architecture.test.ts`) |
| Japanese in documents | `checkProseLanguage` | `scripts/public-repo-lint.mjs` |
| Personal names and co-author trailers, in contents and in paths | `checkForbiddenWords` | `scripts/public-repo-lint.mjs` |
| Commit author | `checkCommitAuthors` | `scripts/public-repo-lint.mjs` |
| Commit message language and names | `checkCommitMessages` | `scripts/public-repo-lint.mjs` |
| Pull request title and body | `checkText` | `scripts/public-repo-lint.mjs` |

Commits are checked on pushes as well as on pull requests, because a merge or squash commit is
created after the pull request was last examined.

Run the file checks locally:

```bash
npm run lint:public
```

Add the range to check commits as well:

```bash
node scripts/public-repo-lint.mjs --commits origin/main..HEAD
```

The forbidden words are stored as hashes rather than spelled out, because a list of the names
this repository must not contain would itself put them here. To add one:

```bash
node scripts/public-repo-lint.mjs --hash <word>
```

and paste the line it prints into `FORBIDDEN_TOKEN_HASHES`.

## Escape hatch

The comment guard takes `// i18n-allow: <reason>` on the line above, which forces a reason to be
written down. The document, name, and commit guards have no escape hatch — for those, fix the
text.

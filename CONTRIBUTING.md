# Contributing to Kigumi

Bug reports, feature proposals, documentation fixes, and code contributions are welcome.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Please report suspected vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not in a public issue.

## Before you start

- Search existing issues before opening a new one.
- Open an issue before starting a substantial change so the problem and scope can be agreed on.
- Keep pull requests focused. Unrelated changes are easier to review separately.
- Write source code, comments, commit messages, pull request text, and project documentation in
  English. User-facing translations belong in the locale data.
- Do not commit Minecraft or Mojang assets. The repository intentionally excludes upstream files
  that cannot be redistributed.

## Development setup

You need Git, Node.js 24 or newer, and npm.

```bash
git clone <your-fork-url>
cd kigumi
npm ci
npm run dev
```

The development server runs at `http://localhost:5199`. Read
[docs/architecture.md](docs/architecture.md) before changing module boundaries or editor model
APIs.

## Checks

Run these checks before opening a pull request:

```bash
npm run lint
npm run lint:public
npm run typecheck
npm run test:coverage
npm run build
npm run check:bundle-size
```

For interface or interaction changes, also run:

```bash
npm run test:e2e
```

The end-to-end suite uses Playwright Chromium. On a new machine, install it once with
`npx playwright install --with-deps chromium`.

## Pull requests

- Explain the user-visible problem and the chosen solution.
- Add or update tests for behaviour changes.
- Include screenshots or a short recording for visual changes.
- Note known limitations and follow-up work.
- Make sure CI is green before requesting review.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).

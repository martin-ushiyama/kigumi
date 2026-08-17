/// <reference types="node" />
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Dev only: accepts POST /__dev/screenshot {name, data(base64)} from the page and saves it under
 * .shots/ (for manual verification; .shots is gitignored).
 */
function devScreenshotPlugin(): Plugin {
  // Abuse guards: localhost origin only, JSON only, 4MB body limit and 3MB image limit.
  const MAX_BODY_BYTES = 4 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
  const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

  return {
    name: 'dev-screenshot',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/screenshot', (req, res) => {
        const fail = (code: number, error: string) => {
          res.statusCode = code;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: false, error }));
        };
        if (req.method !== 'POST') {
          fail(405, 'method not allowed');
          return;
        }
        const origin = req.headers.origin;
        if (typeof origin !== 'string' || !LOCAL_ORIGIN.test(origin)) {
          fail(403, 'origin not allowed');
          return;
        }
        if (!/^application\/json\b/.test(String(req.headers['content-type'] ?? ''))) {
          fail(415, 'content-type must be application/json');
          return;
        }
        const declared = Number(req.headers['content-length'] ?? 0);
        if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_BODY_BYTES) {
          fail(413, `content-length required (max ${MAX_BODY_BYTES} bytes)`);
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        let aborted = false;
        req.on('data', (chunk: Buffer) => {
          if (aborted) return;
          received += chunk.length;
          if (received > MAX_BODY_BYTES) {
            aborted = true;
            fail(413, 'body too large');
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          if (aborted) return;
          try {
            const { name, data } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              name: string;
              data: string;
            };
            if (typeof name !== 'string' || typeof data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(data)) {
              fail(400, 'invalid payload');
              return;
            }
            const bytes = Buffer.from(data, 'base64');
            if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
              fail(413, `image too large (max ${MAX_IMAGE_BYTES} bytes)`);
              return;
            }
            const safe = name.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64) || 'shot';
            const dir = join(process.cwd(), '.shots');
            mkdirSync(dir, { recursive: true });
            const file = join(dir, `${safe}.jpg`);
            writeFileSync(file, bytes);
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, file }));
          } catch (e) {
            fail(400, String(e));
          }
        });
      });
    },
  };
}

export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  /**
   * Pin the dev server port, the same way the e2e preview is pinned to 4319.
   *
   * 5199: Vite's default of 5173 is often already taken by another project's long-running dev
   * server, so the default collides. Use a dedicated port that does not.
   *
   * **Always keep strictPort.** By default Vite silently moves to the next free port when the
   * requested one is busy, which makes a bookmark or an always-on launcher URL quietly point at
   * something else (or 404). Fail the startup instead, so the collision is visible.
   */
  server: { port: 5199, strictPort: true },
  plugins: [devScreenshotPlugin()],
  test: {
    exclude: ['e2e/**', 'node_modules/**'],
    /**
     * 30s rather than the 5s default.
     *
     * Not every test here is a pure unit test any more. `architecture.test.ts` parses every
     * tracked file with the TypeScript compiler, and `public-repo-lint.test.ts` builds scratch
     * repositories and shells out to git. Run side by side on a two-core runner they take each
     * other's CPU, and the guard tests were failing on time rather than on a finding — the worst
     * kind of red, because it says nothing about the code.
     */
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // Vitest 4: the `all` option is gone; specifying `include` automatically covers files that
      // were never executed.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/data/**'],
      // Pinned slightly below the figures measured on 2026-07-20, after the layer drag-and-drop
      // work in PR #7 landed (stmts 31.26% / branch 31.13% / funcs 33.7% / lines 30.46%).
      // Dropping below this fails CI. Raising these numbers is welcome; a PR that lowers them
      // should say why.
      thresholds: {
        statements: 30,
        branches: 30,
        functions: 33,
        lines: 30,
      },
    },
  },
});

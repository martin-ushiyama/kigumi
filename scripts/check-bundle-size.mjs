/**
 * Checks that the combined gzip size of the JS+CSS under dist/assets stays inside the budget.
 * Intended to run in CI after a build (`npm run build`).
 *
 * The budget is the current figure with headroom. **The point is to catch a sudden jump**, not
 * to enforce strict minimization. When it grows for a legitimate reason, update BUDGET_BYTES.
 *
 * History:
 * - 2026-07-20: measured 184.48 kB → budget 230 kB (+25%)
 * - 2026-08-02: **main had grown to 229.25 kB (99.7% of the budget).**
 *   With only 0.75 kB of headroom any small change would fail, which made it "you may not grow
 *   at all" rather than "catch a sudden jump", so it was redrawn at the current figure + 25% =
 *   290 kB. How it grows in the first place is a separate matter (three.js is most of it, and
 *   the app's own growth deserves to be measured apart from it)
 *
 *   node scripts/check-bundle-size.mjs
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST_ASSETS = new URL('../dist/assets', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const BUDGET_BYTES = 290 * 1024; // 290 kB gzip (measured ~230.14 kB on 2026-08-02 + ~25% headroom)
const TARGET_EXT = new Set(['.js', '.css']);

function collectFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return collectFiles(full);
    return [full];
  });
}

const files = collectFiles(DIST_ASSETS).filter((f) => TARGET_EXT.has(f.slice(f.lastIndexOf('.'))));

let totalGzip = 0;
for (const file of files) {
  const gz = gzipSync(readFileSync(file)).length;
  totalGzip += gz;
  console.log(`${file.replace(DIST_ASSETS, 'dist/assets')}: ${(gz / 1024).toFixed(2)} kB gzip`);
}

console.log(`\nTotal: ${(totalGzip / 1024).toFixed(2)} kB gzip (budget: ${(BUDGET_BYTES / 1024).toFixed(0)} kB)`);

if (totalGzip > BUDGET_BYTES) {
  console.error(`\n❌ Bundle size budget exceeded: ${(totalGzip / 1024).toFixed(2)} kB > ${(BUDGET_BYTES / 1024).toFixed(0)} kB`);
  process.exit(1);
}
console.log('\n✅ Within budget');

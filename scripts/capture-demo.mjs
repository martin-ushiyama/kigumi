/* global window */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const FPS = 8;
const PORT = 4320;
const ROOT = process.cwd();
const OUTPUT = resolve(ROOT, 'docs/assets/kigumi-demo.gif');

function waitForExit(child, name) {
  return new Promise((resolveExit, reject) => {
    child.once('error', (error) => reject(new Error(`${name} could not start`, { cause: error })));
    child.once('exit', (code) => {
      if (code === 0) resolveExit();
      else reject(new Error(`${name} exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Preview server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The preview server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Preview server did not start at ${url}`);
}

async function main() {
  const frameDir = await mkdtemp(join(tmpdir(), 'kigumi-demo-'));
  const vite = resolve(ROOT, 'node_modules/vite/bin/vite.js');
  const preview = spawn(process.execPath, [vite, 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  let browser;

  try {
    const url = `http://localhost:${PORT}/`;
    await waitForServer(url, preview);
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      colorScheme: 'light',
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const NativeDate = Date;
      const fixedTime = Date.parse('2026-01-15T10:24:00Z');
      class FixedDate extends NativeDate {
        constructor(...args) {
          super(...(args.length === 0 ? [fixedTime] : args));
        }

        static now() {
          return fixedTime;
        }
      }
      window.Date = FixedDate;
      localStorage.setItem('blocksmith.onboarding.v1', 'done');
      localStorage.setItem('blocksmith.ui.v1', JSON.stringify({ lang: 'en', theme: 'light' }));
      let seed = 0x4b494755;
      Math.random = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 0x100000000;
      };
    });
    await page.goto(url);
    await page.waitForFunction(() => Boolean(window.__bs?.world));

    let frame = 0;
    const snap = async (copies = 1) => {
      const bytes = await page.screenshot();
      for (let copy = 0; copy < copies; copy += 1) {
        const file = join(frameDir, `frame-${String(frame).padStart(4, '0')}.png`);
        await writeFile(file, bytes);
        frame += 1;
      }
    };

    await snap(FPS);
    await page.getByRole('tab', { name: 'Patterns' }).click();
    await page.evaluate(() => {
      const ids = [
        ['minecraft:stone_bricks', 4],
        ['minecraft:cobblestone', 3],
        ['minecraft:andesite', 2],
        ['minecraft:mossy_cobblestone', 1],
      ];
      window.__bs.recipeStore.replaceAll([
        {
          id: 'demo-path',
          name: 'Weathered stone path',
          entries: ids.map(([blockId, weight]) => ({ blockId, weight })),
        },
      ]);
      window.__bs.setActiveRecipe('demo-path');
    });
    await snap(FPS);

    await page.getByRole('button', { name: 'Place (1)' }).click();
    const cells = [];
    for (let x = -5; x <= 5; x += 1) {
      const centre = Math.round(Math.sin(x / 2) * 1.5);
      for (let offset = -1; offset <= 1; offset += 1) cells.push([x, centre + offset]);
    }
    for (const [x, z] of cells) {
      const point = await page.evaluate(([cellX, cellZ]) => window.__bs.groundScreenPos(cellX, cellZ), [x, z]);
      await page.mouse.click(point.x, point.y);
      await snap();
    }
    await page.keyboard.press('f');
    await page.waitForTimeout(400);
    await snap(FPS);

    await page.getByRole('textbox', { name: 'Project name' }).fill('Weathered path');
    const exportButton = page.getByRole('button', { name: 'Export' });
    await exportButton.focus();
    await snap(Math.round(FPS / 2));
    const downloadPromise = page.waitForEvent('download');
    await exportButton.click();
    await downloadPromise;
    await snap(FPS * 2);

    await mkdir(resolve(ROOT, 'docs/assets'), { recursive: true });
    const input = join(frameDir, 'frame-%04d.png');
    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-framerate',
        String(FPS),
        '-i',
        input,
        '-vf',
        'fps=8,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
        OUTPUT,
      ],
      { cwd: ROOT, stdio: 'inherit' },
    );
    await waitForExit(ffmpeg, 'ffmpeg');
    console.log(`Wrote ${frame} frames to ${OUTPUT}`);
  } finally {
    await browser?.close();
    preview.kill();
    await rm(frameDir, { recursive: true, force: true });
  }
}

await main();

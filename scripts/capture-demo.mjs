/* global document, window */
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
      // Autosave runs on a real timer, so normalize its incidental status text before every frame.
      // The capture is about editing, not whether a fast or slow machine crossed the one-second debounce first.
      await page.evaluate(() => {
        const saveState = document.querySelector('.document-save-state');
        if (saveState) saveState.textContent = 'Autosave stays in this browser. Save JSON for backup.';
      });
      const bytes = await page.screenshot({ animations: 'disabled' });
      for (let copy = 0; copy < copies; copy += 1) {
        const file = join(frameDir, `frame-${String(frame).padStart(4, '0')}.png`);
        await writeFile(file, bytes);
        frame += 1;
      }
    };

    const moveWithFrames = async (from, to, steps, copies = 1) => {
      for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps;
        await page.mouse.move(
          from.x + (to.x - from.x) * progress,
          from.y + (to.y - from.y) * progress,
        );
        await snap(copies);
      }
    };

    await snap(FPS);
    await page.evaluate(() => {
      const stoneBricks = window.__bs.CATALOG.findIndex((block) => block.id === 'minecraft:stone_bricks');
      if (stoneBricks < 0) throw new Error('Stone bricks are missing from the catalog');
      window.__bs.setActiveBlock(stoneBricks);
    });
    await page.keyboard.press('3');
    await snap(Math.round(FPS / 2));

    const wallStart = await page.evaluate(() => window.__bs.groundScreenPos(-5, 0));
    const wallEnd = await page.evaluate(() => window.__bs.groundScreenPos(5, 0));
    await page.mouse.move(wallStart.x, wallStart.y);
    await page.mouse.down();
    await snap(2);
    await moveWithFrames(wallStart, wallEnd, 6);
    await page.mouse.up();
    await snap(2);

    const wallTop = { x: wallEnd.x, y: wallEnd.y - 150 };
    await moveWithFrames(wallEnd, wallTop, 6);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction(() => window.__bs.world.size >= 40);
    await snap(FPS);

    await page.keyboard.press('f');
    await page.waitForTimeout(400);
    await snap(FPS);

    await page.evaluate(() => {
      const ids = [
        ['minecraft:stone_bricks', 6],
        ['minecraft:mossy_stone_bricks', 2],
        ['minecraft:cracked_stone_bricks', 2],
        ['minecraft:cobblestone', 1],
      ];
      window.__bs.recipeStore.replaceAll([
        {
          id: 'demo-wall',
          name: 'Weathered masonry',
          entries: ids.map(([blockId, weight]) => ({ blockId, weight })),
        },
      ]);
    });
    await page.getByRole('tab', { name: 'Patterns' }).click();
    await snap(FPS);
    await page.evaluate(() => window.__bs.setActiveRecipe('demo-wall'));
    await snap(Math.round(FPS / 2));

    await page.keyboard.press('v');
    const wallBounds = await page.evaluate(() => {
      const groupId = window.__bs.doc.tree.childrenOf(null)[0];
      if (!groupId) throw new Error('The generated wall group is missing');
      const points = [...window.__bs.doc.scene.cells.entriesOf(groupId)].map(([key]) => {
        const [x, y, z] = key.split(',').map(Number);
        return window.__bs.cellScreenPos(x, y, z);
      });
      return {
        minX: Math.min(...points.map((point) => point.x)),
        minY: Math.min(...points.map((point) => point.y)),
        maxX: Math.max(...points.map((point) => point.x)),
        maxY: Math.max(...points.map((point) => point.y)),
      };
    });
    const marqueeStart = { x: wallBounds.minX - 28, y: wallBounds.minY - 28 };
    const marqueeEnd = { x: wallBounds.maxX + 28, y: wallBounds.maxY + 28 };
    await page.mouse.move(marqueeStart.x, marqueeStart.y);
    await page.mouse.down();
    await moveWithFrames(marqueeStart, marqueeEnd, 6);
    await page.mouse.up();

    // Keep the capture deterministic even if a projected edge lands just outside the visual marquee.
    await page.evaluate(() => {
      const groupId = window.__bs.doc.tree.childrenOf(null)[0];
      if (!groupId) throw new Error('The generated wall group is missing');
      const entries = [...window.__bs.doc.scene.cells.entriesOf(groupId)].map(([key]) => {
        const localCell = key.split(',').map(Number);
        const ref = { ownerId: groupId, localCell };
        return [`${groupId.length}|${groupId}|${key}`, { ref, worldCell: localCell }];
      });
      window.__bs.selection.set({ kind: 'cells', cells: new Map(entries) });
    });
    await snap(Math.round(FPS / 2));

    const repaint = page.getByRole('button', { name: 'Repaint with pattern (Weathered masonry)' });
    await repaint.scrollIntoViewIfNeeded();
    await snap(Math.round(FPS / 2));
    await repaint.click();
    await snap(FPS);
    await page.keyboard.press('Escape');
    await snap(FPS);

    await page.getByRole('textbox', { name: 'Project name' }).fill('Weathered wall');
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
        '-filter_threads',
        '1',
        '-framerate',
        String(FPS),
        '-i',
        input,
        '-vf',
        'fps=8,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
        '-threads',
        '1',
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

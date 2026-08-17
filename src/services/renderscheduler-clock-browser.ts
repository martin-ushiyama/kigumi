import type { FrameClock } from './renderscheduler';

/**
 * The real browser implementation of `FrameClock` (`performance` / `document` /
 * `requestAnimationFrame` / `setTimeout`).
 * `../services/renderscheduler.ts` (the RenderScheduler body) never imports this file —
 * only main.ts (composition root) assembles this and injects it, e.g.
 * `createRenderScheduler({ clock: createBrowserFrameClock() })`
 * (separates the browser time/scheduling API implementation from the
 * service body, same policy as ProjectService's `createBrowserProjectIO`).
 */
export function createBrowserFrameClock(): FrameClock {
  return {
    now: () => performance.now(),
    isHidden: () => document.visibilityState === 'hidden',
    requestFrame: (cb) => {
      requestAnimationFrame(cb);
    },
    scheduleTimeout: (cb, ms) => {
      setTimeout(cb, ms);
    },
  };
}

import { describe, expect, it, vi } from 'vitest';
import { DisplayableError } from '../src/core/i18n';
import { errorText, setLang } from '../src/state';

/**
 * The display boundary contract (raised in review).
 *
 * Through round 2 the design assumed "a throw never reaches the screen, so it needs no
 * translation", but the Japanese throw in `persistence.ts` travelled from the `ProjectService`
 * catch into a toast. Fixing throws one by one just restarts the enumeration, so we
 * **closed it at the boundary with types** — `errorText(e, fallback)` now requires a fallback,
 * removing the path by which a raw `Error.message` could ever reach the user.
 *
 * This contract is exactly what lets `checkDisplayLiterals` in
 * `scripts/architecture-lint.mjs` leave throws out of its scope. If this breaks,
 * that exclusion becomes invalid at the same moment.
 */
describe('errorText — the display boundary', () => {
  const JA = /[぀-ヿ一-鿿]/;

  function withLang<T>(lang: 'en' | 'ja', fn: () => T): T {
    setLang(lang);
    try {
      return fn();
    } finally {
      setLang('en');
    }
  }

  it('never returns a raw Error message (a Japanese throw never reaches the screen)', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const text = withLang('en', () => errorText(new Error('blocksmith のプロジェクトファイルじゃない'), 'err.loadFailed'));
      expect(text).not.toContain('blocksmith のプロジェクトファイルじゃない');
      expect(JA.test(text)).toBe(false);
      expect(text).toBe('Not a valid blocksmith project file');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not pass through non-Error values either (a thrown string, etc.)', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const text = withLang('en', () => errorText('生の文字列エラー', 'err.exportFailed'));
      expect(text).not.toContain('生の文字列エラー');
      expect(JA.test(text)).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('resolves the fallback in the current language (not merely forced to English)', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const text = withLang('ja', () => errorText(new Error('boom'), 'err.loadFailed'));
      expect(JA.test(text)).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps the details in the console (debuggability is not lost)', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const cause = new Error('groups が配列じゃない');
      withLang('en', () => errorText(cause, 'err.loadFailed'));
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('blocksmith'), cause);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('resolves a DisplayableError to the current language through its key (the fallback is not used)', () => {
    const e = new DisplayableError('exportErr.empty');
    expect(withLang('en', () => errorText(e, 'err.loadFailed'))).toBe('No blocks have been placed');
    expect(withLang('ja', () => errorText(e, 'err.loadFailed'))).toBe('ブロックが 1 つも置かれていない');
  });
});

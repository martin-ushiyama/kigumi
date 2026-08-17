import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { isTypingTarget } from '../src/input/typing';

// vitest defaults to the node environment (no jsdom, also consistent with the input plan's
// "DOM-independent input handler" policy).
// We test by injecting into globalThis only the minimal classes needed for instanceof checks.
class FakeInputElement {}
class FakeTextAreaElement {}
class FakeHTMLElement {
  isContentEditable = false;
}

let prevInput: unknown;
let prevTextArea: unknown;
let prevHtmlElement: unknown;

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  prevInput = g.HTMLInputElement;
  prevTextArea = g.HTMLTextAreaElement;
  prevHtmlElement = g.HTMLElement;
  g.HTMLInputElement = FakeInputElement;
  g.HTMLTextAreaElement = FakeTextAreaElement;
  g.HTMLElement = FakeHTMLElement;
});

afterAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = prevInput;
  g.HTMLTextAreaElement = prevTextArea;
  g.HTMLElement = prevHtmlElement;
});

describe('isTypingTarget', () => {
  it('null is false', () => {
    expect(isTypingTarget(null)).toBe(false);
  });

  it('an input element is true', () => {
    expect(isTypingTarget(new FakeInputElement() as unknown as EventTarget)).toBe(true);
  });

  it('a textarea element is true', () => {
    expect(isTypingTarget(new FakeTextAreaElement() as unknown as EventTarget)).toBe(true);
  });

  it('a contentEditable element is true', () => {
    const el = new FakeHTMLElement();
    el.isContentEditable = true;
    expect(isTypingTarget(el as unknown as EventTarget)).toBe(true);
  });

  it('a normal element that is not contentEditable is false', () => {
    const el = new FakeHTMLElement();
    expect(isTypingTarget(el as unknown as EventTarget)).toBe(false);
  });

  it('an EventTarget that is neither HTMLElement nor input/textarea is false', () => {
    const fakeTarget = {} as EventTarget;
    expect(isTypingTarget(fakeTarget)).toBe(false);
  });
});

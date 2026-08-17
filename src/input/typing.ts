/**
 * Determines whether the current input target should not trigger keyboard shortcuts.
 * The same instanceof check used to be copy-pasted in 5+1 places: controls.ts /
 * selecttool.ts / camerakeys.ts / main.ts (x2) / help.ts. Consolidated here.
 *
 * Added a contentEditable check (extended coverage that wasn't in the old copy-pasted
 * version).
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return false;
}

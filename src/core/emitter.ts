/** Unsubscribe function returned by subscribe() (#13 common convention) */
export type Unsubscribe = () => void;

/**
 * Shared implementation of subscribe/notify. Consolidates the "don't let one listener's
 * throw propagate to other listeners or the caller" logic that used to be implemented
 * separately in VoxelWorld.safeNotify / Document.notify (#13). "Notification succeeding"
 * and "the operation itself succeeding" are independent concerns — a notify failure
 * (e.g. a rendering-side bug) isn't a reason to roll back the operation or misreport its
 * outcome to the caller (following the #22 third-review finding).
 * console isn't used here (the editor/ side's tsconfig doesn't include DOM/Node ambient globals).
 */
export function createEmitter<T>(): {
  subscribe: (fn: (event: T) => void) => Unsubscribe;
  notify: (event: T) => void;
} {
  const listeners = new Set<(event: T) => void>();
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    notify(event) {
      // Snapshot the subscribers at the moment notification starts, then iterate that
      // (don't iterate the live Set directly). If a listener subscribes/unsubscribes during
      // notify, that only takes effect from the next notify onward and doesn't affect the
      // event currently being delivered (#13 PR #27 review finding: iterating the live Set
      // directly could double-deliver to a listener that re-subscribes itself within the same
      // notify, or make delivery depend on other listeners' unsubscribe timing relative to
      // registration order — both violate Issue #13's completion condition that behavior
      // must not depend on the order listeners were added)
      for (const fn of [...listeners]) {
        try {
          fn(event);
        } catch {
          // best-effort, intentionally swallowed (see comment above)
        }
      }
    },
  };
}

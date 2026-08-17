import { parseCellKey } from '../../src/core/types';
import type { WorldChange } from '../../src/core/voxels';
import type { WorldIndexChange } from '../../src/core/worldindex';

/**
 * Event mapping for renderer unit tests.
 *
 * The renderer now receives a `WorldIndexChange` directly. But what renderer unit tests
 * care about is "does it do a diff update when a cells event arrives / a full rebuild for
 * replaceAll" — the verification doesn't change whether the event's source is `VoxelWorld`
 * or `WorldIndex`. A thin mapping so existing tests can keep using the plain `WorldReader`
 * implementation (VoxelWorld) as their base.
 *
 * **Do not use this in tests that verify main.ts's real wiring** — those connect Document
 * and WorldIndex directly and verify the notification-count contract as-is.
 */
export function toIndexChange(event: WorldChange): WorldIndexChange {
  if (event.kind === 'cells') return { kind: 'cells', cells: event.keys.map((k) => parseCellKey(k)) };
  return { kind: 'replaceAll' }; // replaceAll and clear both mean "can't be tracked as a diff" = full rebuild
}

import { describe, expect, it, vi } from 'vitest';
import { BACKUP_REMINDER_BLOCK_THRESHOLD, createBackupReminder } from '../../src/services/backup-reminder';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe('backup reminder', () => {
  it('notifies once when an edit reaches one Minecraft stack of blocks', () => {
    const notify = vi.fn();
    const reminder = createBackupReminder({ storage: memoryStorage(), notify });

    reminder.consider({ kind: 'edit', voxelOnly: true }, BACKUP_REMINDER_BLOCK_THRESHOLD - 1);
    expect(notify).not.toHaveBeenCalled();

    reminder.consider({ kind: 'edit', voxelOnly: true }, BACKUP_REMINDER_BLOCK_THRESHOLD);
    reminder.consider({ kind: 'edit', voxelOnly: true }, BACKUP_REMINDER_BLOCK_THRESHOLD + 1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not remind while restoring or after the user saved a JSON backup', () => {
    const notify = vi.fn();
    const reminder = createBackupReminder({ storage: memoryStorage(), notify });

    reminder.consider({ kind: 'replaceAll' }, BACKUP_REMINDER_BLOCK_THRESHOLD);
    reminder.markBackedUp();
    reminder.consider({ kind: 'redo', voxelOnly: true }, BACKUP_REMINDER_BLOCK_THRESHOLD);
    expect(notify).not.toHaveBeenCalled();
  });

  it('falls back to an in-memory once flag when session storage is unavailable', () => {
    const notify = vi.fn();
    const storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const reminder = createBackupReminder({ storage, notify });

    reminder.consider({ kind: 'edit', voxelOnly: true }, BACKUP_REMINDER_BLOCK_THRESHOLD);
    reminder.consider({ kind: 'edit', voxelOnly: true }, BACKUP_REMINDER_BLOCK_THRESHOLD);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

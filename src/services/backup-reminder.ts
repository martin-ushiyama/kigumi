import type { DocumentChange } from '../core/document';

export const BACKUP_REMINDER_BLOCK_THRESHOLD = 64;
const BACKUP_REMINDER_STORAGE_KEY = 'kigumi.backup-reminder.v1';

export interface BackupReminder {
  consider: (change: DocumentChange, blockCount: number) => void;
  markBackedUp: () => void;
}

interface BackupReminderOpts {
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  notify: () => void;
  threshold?: number;
}

/** Reminds once per browser session after a meaningful amount of editing. */
export function createBackupReminder(opts: BackupReminderOpts): BackupReminder {
  const { storage, notify, threshold = BACKUP_REMINDER_BLOCK_THRESHOLD } = opts;
  let handled = false;

  function wasHandled(): boolean {
    if (handled) return true;
    try {
      handled = storage.getItem(BACKUP_REMINDER_STORAGE_KEY) === 'done';
    } catch {
      // The in-memory flag still prevents repeated reminders when storage is unavailable.
    }
    return handled;
  }

  function markBackedUp(): void {
    handled = true;
    try {
      storage.setItem(BACKUP_REMINDER_STORAGE_KEY, 'done');
    } catch {
      // A successful download should still silence this tab even in private mode.
    }
  }

  function consider(change: DocumentChange, blockCount: number): void {
    if ((change.kind !== 'edit' && change.kind !== 'redo') || blockCount < threshold || wasHandled()) return;
    markBackedUp();
    notify();
  }

  return { consider, markBackedUp };
}

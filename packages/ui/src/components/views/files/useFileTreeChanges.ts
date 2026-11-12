import React from 'react';

import { affectedDirectories, subscribeFileTreeChanges } from '@/lib/fileTreeChanges';
import { normalizePath } from '@/lib/pathNormalization';

/**
 * Changes collect for this long after the first one, so a surface re-lists at
 * most once per window however fast the agent works. Two seconds is fresh
 * enough for a file tree, and every re-list costs relay bytes.
 */
const BATCH_DELAY_MS = 2000;

/**
 * A folder whose last listing had more entries than this is not re-listed on
 * its own: each re-list sends the whole listing again. The refresh button and
 * expanding it still read it.
 */
export const AUTO_RELIST_MAX_ENTRIES = 1000;

/**
 * `directories` are the listings under the root that changed; `null` means
 * anything under the root may have changed.
 */
export type FileTreeChangeBatch = { directories: string[] | null };

type Options = {
  root: string;
  /** The surface is on screen. Batches wait for it, and for the window to be visible. */
  active: boolean;
  /**
   * What happens to changes while `active` is false: `drop` when the surface
   * refreshes itself on reopening anyway, `hold` to receive them on reopening.
   */
  whileInactive: 'drop' | 'hold';
  onChanges: (batch: FileTreeChangeBatch) => void;
};

/**
 * Delivers file changes under `root` (see `lib/fileTreeChanges`) in batches.
 * Nothing runs while no change arrives: no timer, no request.
 */
export const useFileTreeChanges = ({ root, active, whileInactive, onChanges }: Options): void => {
  const onChangesRef = React.useRef(onChanges);
  onChangesRef.current = onChanges;
  const activeRef = React.useRef(active);
  activeRef.current = active;
  // `undefined`: nothing pending; `null`: the whole tree.
  const pendingRef = React.useRef<Set<string> | null | undefined>(undefined);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = React.useCallback(() => {
    timerRef.current = null;
    const pending = pendingRef.current;
    if (pending === undefined || !activeRef.current || document.hidden) return;
    pendingRef.current = undefined;
    onChangesRef.current({ directories: pending === null ? null : [...pending] });
  }, []);

  const schedule = React.useCallback(() => {
    if (timerRef.current !== null || pendingRef.current === undefined) return;
    if (!activeRef.current || document.hidden) return;
    timerRef.current = setTimeout(flush, BATCH_DELAY_MS);
  }, [flush]);

  React.useEffect(() => {
    const changeRoot = normalizePath(root);
    if (!changeRoot) return;
    const unsubscribe = subscribeFileTreeChanges((change) => {
      if (!activeRef.current && whileInactive === 'drop') return;
      // Answer in the caller's spelling of the root (drive-letter case).
      const directories = affectedDirectories(change, changeRoot)
        ?.map((directory) => `${root}${directory.slice(changeRoot.length)}`) ?? null;
      if (directories !== null && directories.length === 0) return;
      const pending = pendingRef.current;
      if (directories === null || pending === null) {
        pendingRef.current = null;
      } else {
        pendingRef.current = new Set([...(pending ?? []), ...directories]);
      }
      schedule();
    });
    return () => {
      unsubscribe();
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      pendingRef.current = undefined;
    };
  }, [root, schedule, whileInactive]);

  React.useEffect(() => {
    if (!active) {
      if (whileInactive === 'drop') pendingRef.current = undefined;
      return;
    }
    schedule();
    const handleVisibility = () => {
      if (!document.hidden) schedule();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [active, schedule, whileInactive]);
};

import React from 'react';

import { affectedDirectories, subscribeFileTreeChanges } from '@/lib/fileTreeChanges';
import { normalizePath } from '@/lib/pathNormalization';

const BATCH_DELAY_MS = 2000;

export const AUTO_RELIST_MAX_ENTRIES = 1000;

export type FileTreeChangeBatch = { directories: string[] | null };

type Options = {
  root: string;
  active: boolean;
  whileInactive: 'drop' | 'hold';
  onChanges: (batch: FileTreeChangeBatch) => void;
};

export const useFileTreeChanges = ({ root, active, whileInactive, onChanges }: Options): void => {
  const onChangesRef = React.useRef(onChanges);
  onChangesRef.current = onChanges;
  const activeRef = React.useRef(active);
  activeRef.current = active;
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

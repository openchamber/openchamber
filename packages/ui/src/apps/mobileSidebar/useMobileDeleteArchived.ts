import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { MobileDeleteArchivedDialog } from './MobileDeleteArchivedDialog';

export const useMobileDeleteArchived = () => {
  const [sessions, setSessions] = React.useState<readonly Session[] | null>(null);
  const requestArchivedDelete = React.useCallback((next: readonly Session[]) => setSessions([...next]), []);
  const dialog = sessions ? React.createElement(MobileDeleteArchivedDialog, {
    sessions,
    onClose: () => setSessions(null),
    onRemaining: setSessions,
  }) : null;
  return { requestArchivedDelete, dialog };
};

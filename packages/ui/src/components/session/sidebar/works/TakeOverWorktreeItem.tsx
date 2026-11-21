import React from 'react';

import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import { isOperatorChildSession } from '@/lib/sessionOperatorChild';
import { sessionsInWorktree } from '@/lib/worktrees/worktreeUse';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { takeOverSessions } from '@/sync/session-take-over';

type ItemSlot = React.ComponentType<{ className?: string; onClick?: (event: React.MouseEvent) => void; children?: React.ReactNode }>;

const NO_SESSIONS: Session[] = [];

const useOperatorChildrenInWorktree = (path: string | null): Session[] => {
  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);
  return React.useMemo(() => {
    if (!path) return NO_SESSIONS;
    const children = sessionsInWorktree(activeSessions, path).filter(isOperatorChildSession);
    return children.length > 0 ? children : NO_SESSIONS;
  }, [activeSessions, path]);
};

export function TakeOverWorktreeItem({ path, Item, iconClassName = 'h-4 w-4' }: { path: string | null; Item: ItemSlot; iconClassName?: string }): React.ReactNode {
  const { t } = useI18n();
  const children = useOperatorChildrenInWorktree(path);
  if (children.length === 0) return null;
  const takeOver = () => {
    void takeOverSessions(children, (session) => resolveGlobalSessionDirectory(session) ?? session.directory ?? null)
      .then((failed) => {
        if (failed.length > 0) toast.error(t('sessions.sidebar.session.takeOver.failed'));
      });
  };
  return (
    <Item onClick={takeOver}>
      <Icon name="user" className={iconClassName} />
      <span data-worktree-take-over={path}>
        {children.length === 1 ? t('sessions.sidebar.work.menu.takeOverOne') : t('sessions.sidebar.work.menu.takeOverMany', { count: children.length })}
      </span>
    </Item>
  );
}

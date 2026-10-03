import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SessionMenuItemHint } from '@/components/session/SessionMenuItemHint';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { SessionTabMenuComponents } from './SessionTabsStrip';

export function HeaderSessionArchiveMenuItem({ sessionId, onArchive, Item }: {
  sessionId: string;
  onArchive: () => void;
  Item: SessionTabMenuComponents['Item'];
}) {
  const { t } = useI18n();
  const archived = useGlobalSessionsStore((state) => Boolean(state.entityById.get(sessionId)?.time.archived));
  const isSubsession = useGlobalSessionsStore((state) => Boolean(state.entityById.get(sessionId)?.parentID));
  const unarchiveSession = useSessionUIStore((state) => state.unarchiveSession);

  const restore = async () => {
    const success = await unarchiveSession(sessionId);
    if (success) {
      toast.success(t('sessions.sidebar.session.restore.success'));
    } else {
      toast.error(t('sessions.sidebar.session.restore.error'));
    }
  };

  // An archived subsession comes back only with its parent.
  if (archived && isSubsession) return null;

  return (
    <SessionMenuItemHint hint={t(archived ? 'sessions.sidebar.session.menuHint.restore' : 'sessions.sidebar.session.menuHint.archive')}>
      <Item onClick={archived ? () => void restore() : onArchive}>
        <Icon name={archived ? 'inbox-unarchive' : 'inbox-archive'} className="mr-1 size-4" />
        {t(archived ? 'sessions.sidebar.bulkActions.restore' : 'sessions.sidebar.bulkActions.archive')}
      </Item>
    </SessionMenuItemHint>
  );
}

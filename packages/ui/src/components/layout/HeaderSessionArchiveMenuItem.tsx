import React from 'react';
import { Icon } from '@/components/icon/Icon';
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
  const unarchiveSession = useSessionUIStore((state) => state.unarchiveSession);

  const restore = async () => {
    const success = await unarchiveSession(sessionId);
    if (success) {
      toast.success(t('sessions.sidebar.session.restore.success'));
    } else {
      toast.error(t('sessions.sidebar.session.restore.error'));
    }
  };

  return (
    <Item onClick={archived ? () => void restore() : onArchive}>
      <Icon name={archived ? 'inbox-unarchive' : 'inbox-archive'} className="mr-1 size-4" />
      {t(archived ? 'sessions.sidebar.bulkActions.restore' : 'sessions.sidebar.bulkActions.archive')}
    </Item>
  );
}

import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SessionMenuItemHint } from '@/components/session/SessionMenuItemHint';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isRestorableOnItsOwn } from '@/sync/session-restore-rule';
import type { SessionTabMenuComponents } from './SessionTabsStrip';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useUIStore } from '@/stores/useUIStore';

export function HeaderSessionArchiveMenuItem({ sessionId, onArchive, Item }: {
  sessionId: string;
  onArchive: () => void;
  Item: SessionTabMenuComponents['Item'];
}) {
  const { t } = useI18n();
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const isCurrentSession = useSessionUIStore((state) => state.currentSessionId === sessionId);
  const archiveShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('archive_current_session', shortcutOverrides), '');
  const archived = useGlobalSessionsStore((state) => Boolean(state.entityById.get(sessionId)?.time.archived));
  const restorable = useGlobalSessionsStore((state) => {
    const session = state.entityById.get(sessionId);
    return !session || isRestorableOnItsOwn(session, state.entityById);
  });
  const unarchiveSession = useSessionUIStore((state) => state.unarchiveSession);

  const restore = async () => {
    const success = await unarchiveSession(sessionId);
    if (success) {
      toast.success(t('sessions.sidebar.session.restore.success'));
    } else {
      toast.error(t('sessions.sidebar.session.restore.error'));
    }
  };

  // A subsession under an archived parent comes back only with that parent.
  if (archived && !restorable) return null;

  return (
    <SessionMenuItemHint hint={t(archived ? 'sessions.sidebar.session.menuHint.restore' : 'sessions.sidebar.session.menuHint.archive')}>
      <Item onClick={archived ? () => void restore() : onArchive}>
        <Icon name={archived ? 'inbox-unarchive' : 'inbox-archive'} className="me-1 size-4" />
        {t(archived ? 'sessions.sidebar.bulkActions.restore' : 'sessions.sidebar.bulkActions.archive')}
        {!archived && isCurrentSession && archiveShortcut ? <span className="ms-auto ps-3 typography-meta text-muted-foreground">{archiveShortcut}</span> : null}
      </Item>
    </SessionMenuItemHint>
  );
}

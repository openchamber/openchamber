import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SessionMenuItemHint } from '@/components/session/SessionMenuItemHint';
import { useI18n } from '@/lib/i18n';
import { formatShortcutForDisplay } from '@/lib/shortcuts';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { canSessionBeUnread, useSessionUnread } from '@/sync/session-unread';
import { toggleSessionRead } from './sessionReadActions';

/**
 * Mark as read / Mark as unread in a session's menu. Only top-level,
 * unarchived sessions carry an unread mark, so other sessions show nothing.
 */
export function SessionReadMenuItem({ sessionId, Item, className, iconClassName = 'me-1 size-4', showShortcut = true }: {
  sessionId: string;
  Item: React.ElementType;
  className?: string;
  iconClassName?: string;
  /** Alt+click on the row does the same; touch menus leave it out. */
  showShortcut?: boolean;
}) {
  const { t } = useI18n();
  const unread = useSessionUnread(sessionId);
  const available = useGlobalSessionsStore(React.useCallback(
    (state) => canSessionBeUnread(state.entityById.get(sessionId)),
    [sessionId],
  ));
  if (!available) return null;

  return (
    <SessionMenuItemHint hint={unread ? t('sessions.sidebar.session.menuHint.markRead') : t('sessions.sidebar.session.menuHint.markUnread')}>
      <Item onClick={() => toggleSessionRead(sessionId, unread, t)} className={className}>
        <Icon name={unread ? 'chat-check' : 'checkbox-circle'} className={iconClassName} />
        {unread ? t('sessions.sidebar.session.menu.markRead') : t('sessions.sidebar.session.menu.markUnread')}
        {showShortcut ? <SessionReadShortcut /> : null}
      </Item>
    </SessionMenuItemHint>
  );
}

/** "⌥ + Click" after the item: Alt+click on a row or tab toggles the mark. */
export function SessionReadShortcut() {
  const { t } = useI18n();
  return (
    <span className="ms-auto ps-3 typography-meta text-muted-foreground">
      {t('sessions.sidebar.session.menu.markUnreadShortcut', { modifier: formatShortcutForDisplay('alt', '') })}
    </span>
  );
}

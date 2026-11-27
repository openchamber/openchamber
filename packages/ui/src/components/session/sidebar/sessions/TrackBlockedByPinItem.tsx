import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { SessionMenuItemHint } from '../../SessionMenuItemHint';
import type { SessionMenuSlots } from './sessionMenuSlots';

export function TrackBlockedByPinItem({ Item, touch }: { Item: SessionMenuSlots['Item']; touch: boolean }): React.ReactNode {
  const { t } = useI18n();
  const item = (
    <Item disabled className="[&>svg]:me-1">
      <Icon name="eye" className="me-1 h-4 w-4" />
      <span className="flex min-w-0 max-w-64 flex-col">
        <span>{t('sessions.sidebar.session.work.track')}</span>
        {touch ? <span className="typography-micro whitespace-normal">{t('sessions.sidebar.session.menuHint.trackPinnedTouch')}</span> : null}
      </span>
    </Item>
  );
  if (touch) return item;
  return (
    <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.trackPinned')}>
      <span className="block">{item}</span>
    </SessionMenuItemHint>
  );
}

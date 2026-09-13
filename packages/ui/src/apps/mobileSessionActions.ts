import type { IconName } from '@/components/icon/icons';
import type { I18nKey, I18nParams } from '@/lib/i18n';

export interface MobileSessionActionItem {
  id: 'pin' | 'unpin' | 'rename' | 'archive' | 'delete';
  icon: IconName;
  labelKey: I18nKey;
  labelParams?: I18nParams;
  destructive?: boolean;
}

export interface BuildMobileSessionActionItemsArgs {
  isPinned: boolean;
  confirmDelete: boolean;
  title: string;
}

export const buildMobileSessionActionItems = ({
  isPinned,
  confirmDelete,
  title,
}: BuildMobileSessionActionItemsArgs): MobileSessionActionItem[] => {
  const items: MobileSessionActionItem[] = [];

  if (isPinned) {
    items.push({
      id: 'unpin',
      icon: 'unpin',
      labelKey: 'sessions.sidebar.session.menu.unpin',
    });
  } else {
    items.push({
      id: 'pin',
      icon: 'pushpin',
      labelKey: 'sessions.sidebar.session.menu.pin',
    });
  }

  items.push({
    id: 'rename',
    icon: 'pencil-ai',
    labelKey: 'sessions.sidebar.session.menu.rename',
  });

  items.push({
    id: 'archive',
    icon: 'inbox-archive',
    labelKey: 'sessions.sidebar.bulkActions.archive',
  });

  if (confirmDelete) {
    items.push({
      id: 'delete',
      icon: 'delete-bin',
      labelKey: 'mobile.sessions.confirmDeleteSessionAria',
      labelParams: { title },
      destructive: true,
    });
  } else {
    items.push({
      id: 'delete',
      icon: 'delete-bin',
      labelKey: 'sessions.sidebar.bulkActions.delete',
      destructive: true,
    });
  }

  return items;
};
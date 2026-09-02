import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { openSessionFromToast } from '@/sync/session-navigation';
import {
  type NotificationRecord,
  type NotificationSeverity,
} from '@/sync/notification-record';
import { useNotificationStore } from '@/sync/notification-store';
import { stabilizeInboxOrder, useInboxNotifications, useInboxUnreadCount } from '@/sync/notification-inbox';
import { displaySessionNotificationBody, usableSessionNotificationTitle } from '@/sync/notification-session-context';
import { getAllSyncSessionMap } from '@/sync/sync-refs';
import { toast } from '@/components/ui/toast';

const severityIcon = {
  error: 'error-warning',
  warning: 'alert',
  info: 'information',
  success: 'checkbox-circle',
} as const satisfies Record<NotificationSeverity, 'error-warning' | 'alert' | 'information' | 'checkbox-circle'>;

const severityClass = {
  error: 'text-[var(--status-error)]',
  warning: 'text-[var(--status-warning)]',
  info: 'text-[var(--status-info)]',
  success: 'text-[var(--status-success)]',
} as const satisfies Record<NotificationSeverity, string>;

const formatRelativeTime = (
  timestamp: number,
  t: ReturnType<typeof useI18n>['t'],
): string => {
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return t('layout.notifications.time.justNow');
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return t('layout.notifications.time.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('layout.notifications.time.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  return t('layout.notifications.time.daysAgo', { count: days });
};

const displayTitle = (notification: NotificationRecord, t: ReturnType<typeof useI18n>['t']): string => {
  if (notification.source === 'subtask') {
    return notification.severity === 'error'
      ? t('layout.notifications.sessionSubtaskError')
      : t('layout.notifications.sessionSubtaskFinished');
  }
  if (notification.source === 'session') {
    return notification.severity === 'error'
      ? t('layout.notifications.sessionError')
      : t('layout.notifications.sessionFinished');
  }
  return notification.title;
};

const displayBody = (notification: NotificationRecord, untitled: string): string => {
  if (notification.source !== 'session' && notification.source !== 'subtask') {
    return notification.body;
  }
  const liveTitle = usableSessionNotificationTitle(
    notification.session ? getAllSyncSessionMap().get(notification.session)?.title : undefined,
    notification.session,
  );
  return displaySessionNotificationBody(notification.body, notification.session, liveTitle, untitled);
};

const dismissToasts = (ids: readonly string[]): void => {
  for (const id of ids) toast.dismiss(id);
};

type NotificationCenterProps = {
  variant: 'dropdown' | 'dialog';
  triggerClassName?: string;
  iconClassName?: string;
  onOpenSettings?: () => void;
};

const NotificationBellButton = React.forwardRef<HTMLButtonElement, {
  className?: string;
  iconClassName?: string;
  unreadCount: number;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
}>(({ className, iconClassName, unreadCount, onClick }, ref) => {
  const { t } = useI18n();
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={className}
      aria-label={unreadCount > 0
        ? t('layout.notifications.unreadCountAria', { count: unreadCount })
        : t('layout.notifications.openAria')}
      title={t('layout.notifications.openTitle')}
    >
      <span className="relative inline-flex overflow-visible">
        <Icon name="notification-3" className={iconClassName ?? 'h-[18px] w-[18px]'} />
        {unreadCount > 0 ? (
          <span
            className="absolute -right-1 -top-1 size-2 rounded-full bg-[var(--status-info)]"
            aria-hidden="true"
          />
        ) : null}
      </span>
    </button>
  );
});
NotificationBellButton.displayName = 'NotificationBellButton';

const NotificationList = ({
  onClose,
  onOpenSettings,
}: {
  onClose: () => void;
  onOpenSettings?: () => void;
}): React.ReactElement => {
  const { t } = useI18n();
  const items = useInboxNotifications();
  const storedCount = useNotificationStore((state) => state.list.length);
  const markRead = useNotificationStore((state) => state.markRead);
  const markAllRead = useNotificationStore((state) => state.markAllRead);
  const clearAll = useNotificationStore((state) => state.clearAll);
  const orderRef = React.useRef<string[]>([]);
  const listRef = React.useRef<HTMLDivElement>(null);
  const pendingScrollTopRef = React.useRef<number | null>(null);
  const displayItems = React.useMemo(() => {
    const next = stabilizeInboxOrder(orderRef.current, items);
    orderRef.current = next.map((item) => item.id);
    return next;
  }, [items]);
  const unreadIds = displayItems.filter((item) => !item.read).map((item) => item.id);

  React.useLayoutEffect(() => {
    const scrollTop = pendingScrollTopRef.current;
    const listEl = listRef.current;
    if (scrollTop == null || !listEl) return;
    listEl.scrollTop = scrollTop;
    pendingScrollTopRef.current = null;
  });

  const handleMarkAllRead = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (unreadIds.length === 0) return;
    pendingScrollTopRef.current = listRef.current?.scrollTop ?? 0;
    markAllRead(unreadIds);
    dismissToasts(unreadIds);
  };

  const handleClearAll = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const stored = useNotificationStore.getState().list;
    if (stored.length === 0) return;
    dismissToasts(stored.map((item) => item.id));
    clearAll();
  };

  const handleOpenSettings = () => {
    if (onOpenSettings) {
      onOpenSettings();
    } else {
      useUIStore.getState().setSettingsPage('notifications');
      useUIStore.getState().setSettingsDialogOpen(true);
    }
    onClose();
  };

  const handleRow = (notification: NotificationRecord) => {
    markRead(notification.id);
    if (notification.action?.type === 'open-session') {
      openSessionFromToast(notification.action.sessionId, notification.action.directory);
    } else if (notification.session && notification.directory) {
      openSessionFromToast(notification.session, notification.directory);
    }
    onClose();
  };

  return (
    <div className="flex max-h-[min(28rem,70vh)] flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <p className="typography-ui-label font-medium text-foreground">{t('layout.notifications.title')}</p>
        <div className="flex items-center gap-0.5">
          {storedCount > 0 ? (
            <>
              {displayItems.length > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={unreadIds.length === 0}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={handleMarkAllRead}
                  aria-label={t('layout.notifications.markAllRead')}
                  title={t('layout.notifications.markAllRead')}
                >
                  <Icon name="check-double" className="size-4" />
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                onPointerDown={(event) => event.preventDefault()}
                onClick={handleClearAll}
                aria-label={t('layout.notifications.clearAll')}
                title={t('layout.notifications.clearAll')}
              >
                <Icon name="delete-bin" className="size-4" />
              </Button>
            </>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={handleOpenSettings}
            aria-label={t('layout.notifications.openSettings')}
            title={t('layout.notifications.openSettings')}
          >
            <Icon name="settings-3" className="size-4" />
          </Button>
        </div>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
        {items.length === 0 ? (
          <p className="px-3 py-6 typography-meta text-muted-foreground">
            {storedCount > 0
              ? t('layout.notifications.emptyFiltered')
              : t('layout.notifications.empty')}
          </p>
        ) : (
          <ul className="flex flex-col pb-1">
            {displayItems.map((notification) => {
              const body = displayBody(notification, t('sessions.sidebar.session.untitled'));
              return (
              <li key={notification.id}>
                <button
                  type="button"
                  onClick={() => handleRow(notification)}
                  className={cn(
                    'flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-interactive-hover',
                    !notification.read && 'bg-[color-mix(in_srgb,var(--status-info)_8%,transparent)]',
                  )}
                >
                  <Icon
                    name={severityIcon[notification.severity]}
                    className={cn('mt-0.5 size-4 shrink-0', severityClass[notification.severity])}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-start justify-between gap-2">
                      <span className="typography-ui-label text-foreground">
                        {displayTitle(notification, t)}
                        {notification.count > 1 ? (
                          <span className="ml-1 text-muted-foreground">
                            {t('layout.notifications.occurrenceCount', { count: notification.count })}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 typography-micro text-muted-foreground">
                        {formatRelativeTime(notification.time, t)}
                      </span>
                    </span>
                    {body ? (
                      <span className="mt-0.5 line-clamp-2 block typography-meta text-muted-foreground">
                        {body}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

export const NotificationCenter: React.FC<NotificationCenterProps> = ({
  variant,
  triggerClassName,
  iconClassName,
  onOpenSettings,
}) => {
  const [open, setOpen] = React.useState(false);
  const unreadCount = useInboxUnreadCount();
  const inboxEnabled = useUIStore((state) => state.notificationInboxEnabled !== false);
  const { t } = useI18n();

  React.useEffect(() => {
    if (!inboxEnabled) setOpen(false);
  }, [inboxEnabled]);

  if (!inboxEnabled) return null;
  const trigger = (
    <NotificationBellButton
      className={triggerClassName}
      iconClassName={iconClassName}
      unreadCount={unreadCount}
    />
  );

  if (variant === 'dialog') {
    return (
      <>
        <NotificationBellButton
          className={triggerClassName}
          iconClassName={iconClassName}
          unreadCount={unreadCount}
          onClick={() => setOpen(true)}
        />
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-md gap-0 p-0" showCloseButton>
            <DialogHeader className="sr-only">
              <DialogTitle>{t('layout.notifications.title')}</DialogTitle>
            </DialogHeader>
            {open ? (
              <NotificationList
                onClose={() => setOpen(false)}
                onOpenSettings={onOpenSettings}
              />
            ) : null}
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false} disableGlobalShortcuts>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-[360px] max-w-[calc(100vw-32px)] overflow-hidden p-0">
        {open ? (
          <NotificationList
            onClose={() => setOpen(false)}
            onOpenSettings={onOpenSettings}
          />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

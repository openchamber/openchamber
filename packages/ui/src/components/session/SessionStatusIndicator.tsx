import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type SessionDisplayStatusType = 'idle' | 'busy' | 'retry' | 'reconnecting';

export type SessionStatusIndicatorProps = {
  /** The derived presentation status from useSessionDisplayStatus().type */
  statusType: SessionDisplayStatusType;
  /** Size variant: 'sm' for switcher/dropdown (h-1.5 dots), 'md' for sidebar, 'lg' for agent-manager. Defaults to 'sm'. */
  size?: 'sm' | 'md' | 'lg';
  /** Whether to show the unread dot when status is idle. When false, idle renders nothing. */
  showUnread?: boolean;
  /** CSS class for the container span */
  className?: string;
};

const DOT_SIZE_CLASS = {
  sm: 'h-1.5 w-1.5',
  md: 'h-1.5 w-1.5',
  lg: 'h-2 w-2',
} satisfies Record<NonNullable<SessionStatusIndicatorProps['size']>, string>;

const ICON_SIZE_CLASS = {
  sm: 'h-3 w-3',
  md: 'h-3 w-3',
  lg: 'h-2 w-2',
} satisfies Record<NonNullable<SessionStatusIndicatorProps['size']>, string>;

/**
 * Owns the session-status → visual presentation contract.
 *
 * Receives the already-derived display status type (from
 * `useSessionDisplayStatus().type`) and renders the correct indicator:
 *
 *   busy/retry        -> animated pulse dot, "Session active"
 *   reconnecting      -> static cloud-off icon, "Reconnecting…" (NO animation)
 *   idle + showUnread -> static info dot, "Unread updates"
 *   idle + !showUnread -> null
 *
 * The visible dot/icon is exposed through `role="img"` so its accessible name
 * is actually announced; `Icon` is always `aria-hidden`, so the reconnecting
 * wrapper carries the name instead. Busy and reconnecting stay visually and
 * semantically distinct: preserved busy/retry data must never read as a
 * confirmed active pulse while its directory status is unavailable.
 */
export function SessionStatusIndicator({
  statusType,
  size = 'sm',
  showUnread = false,
  className,
}: SessionStatusIndicatorProps): React.ReactElement | null {
  const { t } = useI18n();

  if (statusType === 'busy' || statusType === 'retry') {
    const label = t('sessions.sidebar.session.status.active');
    return (
      <span className={cn('inline-flex items-center', className)}>
        <span
          role="img"
          className={cn('rounded-full bg-primary animate-busy-pulse', DOT_SIZE_CLASS[size])}
          aria-label={label}
          title={label}
        />
      </span>
    );
  }

  if (statusType === 'reconnecting') {
    // Static (no animation): preserved busy/retry data must not be presented as
    // a confirmed active pulse while `type === 'reconnecting'`. The Icon is
    // aria-hidden; the wrapper `<span>` owns the accessible name.
    const label = t('sessions.sidebar.session.status.reconnecting');
    return (
      <span className={cn('inline-flex items-center', className)}>
        <span
          role="img"
          className={cn('inline-flex items-center text-muted-foreground/70', ICON_SIZE_CLASS[size])}
          aria-label={label}
          title={label}
        >
          <Icon name="cloud-off" className={ICON_SIZE_CLASS[size]} />
        </span>
      </span>
    );
  }

  // idle
  if (!showUnread) {
    return null;
  }

  const label = t('sessions.sidebar.session.status.unread');
  return (
    <span className={cn('inline-flex items-center', className)}>
      <span
        role="img"
        className={cn('rounded-full bg-[var(--status-info)]', DOT_SIZE_CLASS[size])}
        aria-label={label}
        title={label}
      />
    </span>
  );
}

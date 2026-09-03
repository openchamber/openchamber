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

const DOT_SIZE_CLASS: Record<NonNullable<SessionStatusIndicatorProps['size']>, string> = {
  sm: 'h-1.5 w-1.5',
  md: 'h-1.5 w-1.5',
  lg: 'h-2 w-2',
};

const ICON_SIZE_CLASS: Record<NonNullable<SessionStatusIndicatorProps['size']>, string> = {
  sm: 'h-3 w-3',
  md: 'h-3 w-3',
  lg: 'h-2 w-2',
};

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
 * The `Icon` component always emits `aria-hidden="true"`, so the reconnecting
 * state wraps the icon in a `<span>` that carries the accessible name, the same
 * pattern `SessionNodeItem.tsx` uses for `sessionGoalGlyph`. The dot states
 * carry `aria-label`/`title` directly on the `<span>` dot.
 */
export function SessionStatusIndicator({
  statusType,
  size = 'sm',
  showUnread = false,
  className,
}: SessionStatusIndicatorProps): React.ReactElement | null {
  const { t } = useI18n();

  if (statusType === 'busy' || statusType === 'retry') {
    return (
      <span className={className}>
        <span
          className={cn('rounded-full bg-primary animate-busy-pulse', DOT_SIZE_CLASS[size])}
          aria-label={t('sessions.sidebar.session.status.active')}
          title={t('sessions.sidebar.session.status.active')}
        />
      </span>
    );
  }

  if (statusType === 'reconnecting') {
    // Static (no animation): preserved busy/retry data must not be presented as
    // a confirmed active pulse while `type === 'reconnecting'`. The Icon is
    // aria-hidden; the wrapper `<span>` owns the accessible name.
    return (
      <span className={className}>
        <span
          className={cn('inline-flex items-center text-muted-foreground/70', ICON_SIZE_CLASS[size])}
          aria-label={t('sessions.sidebar.session.status.reconnecting')}
          title={t('sessions.sidebar.session.status.reconnecting')}
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

  return (
    <span className={className}>
      <span
        className={cn('rounded-full bg-[var(--status-info)]', DOT_SIZE_CLASS[size])}
        aria-label={t('sessions.sidebar.session.status.unread')}
        title={t('sessions.sidebar.session.status.unread')}
      />
    </span>
  );
}
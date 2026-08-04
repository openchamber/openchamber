import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';

import { Icon } from '@/components/icon/Icon';
import { useSwitcherItems } from '@/components/session/sidebar/hooks/useSwitcherItems';
import { formatSessionCompactDateLabel } from '@/components/session/sidebar/utils';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { useGlobalSessionStatus } from '@/sync/sync-context';

const getSessionTitle = (session: Session, fallback: string): string =>
  session.title?.trim() || fallback;

/** One switcher row: live status (busy spinner / attention dot), title,
    "project · branch", compact time. Mirrors the desktop SessionSwitcherDropdown
    indicator conventions; no subsession chevrons on mobile by design. */
const SwitcherRow: React.FC<{
  session: Session;
  meta: string;
  active: boolean;
  onSelect: () => void;
}> = ({ session, meta, active, onSelect }) => {
  const { t } = useI18n();
  const status = useGlobalSessionStatus(session.id);
  const unseenCount = useSessionUnseenCount(session.id);
  const statusType = status?.type ?? 'idle';
  const isStreaming = statusType === 'busy' || statusType === 'retry';
  const showUnreadDot = !isStreaming && unseenCount > 0 && !active;
  const timeLabel = formatSessionCompactDateLabel(session.time?.updated ?? session.time?.created ?? 0);

  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
        active && 'bg-interactive-selection',
      )}
      onClick={onSelect}
      style={{ touchAction: 'manipulation' }}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('block truncate typography-ui-label', active ? 'text-interactive-selection-foreground' : 'text-foreground')}>
          {getSessionTitle(session, t('sessions.sidebar.session.untitled'))}
        </span>
        {meta ? (
          <span className="block truncate typography-micro text-muted-foreground">{meta}</span>
        ) : null}
      </span>
      {/* Activity sits on the right, before the time — no reserved left gutter. */}
      {isStreaming ? (
        <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
      ) : showUnreadDot ? (
        <span className="size-1.5 shrink-0 rounded-full bg-[var(--status-info)]" aria-hidden />
      ) : null}
      {timeLabel ? (
        <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">{timeLabel}</span>
      ) : null}
    </button>
  );
};

export const MobileRecentSessionsList: React.FC<{
  enabled: boolean;
  limit: number;
  currentSessionId: string | null;
  emptyLabel: string;
  onSelectSession: (session: Session, projectId: string | null) => void;
}> = ({ enabled, limit, currentSessionId, emptyLabel, onSelectSession }) => {
  const items = useSwitcherItems(enabled, { maxParents: limit });

  if (items.length === 0) {
    return (
      <p className="px-3 py-6 text-center typography-small text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }

  return (
    <>
      {items.map((item) => {
        const session = item.node.session;
        const meta = [item.secondaryMeta?.projectLabel, item.secondaryMeta?.branchLabel]
          .filter(Boolean)
          .join(' · ');
        return (
          <SwitcherRow
            key={session.id}
            session={session}
            meta={meta}
            active={session.id === currentSessionId}
            onSelect={() => onSelectSession(session, item.projectId ?? null)}
          />
        );
      })}
    </>
  );
};

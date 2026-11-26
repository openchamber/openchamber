import React from 'react';
import { useSessionTurnActivity } from '@/sync/global-session-status';
import { getSessionActivityTime } from '@/sync/session-ordering';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import type { Session } from '@/lib/opencode/model';

import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { formatSessionCompactDateLabel } from '@/components/session/sidebar/utils';
import { useSwitcherItems } from '@/components/session/sidebar/shell/useSwitcherItems';
import { useTabletLayout } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { refreshGlobalSessionsWhenShown, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS } from '@/hooks/useGlobalSessionsPolling';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionMarkedUnread, useSessionUnread } from '@/sync/session-unread';
import { useHasSessionTurnDuration } from '@/sync/session-turn-duration';
import { useSessionUIStore } from '@/sync/session-ui-store';

const RECENT_SESSIONS_LIMIT = 10;
const TABLET_POPOVER_WIDTH = 380;

const getSessionTitle = (session: Session, fallback: string): string =>
  session.title?.trim() || fallback;

const SwitcherRow: React.FC<{
  session: Session;
  meta: string;
  active: boolean;
  onSelect: () => void;
}> = ({ session, meta, active, onSelect }) => {
  const { t } = useI18n();
  const isUnread = useSessionUnread(session.id);
  const markedUnread = useSessionMarkedUnread(session.id);
  const turnActivity = useSessionTurnActivity(session.id);
  const isStreaming = turnActivity !== null;
  const showUnreadDot = !isStreaming && isUnread && (!active || markedUnread);
  const hasActivityDuration = useHasSessionTurnDuration(session.id, isStreaming);
  const showActivityDuration = (isStreaming || showUnreadDot) && hasActivityDuration;
  const timeLabel = formatSessionCompactDateLabel(getSessionActivityTime(session));

  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-start transition-colors active:bg-interactive-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        active && 'bg-interactive-selection text-interactive-selection-foreground',
      )}
      onClick={onSelect}
      style={{ touchAction: 'manipulation' }}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span dir="auto" className={cn('block truncate oc-ui-start-align typography-ui-label', !active && 'text-foreground')}>
          {getSessionTitle(session, t('sessions.sidebar.session.untitled'))}
        </span>
        {meta ? (
          <span className="block truncate typography-micro text-muted-foreground">{meta}</span>
        ) : null}
      </span>
      {isStreaming || showUnreadDot ? (
        <SessionActivityIndicator
          state={turnActivity ?? 'unread'}
        />
      ) : null}
      {showActivityDuration ? (
        <SessionActivityDuration
          sessionId={session.id}
          running={isStreaming}
          className="typography-micro"
        />
      ) : timeLabel ? (
        <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">{timeLabel}</span>
      ) : null}
    </button>
  );
};

export const MobileSessionSwitcher: React.FC<{
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}> = ({ open, onClose, anchorRef }) => {
  const { t } = useI18n();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [shouldRender, setShouldRender] = React.useState(open);
  const [isExiting, setIsExiting] = React.useState(false);
  const { enabled: isTabletLayout } = useTabletLayout();
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const [anchorLeft, setAnchorLeft] = React.useState<number | null>(null);

  React.useLayoutEffect(() => {
    if (!open || !isTabletLayout || !shouldRender) return;
    const compute = () => {
      const anchorRect = anchorRef.current?.getBoundingClientRect();
      const wrapperRect = wrapperRef.current?.getBoundingClientRect();
      if (!anchorRect || !wrapperRect) {
        setAnchorLeft(null);
        return;
      }
      const relativeLeft = anchorRect.left - wrapperRect.left;
      setAnchorLeft(Math.min(
        Math.max(relativeLeft, 8),
        Math.max(8, wrapperRect.width - TABLET_POPOVER_WIDTH - 8),
      ));
    };
    compute();
    const wrapper = wrapperRef.current;
    if (typeof ResizeObserver === 'undefined' || !wrapper) return;
    const observer = new ResizeObserver(compute);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [anchorRef, isTabletLayout, open, shouldRender]);

  const isPopover = isTabletLayout && anchorLeft !== null;
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);

  const items = useSwitcherItems(open || shouldRender, { maxParents: RECENT_SESSIONS_LIMIT, ignorePins: true, currentSessionId });

  React.useEffect(() => {
    if (open) {
      void refreshGlobalSessionsWhenShown(GLOBAL_SESSIONS_FULL_REFRESH_INTERVAL_MS);
      setShouldRender(true);
      setIsExiting(false);
      return;
    }
    if (!shouldRender) return;
    setIsExiting(true);
    const timeoutId = window.setTimeout(() => {
      setShouldRender(false);
      setIsExiting(false);
    }, 140);
    return () => window.clearTimeout(timeoutId);
  }, [open, shouldRender]);

  React.useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, open]);

  React.useEffect(() => {
    if (!open) return;
    const closeIfOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        onClose();
        return;
      }
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', closeIfOutside, true);
    return () => document.removeEventListener('pointerdown', closeIfOutside, true);
  }, [anchorRef, onClose, open]);

  const handleSelect = React.useCallback((session: Session) => {
    void setCurrentSession(session.id, resolveGlobalSessionDirectory(session));
    onClose();
  }, [onClose, setCurrentSession]);

  if (!shouldRender) return null;

  return (
    <div ref={wrapperRef} className="oc-side-safe-area fixed inset-x-0 bottom-0 top-[calc(var(--oc-safe-area-top,0px)+var(--oc-header-height,56px))] z-30 pointer-events-none">
      <div
        ref={panelRef}
        role="dialog"
        aria-label={t('sessions.switcher.openAria')}
        className={cn(
          'oc-surface-elevated flex flex-col overflow-hidden rounded-[20px] border border-edge bg-surface-elevated p-2 shadow-[0_4px_12px_rgb(0_0_0_/_0.08)] will-change-transform',
          isPopover ? 'absolute origin-top-left' : 'mx-3 mt-2',
          isExiting ? 'pointer-events-none' : 'pointer-events-auto',
        )}
        style={{
          animation: `${isExiting ? 'session-switcher-out' : 'session-switcher-in'} ${isExiting ? 140 : 170}ms cubic-bezier(0.32, 0.72, 0, 1) forwards`,
          maxHeight: 'min(72dvh, calc(100dvh - var(--oc-safe-area-top, 0px) - var(--oc-header-height, 56px) - 1rem))',
          ...(isPopover
            ? {
                top: 8,
                left: anchorLeft ?? 8,
                width: `min(${TABLET_POPOVER_WIDTH}px, calc(100% - 16px))`,
              }
            : null),
        }}
      >
        <div className="oc-hide-scrollbar min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center typography-small text-muted-foreground">
              {t('sessions.switcher.empty')}
            </p>
          ) : (
            items.map((item) => {
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
                  onSelect={() => {
                    if (item.projectId) setActiveProjectIdOnly(item.projectId);
                    handleSelect(session);
                  }}
                />
              );
            })
          )}
        </div>
      </div>
      <style>{`
        @keyframes session-switcher-in {
          from { opacity: 0; transform: translateY(-8px) scale(0.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes session-switcher-out {
          from { opacity: 1; transform: translateY(0) scale(1); }
          to { opacity: 0; transform: translateY(-6px) scale(0.985); }
        }
      `}</style>
    </div>
  );
};

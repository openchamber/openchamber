import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';

import { Icon } from '@/components/icon/Icon';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { formatSessionCompactDateLabel } from '@/components/session/sidebar/utils';
import { useSwitcherItems, type SwitcherItem } from '@/components/session/sidebar/hooks/useSwitcherItems';
import { toast } from '@/components/ui';
import { useTabletLayout } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { collectSessionNodeDescendantIds } from '@/apps/mobileSessionArchive';
import { refreshGlobalSessions, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { useHasSessionActivityDuration } from '@/sync/session-activity-timing';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionStatus } from '@/sync/sync-context';

const RECENT_SESSIONS_LIMIT = 10;
/** Matches the metadata popover's width so both header dropdowns read as a pair. */
const TABLET_POPOVER_WIDTH = 380;

const getSessionTitle = (session: Session, fallback: string): string =>
  session.title?.trim() || fallback;

/** One switcher row: live status (busy spinner / attention dot), title,
    "project · branch", compact time. Mirrors the desktop SessionSwitcherDropdown
    indicator conventions; no subsession chevrons on mobile by design. The
    archive affordance is a SIBLING of the select button — tapping it never
    selects the session — and uses the two-step pattern from the sessions
    drawer: the first tap arms a destructive confirm chip, the second tap on
    the chip archives; the armed icon button (X) or any row selection cancels. */
const SwitcherRow: React.FC<{
  session: Session;
  meta: string;
  active: boolean;
  onSelect: () => void;
  confirmingArchive?: boolean;
  onRequestArchive?: () => void;
  onConfirmArchive?: () => void;
}> = ({ session, meta, active, onSelect, confirmingArchive = false, onRequestArchive, onConfirmArchive }) => {
  const { t } = useI18n();
  const status = useGlobalSessionStatus(session.id);
  const unseenCount = useSessionUnseenCount(session.id);
  const statusType = status?.type ?? 'idle';
  const isStreaming = statusType === 'busy' || statusType === 'retry';
  const showUnreadDot = !isStreaming && unseenCount > 0 && !active;
  const hasActivityDuration = useHasSessionActivityDuration(session.id, isStreaming);
  const showActivityDuration = (isStreaming || showUnreadDot) && hasActivityDuration;
  const timeLabel = formatSessionCompactDateLabel(session.time?.updated ?? session.time?.created ?? 0);
  const title = getSessionTitle(session, t('sessions.sidebar.session.untitled'));
  const archiveEnabled = Boolean(onRequestArchive && onConfirmArchive);

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className={cn(
          'flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
          active && 'bg-[color-mix(in_srgb,var(--primary)_10%,transparent)]',
        )}
        onClick={onSelect}
        style={{ touchAction: 'manipulation' }}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn('block truncate typography-ui-label', active ? 'text-primary' : 'text-foreground')}>
            {title}
          </span>
          {meta ? (
            <span className="block truncate typography-micro text-muted-foreground">{meta}</span>
          ) : null}
        </span>
        {/* Activity sits on the right, before the time — no reserved left gutter. */}
        {isStreaming || showUnreadDot ? (
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              isStreaming ? 'bg-primary' : 'bg-[var(--status-info)]',
            )}
            aria-hidden
          />
        ) : null}
        {/* The elapsed turn takes the time slot while it matters, then hands it
            back to the relative timestamp. */}
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
      {archiveEnabled ? (
        <>
          {confirmingArchive ? (
            <button
              type="button"
              className="mr-1.5 flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-destructive px-3 text-destructive-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
              aria-label={t('mobile.sessions.archiveSessionAria', { title })}
              onClick={onConfirmArchive}
              style={{ touchAction: 'manipulation' }}
            >
              <Icon name="archive" className="size-4" />
              <span className="typography-ui-label">{t('sessions.sidebar.bulkActions.archive')}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="mr-1.5 flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground/70 transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={confirmingArchive
              ? t('mobile.sessions.cancelArchiveAria', { title })
              : t('mobile.sessions.archiveSessionAria', { title })}
            onClick={onRequestArchive}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name={confirmingArchive ? 'close' : 'archive'} className="size-4" />
          </button>
        </>
      ) : null}
    </div>
  );
};

/** Recent-sessions popover under the mobile header, opened by tapping the
    session title. Same visual family as the metadata/usage overlay. */
export const MobileSessionSwitcher: React.FC<{
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}> = ({ open, onClose, anchorRef }) => {
  const { t } = useI18n();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [shouldRender, setShouldRender] = React.useState(open);
  const [isExiting, setIsExiting] = React.useState(false);
  // Tablet: a phone-width sheet stretched across the whole chat column looks
  // broken — anchor a popover under the title instead. Mirror image of the
  // metadata/usage popover, which anchors to the ring on the right.
  const { enabled: isTabletLayout } = useTabletLayout();
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const [anchorLeft, setAnchorLeft] = React.useState<number | null>(null);

  // The shell has transformed ancestors, so the fixed wrapper's containing
  // block is the chat column, NOT the viewport — anchor in the wrapper's own
  // coordinate space (see SessionMetadataOverlay for the same reasoning).
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
    // Re-anchor if the chat column shifts while the popover is open (sidebar
    // toggle/resize, orientation change) — the header buttons move with it.
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
  const archiveSession = useSessionUIStore((state) => state.archiveSession);
  const archiveSessions = useSessionUIStore((state) => state.archiveSessions);
  // Two-step archive: which row's confirm chip is armed. Any selection or
  // panel close disarms it, so cancel leaves the session unchanged.
  const [confirmingArchiveId, setConfirmingArchiveId] = React.useState<string | null>(null);

  const items = useSwitcherItems(open || shouldRender, { maxParents: RECENT_SESSIONS_LIMIT });

  React.useEffect(() => {
    if (open) {
      // Fresh authoritative snapshot on open — updated stamps re-sort recents
      // (see raiseSessionOrderingBaselines) while the cached list shows first.
      void refreshGlobalSessions();
      setShouldRender(true);
      setIsExiting(false);
      return;
    }
    // Closing the panel cancels any armed archive confirmation.
    setConfirmingArchiveId(null);
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
    // Selecting a row cancels any armed archive confirmation.
    setConfirmingArchiveId(null);
    void setCurrentSession(session.id, resolveGlobalSessionDirectory(session));
    onClose();
  }, [onClose, setCurrentSession]);

  // First tap arms the row's confirm chip; tapping the armed icon (X) or
  // selecting the row disarms it. Archive never selects the session.
  const handleRequestArchive = React.useCallback((sessionId: string) => {
    setConfirmingArchiveId((current) => (current === sessionId ? null : sessionId));
  }, []);

  // Second tap: archive the session and its known active descendants through
  // the canonical batch action, keeping the existing per-result toasts so
  // partial failures stay visible. The global store reconciliation removes
  // the archived rows from this panel automatically.
  const handleConfirmArchive = React.useCallback(async (item: SwitcherItem) => {
    setConfirmingArchiveId(null);
    const descendantIds = collectSessionNodeDescendantIds(item.node);
    if (descendantIds.length === 0) {
      const ok = await archiveSession(item.node.session.id);
      if (ok) toast.success(t('sessions.sidebar.session.archive.success'));
      else toast.error(t('sessions.sidebar.session.archive.error'));
      return;
    }
    const { archivedIds, failedIds } = await archiveSessions([item.node.session.id, ...descendantIds]);
    if (archivedIds.length > 0) {
      toast.success(archivedIds.length === 1
        ? t('sessions.sidebar.bulkActions.archivedSingle', { count: archivedIds.length })
        : t('sessions.sidebar.bulkActions.archivedPlural', { count: archivedIds.length }));
    }
    if (failedIds.length > 0) {
      toast.error(failedIds.length === 1
        ? t('sessions.sidebar.bulkActions.failedArchiveSingle', { count: failedIds.length })
        : t('sessions.sidebar.bulkActions.failedArchivePlural', { count: failedIds.length }));
    }
  }, [archiveSession, archiveSessions, t]);

  if (!shouldRender) return null;

  return (
    <div ref={wrapperRef} className="fixed inset-x-0 bottom-0 top-[calc(var(--oc-safe-area-top,0px)+var(--oc-header-height,56px))] z-20 pointer-events-none">
      <div
        ref={panelRef}
        role="dialog"
        aria-label={t('sessions.switcher.openAria')}
        className={cn(
          'flex flex-col overflow-hidden rounded-[20px] border border-border/70 bg-[var(--surface-elevated)] p-2 shadow-[0_12px_32px_rgb(0_0_0_/_0.2)] will-change-transform',
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
                  confirmingArchive={confirmingArchiveId === session.id}
                  onRequestArchive={() => handleRequestArchive(session.id)}
                  onConfirmArchive={() => void handleConfirmArchive(item)}
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

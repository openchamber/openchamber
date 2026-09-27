import React from 'react';
import { RiArchiveLine, RiDeleteBinLine, RiEdit2Line } from '@remixicon/react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export const ROW_ACTION_SLOT_WIDTH = 48;

// Three slots every session row has: archive, delete and rename (AI renaming
// lives inside the rename editor). Top-level rows add one slot each for Pin
// and Track / Done (while the feature is on).
export const ROW_ACTIONS_WIDTH = 3 * ROW_ACTION_SLOT_WIDTH;

export type MobileSessionWorkAction = { inWork: boolean; onToggle: () => void };
export type MobileSessionPinAction = { pinned: boolean; onToggle: () => void };
const ROW_SWIPE_SNAP_MS = 180;

/** Generic swipe-right-to-reveal wrapper for drawer rows (sessions, projects,
    worktrees): horizontal intent detection, imperative transform during the
    drag, snap on release. The actions sit on the LEFT so the opposite
    direction stays free for the drawer's own close swipe. */
export const MobileSwipeActionsRow: React.FC<{
  actionsWidth: number;
  actions: React.ReactNode;
  revealed: boolean;
  onRevealedChange: (revealed: boolean) => void;
  /** Marks the row as the current session so the sheet's open-time
      auto-scroll can find it. */
  dataActiveSession?: boolean;
  /** Classes for the transformed content element. The default suits a plain
      header row; session rows pass their own layout and active background. */
  contentClassName?: string;
  children: React.ReactNode;
}> = ({
  actionsWidth,
  actions,
  revealed,
  onRevealedChange,
  dataActiveSession,
  contentClassName = 'relative flex w-full items-center bg-background',
  children,
}) => {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const startRef = React.useRef<{ x: number; y: number } | null>(null);
  const draggingRef = React.useRef(false);
  const offsetRef = React.useRef(0);
  const revealedRef = React.useRef(revealed);

  const applyOffset = React.useCallback((px: number, animate: boolean) => {
    const el = contentRef.current;
    if (!el) return;
    el.style.transition = animate ? `transform ${ROW_SWIPE_SNAP_MS}ms ease-out` : 'none';
    el.style.transform = px === 0 ? 'none' : `translateX(${px}px)`;
    offsetRef.current = px;
  }, []);

  React.useEffect(() => {
    revealedRef.current = revealed;
    applyOffset(revealed ? actionsWidth : 0, true);
  }, [actionsWidth, applyOffset, revealed]);

  const handleTouchStart = (event: React.TouchEvent) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    startRef.current = { x: touch.clientX, y: touch.clientY };
    draggingRef.current = false;
  };

  const handleTouchMove = (event: React.TouchEvent) => {
    if (!startRef.current) return;
    const touch = event.touches[0];
    const dx = touch.clientX - startRef.current.x;
    const dy = touch.clientY - startRef.current.y;
    if (!draggingRef.current) {
      if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
      draggingRef.current = true;
    }
    const base = revealedRef.current ? actionsWidth : 0;
    applyOffset(Math.max(0, Math.min(actionsWidth, base + dx)), false);
  };

  const handleTouchEnd = () => {
    startRef.current = null;
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const shouldReveal = offsetRef.current > actionsWidth / 2;
    applyOffset(shouldReveal ? actionsWidth : 0, true);
    if (shouldReveal !== revealedRef.current) onRevealedChange(shouldReveal);
  };

  return (
    <div
      data-active-session={dataActiveSession || undefined}
      className="relative overflow-hidden"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      // Vertical panning stays native; horizontal moves reach the swipe handler.
      style={{ touchAction: 'pan-y' }}
    >
      <div className="absolute inset-y-0 left-0 flex items-stretch" style={{ width: actionsWidth }} aria-hidden={!revealed}>
        {actions}
      </div>
      <div ref={contentRef} className={contentClassName}>
        {children}
      </div>
    </div>
  );
};

/** The session swipe actions, shared by every mobile session row. Ordered
    left to right by how often they are used on a phone: the leftmost slot is
    the one a short drag exposes first, so archive leads and the destructive
    delete never sits under a partial swipe. */
export const MobileSessionRowActions: React.FC<{
  title: string;
  revealed: boolean;
  confirmingDelete: boolean;
  onArchive?: () => void;
  onRequestDelete?: () => void;
  onConfirmDelete?: () => void;
  onRequestRename?: () => void;
  onRevealedChange?: (revealed: boolean) => void;
  /** Track / Done, when the feature is on and the row is a top-level session. */
  work?: MobileSessionWorkAction;
  /** Pin / Unpin, on top-level rows. */
  pin?: MobileSessionPinAction;
}> = ({
  title,
  revealed,
  confirmingDelete,
  onArchive,
  onRequestDelete,
  onConfirmDelete,
  onRequestRename,
  onRevealedChange,
  work,
  pin,
}) => {
  const { t } = useI18n();
  const tabIndex = revealed ? 0 : -1;

  return (
    <>
      {/* Icon-only actions on the row's own background — they read as the row
          extending to reveal extra controls, not a separate panel. */}
      <button
        type="button"
        tabIndex={tabIndex}
        className="flex flex-1 items-center justify-center text-muted-foreground transition-colors active:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={t('mobile.sessions.archiveSessionAria', { title })}
        onClick={onArchive}
        style={{ touchAction: 'manipulation' }}
      >
        <RiArchiveLine className="size-[18px]" />
      </button>
      {pin ? (
        <button
          type="button"
          tabIndex={tabIndex}
          className="flex flex-1 items-center justify-center text-muted-foreground transition-colors active:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-label={pin.pinned ? t('sessions.sidebar.session.menu.unpin') : t('sessions.sidebar.session.menu.pin')}
          onClick={() => { pin.onToggle(); onRevealedChange?.(false); }}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name={pin.pinned ? 'unpin' : 'pushpin'} className="size-[18px]" />
        </button>
      ) : null}
      {work ? (
        <button
          type="button"
          tabIndex={tabIndex}
          className={cn(
            'flex flex-1 items-center justify-center transition-colors active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            work.inWork ? 'text-status-success' : 'text-muted-foreground active:text-foreground',
          )}
          aria-label={work.inWork ? t('sessions.sidebar.session.work.markDone') : t('sessions.sidebar.session.work.track')}
          onClick={() => { work.onToggle(); onRevealedChange?.(false); }}
          style={{ touchAction: 'manipulation' }}
        >
          {/* The check glyph draws smaller than the others at the same box. */}
          <Icon name={work.inWork ? 'check' : 'eye'} className={work.inWork ? 'size-5' : 'size-[18px]'} />
        </button>
      ) : null}
      <button
        type="button"
        tabIndex={tabIndex}
        className={cn(
          'flex flex-1 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-destructive',
          confirmingDelete
            ? 'rounded-lg bg-destructive text-destructive-foreground'
            : 'text-[var(--status-error)] active:opacity-80',
        )}
        aria-label={confirmingDelete
          ? t('mobile.sessions.confirmDeleteSessionAria', { title })
          : t('mobile.sessions.deleteSessionAria', { title })}
        onClick={confirmingDelete ? onConfirmDelete : onRequestDelete}
        style={{ touchAction: 'manipulation' }}
      >
        <RiDeleteBinLine className="size-[18px]" />
      </button>
      <button
        type="button"
        tabIndex={tabIndex}
        className="flex flex-1 items-center justify-center text-muted-foreground transition-colors active:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={t('mobile.sessions.renameSessionAria', { title })}
        onClick={onRequestRename}
        style={{ touchAction: 'manipulation' }}
      >
        <RiEdit2Line className="size-[18px]" />
      </button>
    </>
  );
};

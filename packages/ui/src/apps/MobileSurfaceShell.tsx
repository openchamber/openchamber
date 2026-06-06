import React from 'react';
import { createPortal } from 'react-dom';
import { RiArrowLeftLine, RiCloseLine } from '@remixicon/react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const SURFACE_ROOT_ID = 'mobile-surface-root';
const DISMISS_THRESHOLD_PX = 90;
const ENTER_DELAY_MS = 16;
// Enter-slide duration. Heavy content is revealed when this transition actually
// ends (transitionend); this also feeds the fallback timer.
const ENTER_DURATION_MS = 100;
// How far below its resting position the sheet starts the enter slide. Small
// offset → a short "rise + fade" rather than a full slide up from the bottom.
const ENTER_OFFSET_PX = 48;
// Extra gap above the sheet (below the top safe area) so it doesn't sit flush
// against the very top of the app.
const TOP_GAP_PX = 8;

const ensureSurfaceRoot = (): HTMLElement | null => {
  if (typeof document === 'undefined') return null;
  let root = document.getElementById(SURFACE_ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = SURFACE_ROOT_ID;
    document.body.appendChild(root);
  }
  return root;
};

export type MobileSurfaceShellProps = {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  /** When set, the leading icon becomes a back arrow that calls this. Otherwise it's a close X bound to onClose. */
  onBack?: () => void;
  /** If true, disable swipe-down-to-dismiss (e.g. when a nested view should keep gesture for itself). */
  disableSwipeDismiss?: boolean;
  /** If true, render only the drag handle and let the child render its own header. */
  headerless?: boolean;
  ariaLabel?: string;
  children: React.ReactNode;
};

export const MobileSurfaceShell: React.FC<MobileSurfaceShellProps> = ({
  open,
  onClose,
  title,
  subtitle,
  trailing,
  onBack,
  disableSwipeDismiss = false,
  headerless = false,
  ariaLabel,
  children,
}) => {
  const { t } = useI18n();
  const rootRef = React.useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = React.useState(false);
  const [entered, setEntered] = React.useState(false);
  const [contentReady, setContentReady] = React.useState(false);
  const [dragOffset, setDragOffset] = React.useState(0);
  const dragStartYRef = React.useRef<number | null>(null);
  const isDraggingRef = React.useRef(false);
  const surfaceRef = React.useRef<HTMLElement | null>(null);
  const previousFocusRef = React.useRef<HTMLElement | null>(null);

  if (typeof document !== 'undefined' && !rootRef.current) {
    rootRef.current = ensureSurfaceRoot();
  }

  React.useEffect(() => {
    if (open) {
      setMounted(true);
      const id = window.setTimeout(() => setEntered(true), ENTER_DELAY_MS);
      return () => window.clearTimeout(id);
    }
    setEntered(false);
    const id = window.setTimeout(() => setMounted(false), 300);
    return () => window.clearTimeout(id);
  }, [open]);

  // Defer mounting heavy children until the enter slide finishes, so the
  // animation stays smooth instead of competing with a large content render.
  // Primary trigger is the slide's transitionend (below); this is just a
  // fallback in case it never fires (reduced motion / interrupted transition).
  React.useEffect(() => {
    if (!open) {
      setContentReady(false);
      return;
    }
    const id = window.setTimeout(() => setContentReady(true), ENTER_DELAY_MS + ENTER_DURATION_MS + 80);
    return () => window.clearTimeout(id);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    const focusFirstElement = () => {
      const surface = surfaceRef.current;
      if (!surface) return;
      const focusable = surface.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      (focusable ?? surface).focus({ preventScroll: true });
    };
    const focusTimer = window.setTimeout(focusFirstElement, ENTER_DELAY_MS);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const surface = surfaceRef.current;
      if (!surface) return;
      const focusable = Array.from(surface.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )).filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        surface.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus?.({ preventScroll: true });
      previousFocusRef.current = null;
    };
  }, [onClose, open]);

  const handleDragStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (disableSwipeDismiss) return;
    dragStartYRef.current = event.touches[0]?.clientY ?? null;
    isDraggingRef.current = true;
  };

  const handleDragMove = (event: React.TouchEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current || dragStartYRef.current == null) return;
    const currentY = event.touches[0]?.clientY ?? dragStartYRef.current;
    const delta = currentY - dragStartYRef.current;
    setDragOffset(delta > 0 ? delta : 0);
  };

  const handleDragEnd = () => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    dragStartYRef.current = null;
    if (dragOffset >= DISMISS_THRESHOLD_PX) {
      setDragOffset(0);
      onClose();
    } else {
      setDragOffset(0);
    }
  };

  if (!mounted || !rootRef.current) return null;

  const leading = onBack ? (
    <button
      type="button"
      className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      aria-label={t('header.actions.backAria')}
      onClick={onBack}
      style={{ touchAction: 'manipulation' }}
    >
      <RiArrowLeftLine className="size-5" />
    </button>
  ) : (
    <button
      type="button"
      className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      aria-label={t('mobile.surface.closeAria')}
      onClick={onClose}
      style={{ touchAction: 'manipulation' }}
    >
      <RiCloseLine className="size-5" />
    </button>
  );

  // When settled, use `none` (not translateY(0)) so the sheet isn't kept on a
  // compositing layer — that layer is clipped to the safe-area viewport on iOS,
  // leaving a scrim gap below it over the home-indicator inset.
  const visualTransform = !entered
    ? `translateY(${ENTER_OFFSET_PX}px)`
    : dragOffset > 0
      ? `translateY(${dragOffset}px)`
      : 'none';

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 z-50 flex flex-col bg-[rgb(0_0_0_/_0.45)]',
        // The opacity transition keeps the scrim on its own compositing layer,
        // which iOS Safari clips to the viewport — without it, a static scrim
        // bleeds the dim into the bottom toolbar overscroll zone. Quick fade so
        // it still feels near-instant.
        'transition-opacity duration-200 ease-out',
        entered ? 'opacity-100' : 'opacity-0',
      )}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onClick={onClose}
    >
      {/* Sheet is a normal flex child — mirroring MobileOverlayPanel. */}
      <section
        ref={surfaceRef}
        className="mt-auto flex min-h-0 w-full flex-col overflow-hidden rounded-t-[20px] border-t border-border/40 bg-background text-foreground"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onTransitionEnd={(event) => {
          // Reveal content exactly when the enter slide ends — not on a fixed timer.
          if (entered && event.target === event.currentTarget && event.propertyName === 'transform') {
            setContentReady(true);
          }
        }}
        style={{
          // Sized to leave the top safe area (plus a small gap) uncovered so the
          // scrim dims it and the sheet sits a few px below the very top.
          height: `calc(100% - var(--oc-safe-area-top, 0px) - ${TOP_GAP_PX}px)`,
          transform: visualTransform,
          transition: isDraggingRef.current
            ? 'none'
            : `transform ${ENTER_DURATION_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
        }}
      >
        <div
          className="shrink-0 select-none"
          onTouchStart={handleDragStart}
          onTouchMove={handleDragMove}
          onTouchEnd={handleDragEnd}
          onTouchCancel={handleDragEnd}
        >
          <div className="flex items-center justify-center pt-2 pb-1">
            <span className="h-1 w-10 rounded-full bg-[var(--surface-muted)]" aria-hidden />
          </div>
          {!headerless ? (
            <header className="flex h-[var(--oc-header-height,56px)] items-center gap-2 px-3">
              {leading}
              <div className="min-w-0 flex-1 px-1">
                {title ? (
                  typeof title === 'string' ? (
                    <h2 className="truncate typography-ui-label text-foreground">{title}</h2>
                  ) : (
                    title
                  )
                ) : null}
                {subtitle ? (
                  typeof subtitle === 'string' ? (
                    <p className="truncate typography-micro text-muted-foreground">{subtitle}</p>
                  ) : (
                    subtitle
                  )
                ) : null}
              </div>
              {trailing ? <div className="flex shrink-0 items-center gap-1.5">{trailing}</div> : null}
            </header>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {contentReady ? (
            <div className="h-full" style={{ animation: 'oc-surface-content-in 200ms ease-out' }}>
              {children}
            </div>
          ) : null}
        </div>
      </section>
      <style>{'@keyframes oc-surface-content-in { from { opacity: 0 } to { opacity: 1 } }'}</style>
    </div>,
    rootRef.current,
  );
};

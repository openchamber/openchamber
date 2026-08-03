import React from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const SURFACE_ROOT_ID = 'mobile-surface-root';
const ENTER_DELAY_MS = 16;
// Enter-slide duration. Heavy content is revealed when this transition actually
// ends (transitionend); this also feeds the fallback timer.
const ENTER_DURATION_MS = 200;

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

export type MobileFullscreenSurfaceProps = {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  /** If true, leave Escape available to nested content instead of dismissing the surface. */
  disableEscapeDismiss?: boolean;
  /** If true, render no header and let the child render its own (with its own back button). */
  headerless?: boolean;
  /** Drop the header's bottom divider (quiet single-page surfaces). */
  noHeaderBorder?: boolean;
  ariaLabel?: string;
  children: React.ReactNode;
};

/** Fullscreen overlay surface for the phone layout: covers the whole app
    (including the header), slides in from the right like a navigation push,
    and closes via the header back arrow, Escape, or the Android back button. */
export const MobileFullscreenSurface: React.FC<MobileFullscreenSurfaceProps> = ({
  open,
  onClose,
  title,
  subtitle,
  trailing,
  disableEscapeDismiss = false,
  headerless = false,
  noHeaderBorder = false,
  ariaLabel,
  children,
}) => {
  const { t } = useI18n();
  const rootRef = React.useRef<HTMLElement | null>(null);
  const [entered, setEntered] = React.useState(false);
  const [contentReady, setContentReady] = React.useState(false);
  const surfaceRef = React.useRef<HTMLElement | null>(null);
  const previousFocusRef = React.useRef<HTMLElement | null>(null);
  // Keep onClose in a ref so the focus/keydown effect below depends only on `open`.
  // The parent passes a fresh inline onClose on every render; if the effect depended
  // on it, each parent re-render (e.g. an SSE store update) would re-run it and
  // refocus the first element — stealing focus from whatever input the user is in
  // and collapsing the keyboard mid-edit.
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  if (typeof document !== 'undefined' && !rootRef.current) {
    rootRef.current = ensureSurfaceRoot();
  }

  React.useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const id = window.setTimeout(() => setEntered(true), ENTER_DELAY_MS);
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
      if (event.key === 'Escape' && !disableEscapeDismiss) {
        onCloseRef.current();
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
  }, [disableEscapeDismiss, open]);

  if (!open || !rootRef.current) return null;

  return createPortal(
    <section
      ref={surfaceRef}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      className="oc-keyboard-inset-surface fixed inset-0 z-50 flex flex-col bg-background text-foreground"
      style={{
        paddingTop: 'var(--oc-safe-area-top, 0px)',
        // Push-style enter: slide in from the right edge; settled state drops
        // the transform entirely so the surface isn't kept on a compositing
        // layer (iOS clips those to the safe-area viewport).
        transform: entered ? 'none' : 'translateX(100%)',
        transition: `transform ${ENTER_DURATION_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
      }}
      onTransitionEnd={(event) => {
        // Reveal content exactly when the enter slide ends — not on a fixed timer.
        if (entered && event.target === event.currentTarget && event.propertyName === 'transform') {
          setContentReady(true);
        }
      }}
    >
      {!headerless ? (
        <header
          className={cn(
            'flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-3',
            !noHeaderBorder && 'border-b border-border/70',
          )}
        >
          <button
            type="button"
            className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.surface.closeAria')}
            onClick={onClose}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="close" className="size-5" />
          </button>
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
      <div className="min-h-0 flex-1 overflow-hidden">
        {contentReady ? (
          <div className="h-full" style={{ animation: 'oc-surface-content-in 200ms ease-out' }}>
            {children}
          </div>
        ) : null}
      </div>
      <style>{'@keyframes oc-surface-content-in { from { opacity: 0 } to { opacity: 1 } }'}</style>
    </section>,
    rootRef.current,
  );
};

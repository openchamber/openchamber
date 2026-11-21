import React from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { isIMECompositionEvent } from '@/lib/ime';
import { useMobileChatInsets } from '@/lib/mobileChatInsets';
import { MOBILE_HEADER_BUTTON_CLASS, MOBILE_HEADER_CLASS, MOBILE_HEADER_TITLE_CLASS } from '@/components/ui/mobileHeader';

const SURFACE_ROOT_ID = 'mobile-surface-root';
const ENTER_DELAY_MS = 16;
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

type MobileFullscreenSurfaceProps = {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  disableEscapeDismiss?: boolean;
  headerless?: boolean;
  noHeaderBorder?: boolean;
  ariaLabel?: string;
  variant?: 'fullscreen' | 'dialog';
  dialogAlign?: 'chat' | 'app';
  children: React.ReactNode;
};

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
  variant = 'fullscreen',
  dialogAlign = 'chat',
  children,
}) => {
  const { t, direction } = useI18n();
  const chatInsets = useMobileChatInsets();
  const rootRef = React.useRef<HTMLElement | null>(null);
  const [entered, setEntered] = React.useState(false);
  const [contentReady, setContentReady] = React.useState(false);
  const surfaceRef = React.useRef<HTMLElement | null>(null);
  const previousFocusRef = React.useRef<HTMLElement | null>(null);
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
        if (isIMECompositionEvent(event)) return;
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

  const isDialog = variant === 'dialog';

  const surface = (
    <section
      ref={surfaceRef}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      className={cn(
        'flex flex-col bg-background text-foreground',
        isDialog
          ? 'h-[min(88dvh,860px)] w-full max-w-[720px] overflow-hidden rounded-2xl border border-edge shadow-[0_24px_64px_rgb(0_0_0_/_0.32)]'
          : 'oc-keyboard-inset-surface oc-bottom-safe-surface oc-side-safe-area fixed inset-0 z-50',
      )}
      style={isDialog ? {
        opacity: entered ? 1 : 0,
        transform: entered ? 'none' : 'scale(0.97)',
        transition: `opacity ${ENTER_DURATION_MS}ms ease-out, transform ${ENTER_DURATION_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
      } : {
        paddingTop: 'var(--oc-safe-area-top, 0px)',
        transform: entered ? 'none' : direction === 'rtl' ? 'translateX(-100%)' : 'translateX(100%)',
        transition: `transform ${ENTER_DURATION_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
      }}
      onTransitionEnd={(event) => {
        if (entered && event.target === event.currentTarget && event.propertyName === 'transform') {
          setContentReady(true);
        }
      }}
    >
      {!headerless ? (
        <header
          className={cn(
            MOBILE_HEADER_CLASS,
            !noHeaderBorder && 'border-b border-edge',
          )}
        >
          <button
            type="button"
            className={MOBILE_HEADER_BUTTON_CLASS}
            aria-label={t('mobile.surface.closeAria')}
            onClick={onClose}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="close" className="size-5" />
          </button>
          <div className="min-w-0 flex-1 px-1">
            {title ? (
              typeof title === 'string' ? (
                <h2 className={cn('truncate', MOBILE_HEADER_TITLE_CLASS)}>{title}</h2>
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
    </section>
  );

  if (!isDialog) return createPortal(surface, rootRef.current);

  return createPortal(
    <div
      className="oc-keyboard-inset-surface oc-bottom-safe-surface fixed inset-0 z-50 flex items-center justify-center p-4 transition-opacity duration-200 ease-out"
      style={{
        background: 'rgb(0 0 0 / 0.45)',
        opacity: entered ? 1 : 0,
        paddingLeft: `calc(${dialogAlign === 'chat' ? `max(1rem, ${chatInsets.left}px)` : '1rem'} + var(--oc-safe-area-left, 0px))`,
        paddingRight: `calc(${dialogAlign === 'chat' ? `max(1rem, ${chatInsets.right}px)` : '1rem'} + var(--oc-safe-area-right, 0px))`,
        paddingTop: 'max(1rem, var(--oc-safe-area-top, 0px))',
      }}
      onClick={onClose}
    >
      <div data-keyboard-rider="0.5" className="flex w-full max-w-[720px] justify-center" onClick={(event) => event.stopPropagation()}>
        {surface}
      </div>
    </div>,
    rootRef.current,
  );
};

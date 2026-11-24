import React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { ScrollableOverlay } from './ScrollableOverlay';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { isInsideOpenPopup, isTopmostBackLayer, registerBackLayer } from '@/lib/mobileBackLayers';
import { isIMECompositionEvent } from '@/lib/ime';
import { useMobileChatInsets } from '@/lib/mobileChatInsets';
import { KEYBOARD_SHOW_MS, keyboardKeyframes } from '@/lib/mobileKeyboardTiming';

interface MobileOverlayPanelProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  contentMaxHeightClassName?: string;
  contentRef?: React.Ref<HTMLElement>;
  renderHeader?: (closeButton: React.ReactNode) => React.ReactNode;
  subheader?: React.ReactNode;
  scrollContent?: boolean;
}

const OVERLAY_ROOT_ID = 'mobile-overlay-root';
const ENTER_DELAY_MS = 16;
const ENTER_DURATION_MS = 200;

let bodyScrollLocks = 0;
let unlockedBodyOverflow = '';

const lockBodyScroll = () => {
  if (bodyScrollLocks === 0) unlockedBodyOverflow = document.body.style.overflow;
  bodyScrollLocks += 1;
  document.body.style.overflow = 'hidden';
  return () => {
    bodyScrollLocks -= 1;
    if (bodyScrollLocks === 0) document.body.style.overflow = unlockedBodyOverflow;
  };
};

const ensureOverlayRoot = () => {
  if (typeof document === 'undefined') return null;
  let root = document.getElementById(OVERLAY_ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = OVERLAY_ROOT_ID;
    document.body.appendChild(root);
  }
  return root;
};

export const MobileOverlayPanel: React.FC<MobileOverlayPanelProps> = ({
  open,
  title,
  onClose,
  children,
  footer,
  className,
  contentMaxHeightClassName,
  contentRef,
  renderHeader,
  subheader,
  scrollContent = true,
}) => {
  const { t } = useI18n();
  const chatInsets = useMobileChatInsets();
  const overlayRootRef = React.useRef<HTMLElement | null>(null);
  const [entered, setEntered] = React.useState(false);
  const [enterSettled, setEnterSettled] = React.useState(false);
  const surfaceRef = React.useRef<HTMLDivElement | null>(null);
  const sheetRef = React.useRef<HTMLDivElement | null>(null);

  if (typeof document !== 'undefined' && !overlayRootRef.current) {
    overlayRootRef.current = ensureOverlayRoot();
  }

  React.useEffect(() => {
    if (!open) {
      setEntered(false);
      setEnterSettled(false);
      return;
    }
    const id = window.setTimeout(() => setEntered(true), ENTER_DELAY_MS);
    const settleId = window.setTimeout(
      () => setEnterSettled(true),
      ENTER_DELAY_MS + ENTER_DURATION_MS + 50,
    );
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(settleId);
    };
  }, [open]);

  React.useLayoutEffect(() => {
    if (!open) return;
    window.dispatchEvent(new Event('oc:mobile-overlay-opened'));
    return () => {
      window.dispatchEvent(new Event('oc:mobile-overlay-closed'));
    };
  }, [open]);

  const onCloseRef = React.useRef(onClose);
  React.useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const closeLayer = React.useCallback(() => onCloseRef.current(), []);

  React.useEffect(() => {
    if (!open) return;
    return registerBackLayer(closeLayer);
  }, [open, closeLayer]);

  React.useEffect(() => {
    const surface = surfaceRef.current;
    if (!open || !enterSettled || !surface) return;
    const readInset = () => Number.parseFloat(getComputedStyle(surface).getPropertyValue('--oc-keyboard-inset')) || 0;
    let inset = readInset();
    let slide: Animation | null = null;
    const follow = () => {
      const next = readInset();
      const delta = next - inset;
      inset = next;
      const sheet = sheetRef.current;
      if (!sheet || Math.abs(delta) < 1 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      const current = slide ? Number.parseFloat(getComputedStyle(sheet).translate.split(' ')[1] ?? '0') || 0 : 0;
      slide?.cancel();
      const from = current + delta;
      slide = sheet.animate(
        keyboardKeyframes((position) => ({ translate: `0 ${from * (1 - position)}px` })),
        { duration: KEYBOARD_SHOW_MS, easing: 'linear' },
      );
    };
    window.addEventListener('oc:keyboard-anim', follow);
    return () => {
      window.removeEventListener('oc:keyboard-anim', follow);
      slide?.cancel();
    };
  }, [enterSettled, open]);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const unlockBodyScroll = lockBodyScroll();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isIMECompositionEvent(event)) return;
      if (event.key === 'Escape' && isTopmostBackLayer(closeLayer) && !isInsideOpenPopup(event.target)) {
        closeLayer();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      unlockBodyScroll();
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, closeLayer]);

  if (!open || !overlayRootRef.current) {
    return null;
  }

  const contentMaxHeight = contentMaxHeightClassName ?? 'max-h-[min(70vh,520px)]';

  const content = (
    <div
      className={cn(
        'oc-keyboard-inset-surface oc-keyboard-inset-snap oc-bottom-safe-surface fixed inset-0 z-[60] flex flex-col bg-surface-overlay transition-opacity duration-200 ease-out',
        entered ? 'opacity-100' : 'opacity-0',
      )}
      ref={surfaceRef}
      role="dialog"
      aria-label={title}
      aria-modal="true"
      onClick={onClose}
      style={{
        paddingLeft: `calc(${chatInsets.left}px + var(--oc-safe-area-left, 0px))`,
        paddingRight: `calc(${chatInsets.right}px + var(--oc-safe-area-right, 0px))`,
      }}
    >
        <div
          ref={sheetRef}
          className={cn(
            'oc-surface-elevated mt-auto flex max-h-[calc(100dvh-0.75rem)] min-h-0 w-full flex-col rounded-t-xl border-x border-t border-edge bg-surface-elevated shadow-none pwa-overlay-panel',
            'mx-auto max-w-lg',
            className
          )}
          style={{
            transform: entered ? 'none' : 'translateY(100%)',
            transition: `transform ${ENTER_DURATION_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
          }}
          onClick={(event) => event.stopPropagation()}
        >
        {(() => {
          const closeButton = (
            <button
              type="button"
              aria-label={t('dialog.common.actions.close')}
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover"
            >
              <Icon name="close" className="h-4 w-4" />
            </button>
          );

          if (renderHeader) {
            return renderHeader(closeButton);
          }

          return (
            <div className="flex items-center justify-between ps-4 pe-3 py-2 border-b border-edge-muted">
              <h2 dir="auto" className="typography-ui-label font-semibold text-foreground">{title}</h2>
              {closeButton}
            </div>
          );
        })()}
        {subheader ? <div className="shrink-0 px-2 pt-2">{subheader}</div> : null}
        {scrollContent ? <ScrollableOverlay
          ref={contentRef}
          useScrollShadow
          disableHorizontal
          preventOverscroll
          outerClassName={cn('min-h-0 flex-1', contentMaxHeight)}
          className={cn('px-2 pt-2 pwa-overlay-scroll', footer ? 'pb-2' : 'pb-4')}
        >
          {children}
        </ScrollableOverlay> : (
          <div className={cn('flex min-h-0 flex-1 flex-col px-2 pt-2', footer ? 'pb-2' : 'pb-4', contentMaxHeight)}>
            {children}
          </div>
        )}
        {footer ? (
          <div className="shrink-0 border-t border-edge-muted px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );

  return createPortal(content, overlayRootRef.current);
};

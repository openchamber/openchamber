import React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { ScrollableOverlay } from './ScrollableOverlay';
import { Icon } from "@/components/icon/Icon";

interface MobileOverlayPanelProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  contentMaxHeightClassName?: string;
  renderHeader?: (closeButton: React.ReactNode) => React.ReactNode;
}

const OVERLAY_ROOT_ID = 'mobile-overlay-root';
// Entrance animation: classic slide up from the bottom + scrim fade.
const ENTER_DELAY_MS = 16;
const ENTER_DURATION_MS = 200;

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
  renderHeader,
}) => {
  const overlayRootRef = React.useRef<HTMLElement | null>(null);
  const [entered, setEntered] = React.useState(false);

  if (typeof document !== 'undefined' && !overlayRootRef.current) {
    overlayRootRef.current = ensureOverlayRoot();
  }

  // Replay the enter transition on each open (rise + scrim fade).
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
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open || !overlayRootRef.current) {
    return null;
  }

  const contentMaxHeight = contentMaxHeightClassName ?? 'max-h-[min(70vh,520px)]';

  const content = (
    <div
      className={cn(
        'oc-keyboard-inset-surface fixed inset-0 z-[60] flex flex-col bg-[rgb(0_0_0_/_0.45)] transition-opacity duration-200 ease-out',
        entered ? 'opacity-100' : 'opacity-0',
      )}
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
        <div
          className={cn(
            'mt-auto flex max-h-[calc(100dvh-0.75rem)] min-h-0 w-full flex-col rounded-t-xl border-x border-t border-border/50 bg-background shadow-none pwa-overlay-panel',
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
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
              <h2 className="typography-ui-label font-semibold text-foreground">{title}</h2>
              {closeButton}
            </div>
          );
        })()}
        <ScrollableOverlay useScrollShadow disableHorizontal outerClassName={cn('min-h-0 flex-1', contentMaxHeight)} className="px-2 py-2 pwa-overlay-scroll">
          {children}
        </ScrollableOverlay>
        {footer ? (
          <div className="shrink-0 border-t border-border/40 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );

  return createPortal(content, overlayRootRef.current);
};

import React from 'react';
import { createPortal } from 'react-dom';
import { RiCloseLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { ScrollableOverlay } from './ScrollableOverlay';

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

  if (typeof document !== 'undefined' && !overlayRootRef.current) {
    overlayRootRef.current = ensureOverlayRoot();
  }

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
      className="fixed inset-0 z-50 flex flex-col bg-background/70"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
        <div
          className={cn(
            'mt-auto flex max-h-[calc(100dvh-0.75rem)] min-h-0 w-full flex-col rounded-t-xl border border-border/50 bg-background shadow-none pwa-overlay-panel',
            'mx-auto max-w-lg',
            className
          )}
          data-keyboard-avoid="true"
          onClick={(event) => event.stopPropagation()}
        >
        {(() => {
          const closeButton = (
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover"
            >
              <RiCloseLine className="h-4 w-4" />
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
        <ScrollableOverlay outerClassName={cn('min-h-0 flex-1', contentMaxHeight)} className="px-2 py-2 pwa-overlay-scroll">
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

export default MobileOverlayPanel;

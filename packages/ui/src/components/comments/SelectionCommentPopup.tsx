import React from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '@/components/icon/Icon';
import { useElementSize } from '@/hooks/useElementSize';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const VIEWPORT_MARGIN = 8;

const clampToViewport = (start: number, size: number, viewport: number) =>
  Math.max(VIEWPORT_MARGIN, Math.min(start, viewport - size - VIEWPORT_MARGIN));

const subscribeViewport = (notify: () => void) => {
  window.addEventListener('resize', notify);
  return () => window.removeEventListener('resize', notify);
};
const viewportSize = () => `${window.innerWidth}x${window.innerHeight}`;

export function SelectionCommentPopup({ anchor, commentMode, commentInput, highlightOverlay = null, menuRef, onComment }: {
  anchor: { x: number; y: number };
  commentMode: boolean;
  commentInput: React.ReactNode;
  highlightOverlay?: React.ReactNode;
  menuRef?: React.Ref<HTMLDivElement>;
  onComment: () => void;
}) {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const [fieldRef, fieldSize] = useElementSize<HTMLDivElement>();
  React.useSyncExternalStore(subscribeViewport, viewportSize);

  // external: #3894 Native mobile selection toolbars cover the desktop pill, so mobile comments dock at the bottom.
  if (isMobile) {
    return createPortal(
      <div className="oc-keyboard-inset-surface pointer-events-none fixed inset-x-0 bottom-0 z-50">
        {highlightOverlay}
        <div
          ref={menuRef}
          data-keyboard-rider=""
          className="pointer-events-auto mx-auto max-w-[420px] px-3"
          style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))' }}
        >
          {commentMode ? commentInput : (
            <div className={cn('mx-auto w-fit', 'oc-glass-popover oc-glass-floating rounded-full', 'p-1')}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={onComment}
                className={cn(
                  'flex min-w-0 items-center gap-2 rounded-full px-4 py-2',
                  'text-sm font-medium leading-tight text-foreground',
                  'active:bg-[var(--interactive-hover)]',
                  'transition-colors duration-150',
                )}
                title={t('chat.textSelection.title.commentOnSelection')}
              >
                <Icon name="chat-1" className="size-4 flex-shrink-0" />
                <span className="min-w-0 whitespace-nowrap">{t('chat.textSelection.actions.comment')}</span>
              </button>
            </div>
          )}
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50"
      style={commentMode && fieldSize ? {
        left: clampToViewport(anchor.x - fieldSize.width / 2, fieldSize.width, window.innerWidth),
        top: clampToViewport(anchor.y - fieldSize.height, fieldSize.height, window.innerHeight),
      } : { left: anchor.x, top: anchor.y, transform: 'translate(-50%, -100%)' }}
    >
      {highlightOverlay ? createPortal(highlightOverlay, document.body) : null}
      {commentMode ? (
        <div ref={fieldRef} className="w-[min(420px,80vw)]">{commentInput}</div>
      ) : (
        <div className={cn('flex items-center whitespace-nowrap', 'oc-glass-popover oc-glass-floating rounded-full', 'p-1')}>
          <button
            type="button"
            onClick={onComment}
            className={cn(
              'px-3.5 py-1.5 rounded-full',
              'text-sm font-medium',
              'text-foreground',
              'hover:bg-[var(--interactive-hover)]',
              'transition-colors duration-150',
            )}
            title={t('chat.textSelection.title.commentOnSelection')}
          >
            {t('chat.textSelection.actions.comment')}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

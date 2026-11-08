import React from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '@/components/icon/Icon';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * The Comment pill over a selection and the comment field it opens. The owner
 * knows what is selected and where; this only places the two.
 */
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

  // Mobile: Android and iOS draw their own copy/paste toolbar right above a
  // text selection, exactly where the desktop pill sits, and cover it (#3894).
  // So the Comment button and the comment input dock at the bottom of the
  // screen instead, like the chat selection sheet; the keyboard-inset surface
  // keeps the input above the soft keyboard in the native app, and the
  // browser's resizes-content viewport does the same on the web. The
  // highlight renders inside this layer: on mobile the files panel is itself a
  // z-50 overlay and would cover a separate body-level highlight.
  if (isMobile) {
    return createPortal(
      <div className="oc-keyboard-inset-surface pointer-events-none fixed inset-x-0 bottom-0 z-50">
        {highlightOverlay}
        <div
          ref={menuRef}
          // The field rides the keyboard; the highlight beside it stays put.
          data-keyboard-rider=""
          className="pointer-events-auto mx-auto max-w-[420px] px-3"
          style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))' }}
        >
          {commentMode ? commentInput : (
            <div className={cn('mx-auto w-fit', 'oc-glass-popover oc-glass-floating rounded-full', 'p-1')}>
              <button
                type="button"
                // Keep the text selection alive through the tap: the
                // selection is what the comment quotes.
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
      style={{ left: anchor.x, top: anchor.y, transform: 'translate(-50%, -100%)' }}
    >
      {highlightOverlay ? createPortal(highlightOverlay, document.body) : null}
      {commentMode ? (
        <div className="w-[min(420px,80vw)]">{commentInput}</div>
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

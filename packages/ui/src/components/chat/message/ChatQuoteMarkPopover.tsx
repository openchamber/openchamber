import React from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';

/**
 * The popover over a marked chat quote: the comment waiting in the composer,
 * with edit and remove. Editing swaps in the same rounded input the selection
 * menu uses to write the comment.
 */

const POPOVER_GAP_PX = 8;
const VIEWPORT_MARGIN_PX = 12;
const PLACE_BELOW_THRESHOLD_PX = 140;

const ACTION_CLASS = 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground';

export interface ChatQuoteMarkPopoverProps {
    ref?: React.Ref<HTMLDivElement>;
    /** Viewport rect of the marked fragment. */
    anchorRect: DOMRect;
    comment: string;
    editing: boolean;
    onEditingChange: (editing: boolean) => void;
    onSave: (text: string) => void;
    onRemove: () => void;
}

export function ChatQuoteMarkPopover({
    ref,
    anchorRect,
    comment,
    editing,
    onEditingChange,
    onSave,
    onRemove,
}: ChatQuoteMarkPopoverProps) {
    const { t } = useI18n();
    const [draft, setDraft] = React.useState(comment);
    const inputRef = React.useRef<HTMLTextAreaElement>(null);

    const resizeInput = React.useCallback(() => {
        const element = inputRef.current;
        if (!element) return;
        element.style.height = 'auto';
        element.style.height = `${Math.min(element.scrollHeight, 120)}px`;
    }, []);

    React.useEffect(() => {
        if (!editing) return;
        setDraft(comment);
        queueMicrotask(() => {
            const element = inputRef.current;
            if (!element) return;
            element.focus();
            element.setSelectionRange(element.value.length, element.value.length);
            resizeInput();
        });
        // The comment at edit start is the baseline.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editing]);

    const save = () => {
        onSave(draft.trim());
        onEditingChange(false);
    };

    const placeBelow = anchorRect.top < PLACE_BELOW_THRESHOLD_PX;
    const left = Math.min(
        Math.max(anchorRect.left + anchorRect.width / 2, VIEWPORT_MARGIN_PX),
        window.innerWidth - VIEWPORT_MARGIN_PX,
    );

    return createPortal(
        <div
            ref={ref}
            className="app-region-no-drag fixed z-50"
            style={{
                left,
                top: placeBelow ? anchorRect.bottom + POPOVER_GAP_PX : anchorRect.top - POPOVER_GAP_PX,
                transform: placeBelow ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
            }}
        >
            {editing ? (
                <div className="oc-glass-popover flex items-end gap-2 rounded-3xl border border-[var(--interactive-border)] py-1 pl-4 pr-1 shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]">
                    <textarea
                        ref={inputRef}
                        rows={1}
                        value={draft}
                        onChange={(event) => {
                            setDraft(event.target.value);
                            resizeInput();
                        }}
                        onKeyDown={(event) => {
                            if (isIMECompositionEvent(event)) return;
                            if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                save();
                            } else if (event.key === 'Escape') {
                                event.preventDefault();
                                onEditingChange(false);
                            }
                        }}
                        placeholder={t('chat.textSelection.comment.placeholder')}
                        className="w-64 max-w-[70vw] flex-1 resize-none bg-transparent py-1.5 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground placeholder:opacity-60"
                        style={{ minHeight: 0, height: 'auto' }}
                    />
                    <button
                        type="button"
                        onClick={save}
                        className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--primary-base)] text-[var(--primary-foreground)] transition-opacity duration-150 hover:opacity-90"
                        aria-label={t('chat.textSelection.comment.save')}
                        title={t('chat.textSelection.comment.save')}
                    >
                        <Icon name="check" className="h-4 w-4" />
                    </button>
                </div>
            ) : (
                <div className="oc-glass-popover flex max-w-[min(360px,80vw)] items-start gap-1 rounded-2xl border border-[var(--interactive-border)] py-1 pl-3 pr-1 shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]">
                    {comment ? (
                        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words py-1 text-sm text-foreground">{comment}</div>
                    ) : null}
                    <div className={cn('flex shrink-0 items-center', !comment && '-ml-2')}>
                        <button
                            type="button"
                            className={ACTION_CLASS}
                            style={{ minHeight: 0, minWidth: 0 }}
                            onClick={() => onEditingChange(true)}
                            aria-label={t('chat.chatInput.contextPreview.edit')}
                            title={t('chat.chatInput.contextPreview.edit')}
                        >
                            <Icon name="pencil" className="h-3.5 w-3.5" />
                        </button>
                        <button
                            type="button"
                            className={ACTION_CLASS}
                            style={{ minHeight: 0, minWidth: 0 }}
                            onClick={onRemove}
                            aria-label={t('chat.chatInput.contextPreview.remove')}
                            title={t('chat.chatInput.contextPreview.remove')}
                        >
                            <Icon name="delete-bin" className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </div>
            )}
        </div>,
        document.body,
    );
}

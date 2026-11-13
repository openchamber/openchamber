/**
 * The one-line comment field: a glass pill with the comment editor and a
 * round attach button. Enter attaches, Shift+Enter breaks the line, Escape
 * cancels, and the field focuses itself on mount.
 *
 * It is shared by the text-selection menu's floating comment input and the
 * composer's context chips, which edit a draft a surface filed ready to be
 * typed in. The pill stays one row on a narrow surface (a VS Code sidebar or
 * the composer): the editor takes the remaining width and the button keeps its
 * size.
 */

import { Icon } from '@/components/icon/Icon';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { CommentTextEditor } from './CommentTextEditor';
import type { CommentImagePaste } from './useCommentImagePaste';

export interface CommentInputBarProps {
    value: string;
    onChange: (value: string) => void;
    /** Enter or the attach button. */
    onSubmit: () => void;
    /** Escape, or the surface closing the field. */
    onCancel: () => void;
    /** Clicking away commits the same text as Enter; the host decides what that saves. */
    onBlur?: () => void;
    imagePaste: CommentImagePaste;
    placeholder: string;
    /** The pill itself, for a host's open/close transition. */
    className?: string;
    /** The text field; a host may cap its width (the selection menu's `w-64`). */
    editorClassName?: string;
}

export function CommentInputBar({
    value,
    onChange,
    onSubmit,
    onCancel,
    onBlur,
    imagePaste,
    placeholder,
    className,
    editorClassName,
}: CommentInputBarProps) {
    const { t } = useI18n();

    return (
        <div
            className={cn(
                'oc-glass-popover oc-glass-floating relative flex items-end gap-2 rounded-3xl ps-4 py-1 pe-1',
                className,
            )}
        >
            <CommentTextEditor
                value={value}
                onChange={onChange}
                onSubmit={onSubmit}
                onCancel={onCancel}
                onBlur={onBlur}
                enterSubmits
                imagePaste={imagePaste}
                placeholder={placeholder}
                className={cn('py-1.5 text-sm leading-5 text-foreground', editorClassName)}
            />
            <HoverTooltip label={t('chat.textSelection.comment.attach')}>
                <button
                    type="button"
                    // Committing happens on blur; keep the field focused until
                    // the click runs, so a click on the button cannot commit
                    // first and unmount it under the pointer.
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={onSubmit}
                    className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--primary-base)] text-[var(--primary-foreground)] transition-opacity duration-150 hover:opacity-90"
                    aria-label={t('chat.textSelection.comment.attach')}
                >
                    <Icon name="attachment-2" className="h-4 w-4" />
                </button>
            </HoverTooltip>
        </div>
    );
}

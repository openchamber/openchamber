import { useCallback, useId, useRef, type Dispatch, type SetStateAction } from 'react';

import { CommentTextEditor } from '@/components/comments/CommentTextEditor';
import { useCommentImagePaste } from '@/components/comments/useCommentImagePaste';
import { InlineDictationButton } from '@/components/dictation/InlineDictationButton';
import { Icon } from '@/components/icon/Icon';
import { buttonVariants } from '@/components/ui/button-variants';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { discardFieldDictations, useFieldRecording } from '@/lib/dictation/fieldDictation';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { appendInlineText } from '../composer/text';

interface SelectionCommentInputProps {
    value: string;
    onChange: Dispatch<SetStateAction<string>>;
    onSubmit: () => void;
    onCancel: () => void;
    imagePaste: ReturnType<typeof useCommentImagePaste>;
    opening: boolean;
}

export const SelectionCommentInput = ({ value, onChange, onSubmit, onCancel, imagePaste, opening }: SelectionCommentInputProps) => {
    const { t } = useI18n();
    const fieldKey = `selection-comment:${useId()}`;
    const inputRef = useRef<HTMLDivElement>(null);
    const dictating = Boolean(useFieldRecording(fieldKey));
    const mountInput = useCallback((node: HTMLDivElement | null) => {
        inputRef.current = node;
        if (!node) return;
        return () => {
            inputRef.current = null;
            discardFieldDictations(fieldKey);
        };
    }, [fieldKey]);

    const attach = () => {
        if (!dictating) onSubmit();
    };

    return (
        <div
            ref={mountInput}
            className={cn(
                'oc-glass-popover oc-glass-floating relative grid w-80 max-w-[calc(100vw-1rem)] grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-x-2 rounded-3xl',
                'ps-4',
                'py-1 pe-1',
                'transition-[opacity,transform] duration-200 ease-out',
                opening ? 'opacity-0 translate-y-[4px]' : 'opacity-100 translate-y-0'
            )}
        >
            <CommentTextEditor
                value={value}
                onChange={onChange}
                onSubmit={attach}
                onCancel={onCancel}
                enterSubmits
                imagePaste={imagePaste}
                placeholder={t('chat.textSelection.comment.placeholder')}
                className={cn(
                    'col-start-1 py-1.5 text-sm leading-5 text-foreground',
                    dictating ? 'col-span-2 row-start-2' : 'row-start-1',
                )}
            />
            <div
                className={cn(
                    'mb-0.5 flex min-w-0 items-center gap-1 empty:hidden',
                    dictating
                        ? 'col-span-full row-start-1 min-h-8 [&>[role=status]]:me-auto'
                        : 'col-start-2 row-start-1',
                )}
                onMouseDown={(event) => event.preventDefault()}
            >
                <InlineDictationButton
                    fieldKey={fieldKey}
                    panelKey={fieldKey}
                    showFailureToast={false}
                    onTranscript={(text) => {
                        if (inputRef.current) onChange((current) => appendInlineText(current, text));
                    }}
                    buttonClassName={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'rounded-full focus-visible:bg-interactive-hover')}
                />
            </div>
            <HoverTooltip label={t('chat.textSelection.comment.attach')}>
                <button
                    type="button"
                    onClick={attach}
                    disabled={dictating}
                    className={cn(
                        'mb-0.5 flex shrink-0 items-center justify-center rounded-full bg-[var(--primary-base)] text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-50 transition-opacity duration-150',
                        'col-start-3 h-8 w-8',
                        dictating ? 'row-start-2' : 'row-start-1'
                    )}
                    aria-label={t('chat.textSelection.comment.attach')}
                >
                    <Icon name="attachment-2" className="h-4 w-4" />
                </button>
            </HoverTooltip>
        </div>
    );
};

import { CommentTextEditor } from '@/components/comments/CommentTextEditor';
import { useCommentImagePaste } from '@/components/comments/useCommentImagePaste';
import { Icon } from '@/components/icon/Icon';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface SelectionCommentInputProps {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    onCancel: () => void;
    imagePaste: ReturnType<typeof useCommentImagePaste>;
    opening: boolean;
}

export const SelectionCommentInput = ({ value, onChange, onSubmit, onCancel, imagePaste, opening }: SelectionCommentInputProps) => {
    const { t } = useI18n();
    return (
        <div
            className={cn(
                'oc-glass-popover oc-glass-floating relative flex items-end gap-2 rounded-3xl',
                'ps-4',
                'py-1 pe-1',
                'transition-[opacity,transform] duration-200 ease-out',
                opening ? 'opacity-0 translate-y-[4px]' : 'opacity-100 translate-y-0'
            )}
        >
            <CommentTextEditor
                value={value}
                onChange={onChange}
                onSubmit={onSubmit}
                onCancel={onCancel}
                enterSubmits
                imagePaste={imagePaste}
                placeholder={t('chat.textSelection.comment.placeholder')}
                className="w-64 max-w-[70vw] py-1.5 text-sm leading-5 text-foreground"
            />
            <HoverTooltip label={t('chat.textSelection.comment.attach')}>
                <button
                    type="button"
                    onClick={onSubmit}
                    className={cn(
                        'mb-0.5 flex shrink-0 items-center justify-center rounded-full bg-[var(--primary-base)] text-[var(--primary-foreground)] hover:opacity-90 transition-opacity duration-150',
                        'h-8 w-8'
                    )}
                    aria-label={t('chat.textSelection.comment.attach')}
                >
                    <Icon name="attachment-2" className="h-4 w-4" />
                </button>
            </HoverTooltip>
        </div>
    );
};

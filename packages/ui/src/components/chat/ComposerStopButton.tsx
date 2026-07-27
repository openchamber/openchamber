import { StopIcon } from '@/components/icons/StopIcon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type ComposerStopButtonProps = {
    buttonClassName?: string;
    iconClassName?: string;
    onStop: () => void;
};

export function ComposerStopButton({ buttonClassName, iconClassName, onStop }: ComposerStopButtonProps) {
    const { t } = useI18n();

    return (
        <button
            type="button"
            onClick={onStop}
            className={cn(
                buttonClassName,
                'text-[var(--status-error)] hover:text-[var(--status-error)] focus-visible:ring-ring/50 focus-visible:ring-[3px]',
            )}
            aria-label={t('chat.chatInput.actions.stopGeneratingAria')}
        >
            <StopIcon className={iconClassName} aria-hidden="true" />
        </button>
    );
}

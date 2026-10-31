import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** The same beat as the background action beside it: the chip is read, not scanned. */
const TOOLTIP_DELAY_MS = 750;

/**
 * "Retry now" on the retry chip. The managed OpenCode plugin holds the waiting
 * attempt, so this repeats it instead of aborting the turn.
 */
export const RetryNowButton: React.FC<{ onClick: () => void; className?: string }> = ({ onClick, className }) => {
    const { t } = useI18n();
    const label = t('settings.openchamber.defaults.retryNow');

    return (
        <Tooltip delayDuration={TOOLTIP_DELAY_MS}>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        onClick();
                    }}
                    aria-label={label}
                    className={cn(
                        'inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors',
                        'hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        className,
                    )}
                >
                    <Icon name="refresh" className="h-4 w-4" />
                </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
                {label}
            </TooltipContent>
        </Tooltip>
    );
};

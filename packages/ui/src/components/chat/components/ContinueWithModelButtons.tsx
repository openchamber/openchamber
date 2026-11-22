import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** The tooltip waits a beat: the button sits next to text the user reads while the agent works. */
const TOOLTIP_DELAY_MS = 750;

/** "Continue with another model" in the failed-turn and retry notices. */
export const ContinueWithModelButton: React.FC<{ onClick: () => void }> = ({ onClick }) => {
    const { t } = useI18n();
    return (
        <Button variant="outline" size="xs" onClick={onClick}>
            <Icon name="arrow-left-right" className="size-3.5" />
            {t('chat.continueWithModel.action')}
        </Button>
    );
};

/**
 * The same action as an icon, for the status chip above the composer and the
 * scroll-to-bottom pill that stands in for it, beside the background action.
 */
export const ContinueWithModelIconButton: React.FC<{ onClick: () => void; className?: string }> = ({ onClick, className }) => {
    const { t } = useI18n();
    const label = t('chat.continueWithModel.action');

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
                        'hover:bg-interactive-hover hover:text-foreground',
                        className,
                    )}
                >
                    <Icon name="arrow-left-right" className="h-4 w-4" />
                </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
                {label}
            </TooltipContent>
        </Tooltip>
    );
};

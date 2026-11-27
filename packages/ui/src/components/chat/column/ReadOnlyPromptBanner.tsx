import React from 'react';
import { Button } from '@/components/ui/button';
import { StopIcon } from '@/components/icons/StopIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export const ReadOnlyPromptBanner: React.FC<{
    text: string;
    onStop?: () => void;
    stopLabel?: string;
    leading?: React.ReactNode;
}> = ({ text, onStop, stopLabel, leading }) => (
    <div className="w-full py-3" data-composer-transient="">
        <div className="chat-input-column">
            <div className="flex items-center gap-2 rounded-2xl border border-edge bg-[var(--surface-background)] px-4 py-3 typography-ui-label text-muted-foreground">
                {leading ? <span className="flex min-w-0 shrink-0 items-center gap-1.5">{leading}</span> : null}
                <span className="min-w-0 flex-1 text-center">{text}</span>
                {onStop ? (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="-my-1.5 -me-2 shrink-0 text-[var(--status-error)] hover:text-[var(--status-error)]"
                                onClick={onStop}
                                aria-label={stopLabel}
                            >
                                <StopIcon className="size-4" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={6}>{stopLabel}</TooltipContent>
                    </Tooltip>
                ) : null}
            </div>
        </div>
    </div>
);

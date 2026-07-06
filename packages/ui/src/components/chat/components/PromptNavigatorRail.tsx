import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getMessagePreview } from '../lib/messagePreview';

type PromptEntry = {
    turnId: string;
    preview: string;
    index: number;
};

type PromptNavigatorRailProps = {
    turnIds: string[];
    previewsByTurnId: Map<string, Part[]>;
    activeTurnId: string | null;
    onSelectTurn: (turnId: string) => void;
};

const LINE_HIT_HEIGHT_PX = 10;
const STACK_MAX_HEIGHT_PX = 192;

const buildPromptEntries = (
    turnIds: string[],
    previewsByTurnId: Map<string, Part[]>,
): PromptEntry[] => {
    return turnIds.map((turnId, index) => {
        const parts = previewsByTurnId.get(turnId) ?? [];
        return {
            turnId,
            preview: getMessagePreview(parts, 120),
            index,
        };
    });
};

export const PromptNavigatorRail: React.FC<PromptNavigatorRailProps> = ({
    turnIds,
    previewsByTurnId,
    activeTurnId,
    onSelectTurn,
}) => {
    const { t } = useI18n();

    const prompts = React.useMemo(
        () => buildPromptEntries(turnIds, previewsByTurnId),
        [previewsByTurnId, turnIds],
    );

    if (prompts.length === 0) {
        return null;
    }

    return (
        <nav
            aria-label={t('chat.promptNavigator.aria')}
            className="pointer-events-none absolute right-2 top-1/2 z-20 -translate-y-1/2"
        >
            <div
                className={cn(
                    'pointer-events-auto flex flex-col items-center gap-1 rounded-full',
                    'border border-[var(--interactive-border)]/40 bg-[var(--surface-background)]/90 px-1.5 py-2',
                    'shadow-sm backdrop-blur-sm',
                )}
                style={{ maxHeight: `${STACK_MAX_HEIGHT_PX}px` }}
            >
                <div className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {prompts.map((prompt) => {
                        const isActive = prompt.turnId === activeTurnId;
                        const hasPreview = prompt.preview.trim().length > 0;

                        return (
                            <Tooltip key={prompt.turnId} delayDuration={120}>
                                <TooltipTrigger asChild>
                                    <button
                                        type="button"
                                        className={cn(
                                            'group flex shrink-0 items-center justify-center rounded-full',
                                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focusRing)]',
                                        )}
                                        style={{
                                            width: '16px',
                                            height: `${LINE_HIT_HEIGHT_PX}px`,
                                        }}
                                        aria-label={t('chat.promptNavigator.goToPrompt', { number: prompt.index + 1 })}
                                        aria-current={isActive ? 'true' : undefined}
                                        onClick={() => {
                                            onSelectTurn(prompt.turnId);
                                        }}
                                    >
                                        <span
                                            aria-hidden="true"
                                            className={cn(
                                                'block rounded-full transition-colors',
                                                isActive
                                                    ? 'h-0.5 w-3.5 bg-[var(--surface-foreground)]'
                                                    : 'h-px w-2.5 bg-[var(--surface-mutedForeground)]/45 group-hover:bg-[var(--surface-mutedForeground)]/80',
                                            )}
                                        />
                                    </button>
                                </TooltipTrigger>
                                {hasPreview ? (
                                    <TooltipContent
                                        side="left"
                                        align="center"
                                        sideOffset={10}
                                        className="max-w-[min(18rem,calc(100vw-4rem))] whitespace-normal text-left"
                                    >
                                        {prompt.preview}
                                    </TooltipContent>
                                ) : null}
                            </Tooltip>
                        );
                    })}
                </div>
            </div>
        </nav>
    );
};

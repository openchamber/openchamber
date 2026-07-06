import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';

import { useDeviceInfo } from '@/lib/device';
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

const LINE_HIT_HEIGHT_PX = 8;
const HOVER_CLOSE_DELAY_MS = 120;
const COMPACT_BACKDROP_MAX_WIDTH_PX = 1280;

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

const resolveLineGapClass = (count: number): string => {
    if (count > 24) {
        return 'gap-px';
    }
    if (count > 12) {
        return 'gap-0.5';
    }
    return 'gap-1';
};

export const PromptNavigatorRail: React.FC<PromptNavigatorRailProps> = ({
    turnIds,
    previewsByTurnId,
    activeTurnId,
    onSelectTurn,
}) => {
    const { t } = useI18n();
    const { screenWidth } = useDeviceInfo();
    const [isHoverOpen, setIsHoverOpen] = React.useState(false);
    const closeTimeoutRef = React.useRef<number | null>(null);

    const prompts = React.useMemo(
        () => buildPromptEntries(turnIds, previewsByTurnId),
        [previewsByTurnId, turnIds],
    );

    const needsBackdrop = screenWidth < COMPACT_BACKDROP_MAX_WIDTH_PX;
    const lineGapClass = resolveLineGapClass(prompts.length);

    const clearCloseTimeout = React.useCallback(() => {
        if (closeTimeoutRef.current !== null) {
            window.clearTimeout(closeTimeoutRef.current);
            closeTimeoutRef.current = null;
        }
    }, []);

    const openHoverPanel = React.useCallback(() => {
        clearCloseTimeout();
        setIsHoverOpen(true);
    }, [clearCloseTimeout]);

    const scheduleCloseHoverPanel = React.useCallback(() => {
        clearCloseTimeout();
        closeTimeoutRef.current = window.setTimeout(() => {
            setIsHoverOpen(false);
        }, HOVER_CLOSE_DELAY_MS);
    }, [clearCloseTimeout]);

    React.useEffect(() => () => {
        clearCloseTimeout();
    }, [clearCloseTimeout]);

    const handleSelectPrompt = React.useCallback((turnId: string) => {
        onSelectTurn(turnId);
        setIsHoverOpen(false);
    }, [onSelectTurn]);

    if (prompts.length === 0) {
        return null;
    }

    return (
        <nav
            aria-label={t('chat.promptNavigator.aria')}
            className="pointer-events-none absolute right-3 top-1/2 z-20 -translate-y-1/2"
        >
            <div
                className="pointer-events-auto relative"
                onMouseEnter={openHoverPanel}
                onMouseLeave={scheduleCloseHoverPanel}
            >
                <div
                    className={cn(
                        'flex flex-col items-center rounded-full px-1 py-1.5',
                        lineGapClass,
                        needsBackdrop
                            ? 'border border-[var(--interactive-border)]/40 bg-[var(--surface-background)]/90 shadow-sm backdrop-blur-sm'
                            : 'bg-transparent',
                    )}
                >
                    {prompts.map((prompt) => {
                        const isActive = prompt.turnId === activeTurnId;

                        return (
                            <button
                                key={prompt.turnId}
                                type="button"
                                className={cn(
                                    'flex shrink-0 items-center justify-center rounded-full',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focusRing)]',
                                )}
                                style={{
                                    width: '16px',
                                    height: `${LINE_HIT_HEIGHT_PX}px`,
                                }}
                                aria-label={t('chat.promptNavigator.goToPrompt', { number: prompt.index + 1 })}
                                aria-current={isActive ? 'true' : undefined}
                                onClick={() => {
                                    handleSelectPrompt(prompt.turnId);
                                }}
                            >
                                <span
                                    aria-hidden="true"
                                    className={cn(
                                        'block h-0.5 rounded-full transition-colors',
                                        isActive
                                            ? 'w-3.5 bg-[var(--surface-foreground)]'
                                            : 'w-3 bg-[var(--surface-foreground)]/40',
                                    )}
                                />
                            </button>
                        );
                    })}
                </div>

                {isHoverOpen ? (
                    <div
                        className={cn(
                            'absolute right-full top-1/2 z-30 mr-3 w-[min(18rem,calc(100vw-5rem))] -translate-y-1/2',
                            'rounded-xl border border-[var(--interactive-border)]/60 bg-[var(--surface-elevated)] p-1 shadow-md',
                        )}
                        onMouseEnter={openHoverPanel}
                        onMouseLeave={scheduleCloseHoverPanel}
                    >
                        <ul className="max-h-[min(24rem,70vh)] overflow-y-auto">
                            {prompts.map((prompt) => {
                                const isActive = prompt.turnId === activeTurnId;
                                const preview = prompt.preview.trim() || t('chat.timeline.noTextContent');

                                return (
                                    <li key={prompt.turnId}>
                                        <button
                                            type="button"
                                            className={cn(
                                                'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                                                'hover:bg-[var(--interactive-hover)]/60',
                                                isActive
                                                    ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]'
                                                    : 'text-[var(--surface-foreground)]',
                                            )}
                                            aria-current={isActive ? 'true' : undefined}
                                            onClick={() => {
                                                handleSelectPrompt(prompt.turnId);
                                            }}
                                        >
                                            <span
                                                className={cn(
                                                    'typography-meta w-5 shrink-0 text-right tabular-nums',
                                                    isActive
                                                        ? 'text-[var(--interactive-selection-foreground)]/75'
                                                        : 'text-[var(--surface-mutedForeground)]',
                                                )}
                                            >
                                                {prompt.index + 1}.
                                            </span>
                                            <span className="min-w-0 flex-1">
                                                <span className="typography-meta line-clamp-2">{preview}</span>
                                                {isActive ? (
                                                    <span className="mt-0.5 block typography-micro text-[var(--interactive-selection-foreground)]/80">
                                                        {t('chat.promptNavigator.currentPrompt')}
                                                    </span>
                                                ) : null}
                                            </span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                ) : null}
            </div>
        </nav>
    );
};

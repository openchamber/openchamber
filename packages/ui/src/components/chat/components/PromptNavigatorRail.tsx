"use no memo";

import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';

import { Icon } from '@/components/icon/Icon';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import { getMessagePreview } from '../lib/messagePreview';

type PromptEntry = {
    turnId: string;
    preview: string;
};

type PromptNavigatorRailProps = {
    turnIds: string[];
    previewsByTurnId: Map<string, Part[]>;
    activeTurnId: string | null;
    onSelectTurn: (turnId: string) => void;
    canLoadEarlier: boolean;
    isLoadingOlder: boolean;
    onLoadEarlier: () => void;
};

const LINE_HIT_HEIGHT_PX = 8;
const HOVER_CLOSE_DELAY_MS = 120;
const COMPACT_BACKDROP_MAX_WIDTH_PX = 1280;

const buildPromptEntries = (
    turnIds: string[],
    previewsByTurnId: Map<string, Part[]>,
): PromptEntry[] => {
    return turnIds.map((turnId) => {
        const parts = previewsByTurnId.get(turnId) ?? [];
        return {
            turnId,
            preview: getMessagePreview(parts, 120),
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

export function PromptNavigatorRail({
    turnIds,
    previewsByTurnId,
    activeTurnId,
    onSelectTurn,
    canLoadEarlier,
    isLoadingOlder,
    onLoadEarlier,
}: PromptNavigatorRailProps) {
    const { t } = useI18n();
    const { screenWidth } = useDeviceInfo();
    const isPromptNavigatorPanelOpen = useUIStore((state) => state.isPromptNavigatorPanelOpen);
    const setPromptNavigatorPanelOpen = useUIStore((state) => state.setPromptNavigatorPanelOpen);
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
        setPromptNavigatorPanelOpen(false);
    }, [onSelectTurn, setPromptNavigatorPanelOpen]);

    const handleLoadEarlier = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        if (isLoadingOlder) {
            return;
        }
        onLoadEarlier();
    }, [isLoadingOlder, onLoadEarlier]);

    const isPanelOpen = isPromptNavigatorPanelOpen || isHoverOpen;

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
                        const preview = prompt.preview.trim() || t('chat.timeline.noTextContent');

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
                                aria-label={preview}
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

                {isPanelOpen ? (
                    <div
                        className={cn(
                            'absolute right-full top-1/2 z-30 mr-3 w-[min(18rem,calc(100vw-5rem))] -translate-y-1/2',
                            'rounded-xl border border-[var(--interactive-border)]/60 bg-[var(--surface-elevated)] p-1 shadow-md',
                        )}
                        onMouseEnter={openHoverPanel}
                        onMouseLeave={scheduleCloseHoverPanel}
                    >
                        <ul className="max-h-[min(24rem,70vh)] overflow-y-auto">
                            {canLoadEarlier ? (
                                <li className="border-b border-[var(--interactive-border)]/40 px-1 pb-1">
                                    <button
                                        type="button"
                                        className={cn(
                                            'flex w-full items-center justify-center gap-1.5 rounded-lg px-2.5 py-2',
                                            'typography-meta text-[var(--surface-mutedForeground)] transition-colors',
                                            'hover:bg-[var(--interactive-hover)]/60 hover:text-[var(--surface-foreground)]',
                                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focusRing)]',
                                            isLoadingOlder ? 'cursor-wait opacity-70' : undefined,
                                        )}
                                        disabled={isLoadingOlder}
                                        onClick={handleLoadEarlier}
                                    >
                                        {isLoadingOlder ? (
                                            <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin" />
                                        ) : (
                                            <Icon name="arrow-up-s" className="size-3.5 shrink-0" />
                                        )}
                                        <span>{t('chat.promptNavigator.loadMore')}</span>
                                    </button>
                                </li>
                            ) : null}
                            {prompts.map((prompt) => {
                                const isActive = prompt.turnId === activeTurnId;
                                const preview = prompt.preview.trim() || t('chat.timeline.noTextContent');

                                return (
                                    <li key={prompt.turnId}>
                                        <button
                                            type="button"
                                            className={cn(
                                                'flex w-full items-start rounded-lg px-2.5 py-2 text-left transition-colors',
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
}

import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getMessagePreview } from '../lib/messagePreview';

type PromptMarker = {
    turnId: string;
    topPercent: number;
    preview: string;
    index: number;
};

type PromptNavigatorRailProps = {
    turnIds: string[];
    turnMessageStartIndexes: number[];
    messageCount: number;
    previewsByTurnId: Map<string, Part[]>;
    activeTurnId: string | null;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    onSelectTurn: (turnId: string) => void;
};

const MARKER_HIT_HEIGHT_PX = 12;
const MIN_MARKERS = 2;

const resolveTurnOffsetTop = (
    container: HTMLElement,
    turnId: string,
    index: number,
    turnIds: string[],
    turnMessageStartIndexes: number[],
    messageCount: number,
): number => {
    const element = container.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
    if (element) {
        const containerTop = container.getBoundingClientRect().top;
        return element.getBoundingClientRect().top - containerTop + container.scrollTop;
    }

    const scrollHeight = container.scrollHeight;
    const startIndex = turnMessageStartIndexes[index];
    if (typeof startIndex === 'number' && messageCount > 0) {
        return (startIndex / messageCount) * scrollHeight;
    }

    const denominator = Math.max(turnIds.length - 1, 1);
    return (index / denominator) * scrollHeight;
};

const buildMarkers = (
    container: HTMLElement,
    turnIds: string[],
    turnMessageStartIndexes: number[],
    messageCount: number,
    previewsByTurnId: Map<string, Part[]>,
): PromptMarker[] => {
    const scrollHeight = container.scrollHeight;
    if (scrollHeight <= 0 || turnIds.length === 0) {
        return [];
    }

    return turnIds.map((turnId, index) => {
        const offsetTop = resolveTurnOffsetTop(
            container,
            turnId,
            index,
            turnIds,
            turnMessageStartIndexes,
            messageCount,
        );
        const topPercent = Math.min(100, Math.max(0, (offsetTop / scrollHeight) * 100));
        const parts = previewsByTurnId.get(turnId) ?? [];
        const preview = getMessagePreview(parts, 120);

        return {
            turnId,
            topPercent,
            preview,
            index,
        };
    });
};

export const PromptNavigatorRail: React.FC<PromptNavigatorRailProps> = ({
    turnIds,
    turnMessageStartIndexes,
    messageCount,
    previewsByTurnId,
    activeTurnId,
    scrollRef,
    onSelectTurn,
}) => {
    const { t } = useI18n();
    const [markers, setMarkers] = React.useState<PromptMarker[]>([]);

    const refreshMarkers = React.useCallback(() => {
        const container = scrollRef.current;
        if (!container) {
            setMarkers([]);
            return;
        }

        setMarkers(buildMarkers(
            container,
            turnIds,
            turnMessageStartIndexes,
            messageCount,
            previewsByTurnId,
        ));
    }, [messageCount, previewsByTurnId, scrollRef, turnIds, turnMessageStartIndexes]);

    React.useLayoutEffect(() => {
        refreshMarkers();
    }, [refreshMarkers]);

    React.useEffect(() => {
        const container = scrollRef.current;
        if (!container) {
            return;
        }

        let rafId = 0;
        const scheduleRefresh = () => {
            if (rafId) {
                return;
            }
            rafId = requestAnimationFrame(() => {
                rafId = 0;
                refreshMarkers();
            });
        };

        container.addEventListener('scroll', scheduleRefresh, { passive: true });

        let resizeObserver: ResizeObserver | undefined;
        if (typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(scheduleRefresh);
            resizeObserver.observe(container);
        }

        let mutationObserver: MutationObserver | undefined;
        if (typeof MutationObserver !== 'undefined') {
            mutationObserver = new MutationObserver(scheduleRefresh);
            mutationObserver.observe(container, { childList: true, subtree: true });
        }

        return () => {
            container.removeEventListener('scroll', scheduleRefresh);
            if (rafId) {
                cancelAnimationFrame(rafId);
            }
            resizeObserver?.disconnect();
            mutationObserver?.disconnect();
        };
    }, [refreshMarkers, scrollRef]);

    if (turnIds.length < MIN_MARKERS) {
        return null;
    }

    return (
        <nav
            aria-label={t('chat.promptNavigator.aria')}
            className="pointer-events-none absolute inset-y-0 right-2 z-20 w-4"
        >
            <div className="relative h-full">
                {markers.map((marker) => {
                    const isActive = marker.turnId === activeTurnId;
                    const hasPreview = marker.preview.trim().length > 0;

                    return (
                        <Tooltip key={marker.turnId} delayDuration={120}>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    className={cn(
                                        'pointer-events-auto absolute left-1/2 flex -translate-x-1/2 items-center justify-center rounded-full',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focusRing)]',
                                    )}
                                    style={{
                                        top: `calc(${marker.topPercent}% - ${MARKER_HIT_HEIGHT_PX / 2}px)`,
                                        width: '16px',
                                        height: `${MARKER_HIT_HEIGHT_PX}px`,
                                    }}
                                    aria-label={t('chat.promptNavigator.goToPrompt', { number: marker.index + 1 })}
                                    onClick={() => {
                                        onSelectTurn(marker.turnId);
                                    }}
                                >
                                    <span
                                        aria-hidden="true"
                                        className={cn(
                                            'block rounded-full transition-colors',
                                            isActive
                                                ? 'h-0.5 w-3.5 bg-[var(--surface-foreground)]'
                                                : 'h-px w-2.5 bg-[var(--surface-mutedForeground)]/45 hover:bg-[var(--surface-mutedForeground)]/80',
                                        )}
                                    />
                                </button>
                            </TooltipTrigger>
                            {hasPreview ? (
                                <TooltipContent
                                    side="left"
                                    align="center"
                                    sideOffset={8}
                                    className="max-w-[min(18rem,calc(100vw-4rem))] whitespace-normal text-left"
                                >
                                    {marker.preview}
                                </TooltipContent>
                            ) : null}
                        </Tooltip>
                    );
                })}
            </div>
        </nav>
    );
};

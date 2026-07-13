import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';

import { Icon } from '@/components/icon/Icon';
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

const PREVIEW_MAX_CHARS = 160;
// The whole gutter is one hover/click target: the cursor's vertical position
// maps to the nearest tick, so tick density never demands pointer precision.
const GUTTER_WIDTH_PX = 28;
// The rail shows at most a window of ticks; hovering the gutter edges
// carousels the window through the rest of the prompts.
const MAX_VISIBLE_TICKS = 30;
const TICK_PITCH_PX = 12;
const EDGE_ZONE_PX = 18;
const CAROUSEL_INTERVAL_MS = 80;
const TICK_OVERSCAN = 4;
// Tick lengths for the proximity wave around the cursor.
const TICK_BASE_WIDTH_PX = 10;
const TICK_ACTIVE_WIDTH_PX = 14;
const TICK_FOCUS_WIDTH_PX = 20;

const buildPromptEntries = (
    turnIds: string[],
    previewsByTurnId: Map<string, Part[]>,
): PromptEntry[] => {
    return turnIds.map((turnId) => {
        const parts = previewsByTurnId.get(turnId) ?? [];
        return {
            turnId,
            preview: getMessagePreview(parts, PREVIEW_MAX_CHARS),
        };
    });
};

// Codex-style wave: the highlighted tick stretches, neighbours taper off.
const PROXIMITY_FALLOFF = [1, 0.6, 0.35, 0.15];

const resolveTickWidth = (
    index: number,
    highlightedIndex: number | null,
    isActive: boolean,
): number => {
    const base = isActive ? TICK_ACTIVE_WIDTH_PX : TICK_BASE_WIDTH_PX;
    if (highlightedIndex === null) {
        return base;
    }
    const distance = Math.abs(index - highlightedIndex);
    const factor = PROXIMITY_FALLOFF[distance] ?? 0;
    return Math.round(base + (TICK_FOCUS_WIDTH_PX - base) * factor);
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
    const isKeyboardNavOpen = useUIStore((state) => state.isPromptNavigatorPanelOpen);
    const setPromptNavigatorPanelOpen = useUIStore((state) => state.setPromptNavigatorPanelOpen);
    const gutterRef = React.useRef<HTMLDivElement | null>(null);
    const [highlightedIndex, setHighlightedIndex] = React.useState<number | null>(null);
    const [windowStart, setWindowStart] = React.useState(0);

    const prompts = React.useMemo(
        () => buildPromptEntries(turnIds, previewsByTurnId),
        [previewsByTurnId, turnIds],
    );

    const visibleCount = Math.min(prompts.length, MAX_VISIBLE_TICKS);
    const maxWindowStart = Math.max(0, prompts.length - visibleCount);
    const clampedWindowStart = Math.min(windowStart, maxWindowStart);
    const windowEnd = clampedWindowStart + visibleCount;
    const hasMoreAbove = clampedWindowStart > 0;
    const hasMoreBelow = windowEnd < prompts.length;

    const emptyPreviewLabel = t('chat.timeline.noTextContent');
    const currentPromptLabel = t('chat.promptNavigator.currentPrompt');
    const loadMoreLabel = t('chat.promptNavigator.loadMore');

    const activeIndex = React.useMemo(() => {
        if (!activeTurnId) {
            return -1;
        }
        return prompts.findIndex((prompt) => prompt.turnId === activeTurnId);
    }, [activeTurnId, prompts]);

    // Refs mirroring hot values so the carousel interval reads fresh state.
    const windowStartRef = React.useRef(clampedWindowStart);
    windowStartRef.current = clampedWindowStart;
    const promptsLengthRef = React.useRef(prompts.length);
    promptsLengthRef.current = prompts.length;
    const pointerYRef = React.useRef<number | null>(null);
    const carouselTimerRef = React.useRef<number | null>(null);
    const carouselDirRef = React.useRef<0 | 1 | -1>(0);

    const ensureWindowContains = React.useCallback((index: number) => {
        setWindowStart((start) => {
            const length = promptsLengthRef.current;
            const count = Math.min(length, MAX_VISIBLE_TICKS);
            const maxStart = Math.max(0, length - count);
            const clamped = Math.min(start, maxStart);
            if (index < clamped) {
                return index;
            }
            if (index >= clamped + count) {
                return Math.min(maxStart, index - count + 1);
            }
            return clamped;
        });
    }, []);

    // Load-earlier prepends shift every index; move the window with them so
    // the visible ticks (and the active one) don't jump around.
    const firstTurnIdRef = React.useRef<string | undefined>(prompts[0]?.turnId);
    const prevLengthRef = React.useRef(prompts.length);
    React.useLayoutEffect(() => {
        const prevFirst = firstTurnIdRef.current;
        const prevLength = prevLengthRef.current;
        const added = prompts.length - prevLength;
        if (added > 0 && prevLength > 0 && prevFirst && prompts[0]?.turnId !== prevFirst) {
            setWindowStart((start) => start + added);
            setHighlightedIndex((index) => (index === null ? null : index + added));
        }
        firstTurnIdRef.current = prompts[0]?.turnId;
        prevLengthRef.current = prompts.length;
    }, [prompts]);

    // While the user isn't interacting with the rail, the tape glides so the
    // active prompt stays centered — the scale moves, not the marker.
    React.useEffect(() => {
        if (highlightedIndex !== null) {
            return;
        }
        const target = activeIndex >= 0 ? activeIndex : prompts.length - 1;
        setWindowStart(() => {
            const length = promptsLengthRef.current;
            const count = Math.min(length, MAX_VISIBLE_TICKS);
            const maxStart = Math.max(0, length - count);
            return Math.max(0, Math.min(maxStart, target - Math.floor(count / 2)));
        });
    }, [activeIndex, highlightedIndex, prompts.length]);

    const relativeIndexFromPointer = React.useCallback((clientY: number): number | null => {
        const gutter = gutterRef.current;
        if (!gutter) {
            return null;
        }
        const rect = gutter.getBoundingClientRect();
        const raw = Math.floor((clientY - rect.top) / TICK_PITCH_PX);
        const count = Math.min(promptsLengthRef.current, MAX_VISIBLE_TICKS);
        if (count === 0) {
            return null;
        }
        return Math.max(0, Math.min(count - 1, raw));
    }, []);

    const stopCarousel = React.useCallback(() => {
        carouselDirRef.current = 0;
        if (carouselTimerRef.current !== null) {
            window.clearInterval(carouselTimerRef.current);
            carouselTimerRef.current = null;
        }
    }, []);

    const carouselStep = React.useCallback(() => {
        const dir = carouselDirRef.current;
        if (dir === 0) {
            stopCarousel();
            return;
        }
        const length = promptsLengthRef.current;
        const count = Math.min(length, MAX_VISIBLE_TICKS);
        const maxStart = Math.max(0, length - count);
        const current = Math.min(windowStartRef.current, maxStart);
        const next = Math.max(0, Math.min(maxStart, current + dir));
        if (next === current) {
            stopCarousel();
            return;
        }
        windowStartRef.current = next;
        setWindowStart(next);
        const pointerY = pointerYRef.current;
        if (pointerY !== null) {
            const relative = relativeIndexFromPointer(pointerY);
            if (relative !== null) {
                setHighlightedIndex(Math.min(length - 1, next + relative));
            }
        }
    }, [relativeIndexFromPointer, stopCarousel]);

    const updateCarousel = React.useCallback((clientY: number) => {
        const gutter = gutterRef.current;
        if (!gutter) {
            return;
        }
        const rect = gutter.getBoundingClientRect();
        const y = clientY - rect.top;
        let dir: 0 | 1 | -1 = 0;
        if (y <= EDGE_ZONE_PX && hasMoreAbove) {
            dir = -1;
        } else if (y >= rect.height - EDGE_ZONE_PX && hasMoreBelow) {
            dir = 1;
        }
        carouselDirRef.current = dir;
        if (dir === 0) {
            stopCarousel();
            return;
        }
        if (carouselTimerRef.current === null) {
            carouselTimerRef.current = window.setInterval(carouselStep, CAROUSEL_INTERVAL_MS);
        }
    }, [carouselStep, hasMoreAbove, hasMoreBelow, stopCarousel]);

    React.useEffect(() => () => {
        if (carouselTimerRef.current !== null) {
            window.clearInterval(carouselTimerRef.current);
        }
    }, []);

    const handlePointerMove = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        pointerYRef.current = event.clientY;
        const relative = relativeIndexFromPointer(event.clientY);
        if (relative !== null) {
            setHighlightedIndex(
                Math.min(promptsLengthRef.current - 1, windowStartRef.current + relative),
            );
        }
        updateCarousel(event.clientY);
    }, [relativeIndexFromPointer, updateCarousel]);

    const handlePointerLeave = React.useCallback(() => {
        pointerYRef.current = null;
        stopCarousel();
        setHighlightedIndex(null);
    }, [stopCarousel]);

    const closeKeyboardNav = React.useCallback(() => {
        setPromptNavigatorPanelOpen(false);
    }, [setPromptNavigatorPanelOpen]);

    const handleSelect = React.useCallback((index: number | null) => {
        if (index === null) {
            return;
        }
        const prompt = prompts[index];
        if (!prompt) {
            return;
        }
        onSelectTurn(prompt.turnId);
        stopCarousel();
        setHighlightedIndex(null);
        closeKeyboardNav();
        gutterRef.current?.blur();
    }, [closeKeyboardNav, onSelectTurn, prompts, stopCarousel]);

    const handleGutterClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const relative = relativeIndexFromPointer(event.clientY);
        if (relative === null) {
            return;
        }
        handleSelect(Math.min(prompts.length - 1, windowStartRef.current + relative));
    }, [handleSelect, prompts.length, relativeIndexFromPointer]);

    // Keyboard shortcut flips the store flag; entering keyboard mode focuses
    // the gutter and highlights the active (or last) prompt.
    React.useEffect(() => {
        if (!isKeyboardNavOpen) {
            return;
        }
        const gutter = gutterRef.current;
        if (!gutter || gutter === document.activeElement) {
            return;
        }
        gutter.focus();
        setHighlightedIndex((current) => {
            if (current !== null) {
                return current;
            }
            const target = activeIndex >= 0 ? activeIndex : prompts.length - 1;
            ensureWindowContains(target);
            return target;
        });
    }, [activeIndex, ensureWindowContains, isKeyboardNavOpen, prompts.length]);

    React.useEffect(() => () => {
        setPromptNavigatorPanelOpen(false);
    }, [setPromptNavigatorPanelOpen]);

    const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (prompts.length === 0) {
            return;
        }
        const current = highlightedIndex ?? (activeIndex >= 0 ? activeIndex : prompts.length - 1);

        const moveTo = (index: number) => {
            const next = Math.max(0, Math.min(prompts.length - 1, index));
            ensureWindowContains(next);
            setHighlightedIndex(next);
        };

        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            moveTo(current + (event.key === 'ArrowUp' ? -1 : 1));
            return;
        }
        if (event.key === 'Home') {
            event.preventDefault();
            moveTo(0);
            return;
        }
        if (event.key === 'End') {
            event.preventDefault();
            moveTo(prompts.length - 1);
            return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleSelect(current);
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            setHighlightedIndex(null);
            closeKeyboardNav();
            gutterRef.current?.blur();
        }
    }, [activeIndex, closeKeyboardNav, ensureWindowContains, handleSelect, highlightedIndex, prompts.length]);

    const handleBlur = React.useCallback(() => {
        stopCarousel();
        setHighlightedIndex(null);
        closeKeyboardNav();
    }, [closeKeyboardNav, stopCarousel]);

    const highlightedPrompt = highlightedIndex !== null ? prompts[highlightedIndex] : undefined;
    // Overscan a few ticks beyond the window so they slide in under the
    // gradient mask instead of popping into existence at the edges.
    const overscanStart = Math.max(0, clampedWindowStart - TICK_OVERSCAN);
    const overscanEnd = Math.min(prompts.length, windowEnd + TICK_OVERSCAN);
    const visiblePrompts = prompts.slice(overscanStart, overscanEnd);
    const gutterMask = hasMoreAbove || hasMoreBelow
        ? `linear-gradient(to bottom, ${hasMoreAbove ? 'transparent, black 14%' : 'black'}, ${hasMoreBelow ? 'black 86%, transparent' : 'black'})`
        : undefined;

    if (prompts.length === 0) {
        return null;
    }

    return (
        <nav
            aria-label={t('chat.promptNavigator.aria')}
            className="pointer-events-none absolute right-1.5 top-1/2 z-20 -translate-y-1/2"
        >
            <div className="pointer-events-auto flex flex-col items-end">
                {canLoadEarlier ? (
                    <button
                        type="button"
                        tabIndex={-1}
                        className={cn(
                            // Nudge so the icon centers over the tick column
                            // (ticks sit at right-1 with a 10px base width).
                            '-mr-px mb-1.5 flex size-5 shrink-0 items-center justify-center rounded-full',
                            'text-[var(--surface-mutedForeground)] transition-colors',
                            'hover:bg-[var(--interactive-hover)]/60 hover:text-[var(--surface-foreground)]',
                            isLoadingOlder ? 'cursor-wait opacity-70' : undefined,
                        )}
                        aria-label={loadMoreLabel}
                        title={loadMoreLabel}
                        disabled={isLoadingOlder}
                        onClick={(event) => {
                            event.stopPropagation();
                            if (!isLoadingOlder) {
                                onLoadEarlier();
                            }
                        }}
                    >
                        {isLoadingOlder ? (
                            <Icon name="loader-4" className="size-3.5 animate-spin" />
                        ) : (
                            <Icon name="arrow-up-s" className="size-3.5" />
                        )}
                    </button>
                ) : null}
                <div
                    ref={gutterRef}
                    role="listbox"
                    tabIndex={-1}
                    aria-activedescendant={
                        highlightedPrompt ? `prompt-rail-tick-${highlightedPrompt.turnId}` : undefined
                    }
                    className="relative cursor-pointer outline-none"
                    style={{
                        width: `${GUTTER_WIDTH_PX}px`,
                        height: `${visibleCount * TICK_PITCH_PX}px`,
                    }}
                    onMouseMove={handlePointerMove}
                    onMouseLeave={handlePointerLeave}
                    onClick={handleGutterClick}
                    onKeyDown={handleKeyDown}
                    onBlur={handleBlur}
                >
                    <div
                        className="absolute inset-0 overflow-hidden"
                        style={gutterMask ? { maskImage: gutterMask, WebkitMaskImage: gutterMask } : undefined}
                    >
                        {/* The tape: ticks keep their absolute position on the
                            strip, and the strip itself glides. */}
                        <div
                            // Remount on prepend so the index shift doesn't
                            // play as a spurious slide animation.
                            key={prompts[0]?.turnId}
                            className="absolute inset-x-0 top-0 transition-transform duration-300 ease-out"
                            style={{ transform: `translateY(-${clampedWindowStart * TICK_PITCH_PX}px)` }}
                        >
                            {visiblePrompts.map((prompt, slot) => {
                                const index = overscanStart + slot;
                                const isActive = prompt.turnId === activeTurnId;
                                const isHighlighted = highlightedIndex === index;
                                const tickWidth = resolveTickWidth(index, highlightedIndex, isActive);

                                return (
                                    <div
                                        key={prompt.turnId}
                                        id={`prompt-rail-tick-${prompt.turnId}`}
                                        role="option"
                                        aria-selected={isHighlighted}
                                        aria-current={isActive ? 'true' : undefined}
                                        aria-label={prompt.preview.trim() || emptyPreviewLabel}
                                        className="pointer-events-none absolute right-1 flex items-center justify-end"
                                        style={{ top: `${index * TICK_PITCH_PX}px`, height: `${TICK_PITCH_PX}px` }}
                                    >
                                        <span
                                            aria-hidden="true"
                                            className={cn(
                                                'block h-0.5 rounded-full transition-all duration-200 ease-out',
                                                isActive
                                                    ? 'bg-[var(--surface-foreground)]'
                                                    : isHighlighted
                                                        ? 'bg-[var(--surface-foreground)]/80'
                                                        : 'bg-[var(--surface-foreground)]/30',
                                            )}
                                            style={{ width: `${tickWidth}px` }}
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                    {highlightedPrompt && highlightedIndex !== null ? (
                        <div
                            className={cn(
                                'pointer-events-none absolute right-full z-30 mr-3 -translate-y-1/2',
                                'w-[min(20rem,calc(100vw-6rem))] rounded-xl border border-[var(--interactive-border)]/60',
                                'bg-[var(--surface-elevated)] px-3 py-2 shadow-md',
                            )}
                            style={{
                                top: `${(highlightedIndex - clampedWindowStart) * TICK_PITCH_PX + TICK_PITCH_PX / 2}px`,
                            }}
                        >
                            <span className="typography-meta line-clamp-3 block text-[var(--surface-foreground)]">
                                {highlightedPrompt.preview.trim() || emptyPreviewLabel}
                            </span>
                            {highlightedPrompt.turnId === activeTurnId ? (
                                <span className="mt-0.5 block typography-micro text-[var(--surface-mutedForeground)]">
                                    {currentPromptLabel}
                                </span>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            </div>
        </nav>
    );
}

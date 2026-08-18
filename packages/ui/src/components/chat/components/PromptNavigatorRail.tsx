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
// When the centered message column extends under the full-width gutter (narrow
// windows), the hit zone shrinks so it can't swallow clicks on the right edge
// of user bubbles (expand/collapse).
const GUTTER_WIDTH_PX = 28;
const GUTTER_NARROW_WIDTH_PX = 12;
const GUTTER_RIGHT_OFFSET_PX = 6;
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
// The hover preview is a scrolling mini-list of all prompts: the highlighted
// row stays centered while the list glides, and the panel itself is
// interactive so imprecise gutter hits can be corrected inside the list.
// Rows are fixed-pitch and fit up to two preview lines; short prompts just
// center vertically. Fixed pitch keeps the glide/virtualization math simple.
// Each row renders as a bordered card inset within its pitch slot so
// neighbouring prompts read as separate items instead of one text run.
const PANEL_ROW_HEIGHT_PX = 54;
const PANEL_ROW_INSET_Y_PX = 4;
const PANEL_MAX_ROWS = 8;
const PANEL_SCROLL_MARGIN_ROWS = 2;
const PANEL_HIDE_DELAY_MS = 160;

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
    const navRef = React.useRef<HTMLElement | null>(null);
    const [highlightedIndex, setHighlightedIndex] = React.useState<number | null>(null);
    const [windowStart, setWindowStart] = React.useState(0);
    const [isNarrowGutter, setIsNarrowGutter] = React.useState(false);

    // Shrink the hit zone whenever the message column reaches under the
    // full-width gutter, so bubble clicks (expand/collapse) stay clickable.
    React.useEffect(() => {
        const container = navRef.current?.parentElement;
        if (!container || typeof ResizeObserver === 'undefined') {
            return;
        }
        const measure = () => {
            const column = container.querySelector('.chat-message-column');
            if (!column) {
                setIsNarrowGutter(false);
                return;
            }
            const containerRect = container.getBoundingClientRect();
            const columnRect = column.getBoundingClientRect();
            const fullGutterLeft = containerRect.right - GUTTER_RIGHT_OFFSET_PX - GUTTER_WIDTH_PX;
            setIsNarrowGutter(columnRect.right > fullGutterLeft);
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(container);
        return () => observer.disconnect();
    }, []);

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

    // Leaving the gutter hides the panel after a short grace period so the
    // pointer can travel into the panel and interact with the list directly.
    const hideTimerRef = React.useRef<number | null>(null);
    const cancelScheduledHide = React.useCallback(() => {
        if (hideTimerRef.current !== null) {
            window.clearTimeout(hideTimerRef.current);
            hideTimerRef.current = null;
        }
    }, []);
    const scheduleHide = React.useCallback(() => {
        cancelScheduledHide();
        hideTimerRef.current = window.setTimeout(() => {
            hideTimerRef.current = null;
            setHighlightedIndex(null);
        }, PANEL_HIDE_DELAY_MS);
    }, [cancelScheduledHide]);
    React.useEffect(() => () => {
        if (hideTimerRef.current !== null) {
            window.clearTimeout(hideTimerRef.current);
        }
    }, []);

    const handlePointerMove = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        cancelScheduledHide();
        pointerYRef.current = event.clientY;
        const relative = relativeIndexFromPointer(event.clientY);
        if (relative !== null) {
            setHighlightedIndex(
                Math.min(promptsLengthRef.current - 1, windowStartRef.current + relative),
            );
        }
        updateCarousel(event.clientY);
    }, [cancelScheduledHide, relativeIndexFromPointer, updateCarousel]);

    const handlePointerLeave = React.useCallback(() => {
        pointerYRef.current = null;
        stopCarousel();
        scheduleHide();
    }, [scheduleHide, stopCarousel]);

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

    // Wheel over the panel steps the highlight instead of scrolling the chat
    // underneath; a native non-passive listener is required for preventDefault.
    const panelRef = React.useRef<HTMLDivElement | null>(null);
    const highlightedIndexRef = React.useRef(highlightedIndex);
    highlightedIndexRef.current = highlightedIndex;
    const isPanelVisible = highlightedIndex !== null;
    const wheelRemainderRef = React.useRef(0);
    React.useEffect(() => {
        const panel = panelRef.current;
        if (!panel) {
            return;
        }
        const handleWheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
            wheelRemainderRef.current += event.deltaY;
            const steps = Math.trunc(wheelRemainderRef.current / PANEL_ROW_HEIGHT_PX);
            if (steps === 0) {
                return;
            }
            wheelRemainderRef.current -= steps * PANEL_ROW_HEIGHT_PX;
            const current = highlightedIndexRef.current;
            if (current === null) {
                return;
            }
            const next = Math.max(0, Math.min(promptsLengthRef.current - 1, current + steps));
            if (next !== current) {
                ensureWindowContains(next);
                setHighlightedIndex(next);
            }
        };
        panel.addEventListener('wheel', handleWheel, { passive: false });
        return () => panel.removeEventListener('wheel', handleWheel);
    }, [ensureWindowContains, isPanelVisible]);

    const highlightedPrompt = highlightedIndex !== null ? prompts[highlightedIndex] : undefined;
    // Panel list geometry: centered on the highlight when the panel opens,
    // then a dead zone — the list only glides when the highlighted row gets
    // within one row of the window edge, so small pointer moves don't scroll.
    const panelVisibleRows = Math.min(prompts.length, PANEL_MAX_ROWS);
    const panelHeight = panelVisibleRows * PANEL_ROW_HEIGHT_PX;
    const panelMaxOffset = prompts.length * PANEL_ROW_HEIGHT_PX - panelHeight;
    const clampPanelOffset = (offset: number) => Math.max(0, Math.min(panelMaxOffset, offset));
    const panelOffsetRef = React.useRef<number | null>(null);
    let panelScrollOffset = 0;
    if (highlightedIndex === null) {
        panelOffsetRef.current = null;
    } else if (panelOffsetRef.current === null) {
        panelScrollOffset = clampPanelOffset(
            highlightedIndex * PANEL_ROW_HEIGHT_PX - (panelHeight - PANEL_ROW_HEIGHT_PX) / 2,
        );
        panelOffsetRef.current = panelScrollOffset;
    } else {
        let offset = panelOffsetRef.current;
        // Keep two rows of context visible above and below the highlight —
        // the dead zone is the middle third of the window, so the list glides
        // noticeably before the highlight reaches the edge but small pointer
        // moves around the center don't scroll.
        const highestAllowed = (highlightedIndex - PANEL_SCROLL_MARGIN_ROWS) * PANEL_ROW_HEIGHT_PX;
        const lowestAllowed =
            (highlightedIndex + 1 + PANEL_SCROLL_MARGIN_ROWS) * PANEL_ROW_HEIGHT_PX - panelHeight;
        if (offset > highestAllowed) {
            offset = highestAllowed;
        } else if (offset < lowestAllowed) {
            offset = lowestAllowed;
        }
        panelScrollOffset = clampPanelOffset(offset);
        panelOffsetRef.current = panelScrollOffset;
    }
    // Only rows near the visible window are rendered; extra rows slide in
    // under the mask during the glide instead of popping in at the edges.
    const panelFirstVisibleRow = Math.floor(panelScrollOffset / PANEL_ROW_HEIGHT_PX);
    const panelSliceStart = Math.max(0, panelFirstVisibleRow - TICK_OVERSCAN);
    const panelSliceEnd = Math.min(prompts.length, panelFirstVisibleRow + panelVisibleRows + TICK_OVERSCAN);
    const panelClippedAbove = panelScrollOffset > 0;
    const panelClippedBelow = panelScrollOffset < panelMaxOffset;
    const panelMask = panelClippedAbove || panelClippedBelow
        ? `linear-gradient(to bottom, ${panelClippedAbove ? 'transparent, black 10%' : 'black'}, ${panelClippedBelow ? 'black 90%, transparent' : 'black'})`
        : undefined;
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
            ref={navRef}
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
                        width: `${isNarrowGutter ? GUTTER_NARROW_WIDTH_PX : GUTTER_WIDTH_PX}px`,
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
                            ref={panelRef}
                            className={cn(
                                'pointer-events-auto absolute right-full top-1/2 z-30 mr-3 -translate-y-1/2',
                                'w-[min(20rem,calc(100vw-6rem))] overflow-hidden rounded-xl',
                                'border border-[var(--interactive-border)]/60 bg-[var(--surface-elevated)] py-1 shadow-md',
                            )}
                            onMouseEnter={cancelScheduledHide}
                            onMouseLeave={scheduleHide}
                            onMouseMove={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                        >
                            <div
                                className="relative overflow-hidden"
                                style={{
                                    height: `${panelVisibleRows * PANEL_ROW_HEIGHT_PX}px`,
                                    maskImage: panelMask,
                                    WebkitMaskImage: panelMask,
                                }}
                            >
                                {/* The list glides so the highlighted row stays
                                    centered while scrubbing the rail. */}
                                <div
                                    className="absolute inset-x-0 top-0 transition-transform duration-200 ease-out"
                                    style={{
                                        height: `${prompts.length * PANEL_ROW_HEIGHT_PX}px`,
                                        transform: `translateY(-${panelScrollOffset}px)`,
                                    }}
                                >
                                    {prompts.slice(panelSliceStart, panelSliceEnd).map((prompt, slot) => {
                                        const index = panelSliceStart + slot;
                                        const isActive = prompt.turnId === activeTurnId;
                                        const isHighlighted = highlightedIndex === index;
                                        return (
                                            <div
                                                key={prompt.turnId}
                                                role="option"
                                                aria-selected={isHighlighted}
                                                aria-current={isActive ? 'true' : undefined}
                                                title={isActive ? currentPromptLabel : undefined}
                                                className="absolute inset-x-0 cursor-pointer px-1.5"
                                                style={{
                                                    top: `${index * PANEL_ROW_HEIGHT_PX + PANEL_ROW_INSET_Y_PX}px`,
                                                    height: `${PANEL_ROW_HEIGHT_PX - PANEL_ROW_INSET_Y_PX * 2}px`,
                                                }}
                                                onMouseMove={() => {
                                                    cancelScheduledHide();
                                                    if (highlightedIndexRef.current !== index) {
                                                        ensureWindowContains(index);
                                                        setHighlightedIndex(index);
                                                    }
                                                }}
                                                onClick={() => handleSelect(index)}
                                            >
                                                <div
                                                    className={cn(
                                                        'flex h-full items-center rounded-lg border px-2 transition-colors',
                                                        isActive
                                                            ? 'border-transparent bg-[var(--interactive-selection)]'
                                                            : isHighlighted
                                                                ? 'border-[var(--interactive-border)]/60 bg-[var(--interactive-hover)]'
                                                                : 'border-[var(--interactive-border)]/40',
                                                    )}
                                                >
                                                    <span
                                                        className={cn(
                                                            // Fill both clamp lines to the edge instead of
                                                            // leaving a ragged gap before a long next word.
                                                            'min-w-0 flex-1 line-clamp-2 [overflow-wrap:anywhere] typography-meta',
                                                            isActive
                                                                ? 'text-[var(--interactive-selectionForeground)]'
                                                                : 'text-[var(--surface-mutedForeground)]',
                                                        )}
                                                    >
                                                        {prompt.preview.trim() || emptyPreviewLabel}
                                                    </span>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    ) : null}
                </div>
            </div>
        </nav>
    );
}

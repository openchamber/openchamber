import React from 'react';
import type { Part } from '@/lib/opencode/model';

import { Icon } from '@/components/icon/Icon';
import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { useI18n, type I18nKey, type I18nParams } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionMessageLoader } from '@/sync/sync-context';
import { useSourceControlDescriptorOf, type SourceControlDescriptorOf } from '@/lib/source-control/providers/registry';
import { cn } from '@/lib/utils';
import { getMessagePreview } from '../lib/messagePreview';
import { useChatColumnActions } from '../chatColumnSession';

type PromptEntry = {
    turnId: string;
    preview: string;
};

type PromptNavigatorRailProps = {
    sessionId: string;
    directory?: string;
    turnIds: string[];
    previewsByTurnId: Map<string, Part[]>;
    activeTurnId: string | null;
    onSelectTurn: (turnId: string) => void;
    canLoadEarlier: boolean;
    isLoadingOlder: boolean;
    onLoadEarlier: () => void;
};

// One line per row; the full text stays in the row's tooltip.
const PREVIEW_MAX_CHARS = 160;
// The indicator is a fixed glyph in the chat's top end corner: its size never
// depends on the prompt count, and the brighter tick only says roughly where
// the reader is in the session. Navigation happens in the panel.
const INDICATOR_TICKS = 5;
// A pointer resting on the indicator opens the panel; one only passing the
// corner on its way elsewhere does not.
const PANEL_SHOW_DELAY_MS = 120;
const PANEL_HIDE_DELAY_MS = 160;

const buildPromptEntries = (
    turnIds: string[],
    previewsByTurnId: Map<string, Part[]>,
    t: (key: I18nKey, params?: I18nParams) => string,
    descriptorOf: SourceControlDescriptorOf,
): PromptEntry[] => {
    return turnIds.map((turnId) => {
        const parts = previewsByTurnId.get(turnId) ?? [];
        return {
            turnId,
            preview: getMessagePreview(parts, PREVIEW_MAX_CHARS, t, descriptorOf),
        };
    });
};

/** Which of the indicator's ticks stands for the prompt at `index`. */
const resolveIndicatorTick = (index: number, total: number, ticks: number): number => {
    if (total <= 1 || ticks <= 1) {
        return 0;
    }
    return Math.round((index / (total - 1)) * (ticks - 1));
};

const rowId = (turnId: string) => `prompt-navigator-row-${turnId}`;

export function PromptNavigatorRail({
    sessionId,
    directory,
    turnIds,
    previewsByTurnId,
    activeTurnId,
    onSelectTurn,
    canLoadEarlier,
    isLoadingOlder,
    onLoadEarlier,
}: PromptNavigatorRailProps) {
    const { t } = useI18n();
    const descriptorOf = useSourceControlDescriptorOf();
    // The keyboard shortcut drives the main chat's navigator; a pinned
    // column's navigator neither opens on it nor closes it.
    const { pinned } = useChatColumnActions();
    const isKeyboardNavOpen = useUIStore((state) => (pinned ? false : state.isPromptNavigatorPanelOpen));
    const setPromptNavigatorPanelOpen = useUIStore((state) => state.setPromptNavigatorPanelOpen);
    const listRef = React.useRef<HTMLDivElement | null>(null);
    const [isHoverOpen, setIsHoverOpen] = React.useState(false);
    const [highlightedIndex, setHighlightedIndex] = React.useState<number | null>(null);
    const isOpen = isHoverOpen || isKeyboardNavOpen;

    // A reader at the chat's end has the history above the loaded window cut
    // back a moment after the turn count changes, and loading earlier prompts
    // changes it. While the panel is open its list is what the reader looks
    // at, so it holds the history like a reader scrolled up does.
    const messageLoader = useSessionMessageLoader();
    React.useEffect(() => {
        if (!isOpen || !directory) {
            return;
        }
        return messageLoader.retainSessionHistory({ directory, sessionID: sessionId }, 'browsing');
    }, [directory, isOpen, messageLoader, sessionId]);

    const prompts = React.useMemo(
        () => buildPromptEntries(turnIds, previewsByTurnId, t, descriptorOf),
        [descriptorOf, previewsByTurnId, t, turnIds],
    );
    const activeIndex = React.useMemo(() => {
        if (!activeTurnId) {
            return -1;
        }
        return prompts.findIndex((prompt) => prompt.turnId === activeTurnId);
    }, [activeTurnId, prompts]);
    const currentIndex = activeIndex >= 0 ? activeIndex : prompts.length - 1;

    const emptyPreviewLabel = t('chat.timeline.noTextContent');
    const currentPromptLabel = t('chat.promptNavigator.currentPrompt');
    const loadMoreLabel = t('chat.promptNavigator.loadMore');

    const showTimerRef = React.useRef<number | null>(null);
    const hideTimerRef = React.useRef<number | null>(null);
    // After a pick the panel closes under a pointer that may rest on the
    // indicator; it opens again only once the pointer has left the corner.
    const suppressHoverRef = React.useRef(false);
    const clearTimers = React.useCallback(() => {
        if (showTimerRef.current !== null) {
            window.clearTimeout(showTimerRef.current);
            showTimerRef.current = null;
        }
        if (hideTimerRef.current !== null) {
            window.clearTimeout(hideTimerRef.current);
            hideTimerRef.current = null;
        }
    }, []);
    React.useEffect(() => clearTimers, [clearTimers]);

    const closeKeyboardNav = React.useCallback(() => {
        if (!pinned) setPromptNavigatorPanelOpen(false);
    }, [pinned, setPromptNavigatorPanelOpen]);
    React.useEffect(() => () => {
        if (!pinned) setPromptNavigatorPanelOpen(false);
    }, [pinned, setPromptNavigatorPanelOpen]);

    const close = React.useCallback(() => {
        clearTimers();
        setIsHoverOpen(false);
        setHighlightedIndex(null);
        closeKeyboardNav();
    }, [clearTimers, closeKeyboardNav]);

    const handleIndicatorEnter = React.useCallback(() => {
        if (suppressHoverRef.current) {
            return;
        }
        clearTimers();
        showTimerRef.current = window.setTimeout(() => {
            showTimerRef.current = null;
            setIsHoverOpen(true);
        }, PANEL_SHOW_DELAY_MS);
    }, [clearTimers]);

    const handleNavEnter = React.useCallback(() => {
        if (hideTimerRef.current !== null) {
            window.clearTimeout(hideTimerRef.current);
            hideTimerRef.current = null;
        }
    }, []);

    const handleNavLeave = React.useCallback(() => {
        suppressHoverRef.current = false;
        clearTimers();
        // The keyboard-opened panel stays until a pick, Escape or blur.
        if (!isHoverOpen || isKeyboardNavOpen) {
            return;
        }
        hideTimerRef.current = window.setTimeout(() => {
            hideTimerRef.current = null;
            setIsHoverOpen(false);
            setHighlightedIndex(null);
        }, PANEL_HIDE_DELAY_MS);
    }, [clearTimers, isHoverOpen, isKeyboardNavOpen]);

    const handleSelect = React.useCallback((index: number) => {
        const prompt = prompts[index];
        if (!prompt) {
            return;
        }
        onSelectTurn(prompt.turnId);
        suppressHoverRef.current = true;
        close();
    }, [close, onSelectTurn, prompts]);

    // Each opening shows the current prompt in the middle of the list; the
    // list then scrolls natively. Read through a ref: later updates (a new
    // prompt, the chat scrolling underneath) must not move the open list.
    const currentIndexRef = React.useRef(currentIndex);
    currentIndexRef.current = currentIndex;
    React.useLayoutEffect(() => {
        if (!isOpen) {
            return;
        }
        const list = listRef.current;
        const row = list?.querySelector<HTMLElement>(`[data-prompt-index="${currentIndexRef.current}"]`);
        if (!list || !row) {
            return;
        }
        list.scrollTop = row.offsetTop - (list.clientHeight - row.offsetHeight) / 2;
    }, [isOpen]);

    // Earlier prompts load into the top of the list; the prompt that was
    // first stays where it was on screen, and the highlight stays on its row.
    const firstTurnIdRef = React.useRef<string | undefined>(prompts[0]?.turnId);
    const prevLengthRef = React.useRef(prompts.length);
    React.useLayoutEffect(() => {
        const previousFirst = firstTurnIdRef.current;
        const added = prompts.length - prevLengthRef.current;
        firstTurnIdRef.current = prompts[0]?.turnId;
        prevLengthRef.current = prompts.length;
        if (added <= 0 || !previousFirst || prompts[0]?.turnId === previousFirst) {
            return;
        }
        setHighlightedIndex((index) => (index === null ? null : index + added));
        const list = listRef.current;
        const oldFirstRow = list ? document.getElementById(rowId(previousFirst)) : null;
        const newFirstRow = list?.firstElementChild;
        if (list && oldFirstRow && newFirstRow instanceof HTMLElement) {
            list.scrollTop += oldFirstRow.offsetTop - newFirstRow.offsetTop;
        }
    }, [prompts]);

    // The shortcut opens the panel with the keyboard in it.
    React.useEffect(() => {
        if (!isKeyboardNavOpen) {
            return;
        }
        listRef.current?.focus();
        setHighlightedIndex((index) => index ?? currentIndex);
    }, [currentIndex, isKeyboardNavOpen]);

    const moveHighlight = React.useCallback((index: number) => {
        const next = Math.max(0, Math.min(prompts.length - 1, index));
        setHighlightedIndex(next);
        // Scrolls the list only; scrollIntoView would also move the chat.
        const list = listRef.current;
        const prompt = prompts[next];
        const row = list && prompt ? document.getElementById(rowId(prompt.turnId)) : null;
        if (!list || !row) {
            return;
        }
        if (row.offsetTop < list.scrollTop) {
            list.scrollTop = row.offsetTop;
        } else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
            list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
        }
    }, [prompts]);

    const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (prompts.length === 0) {
            return;
        }
        const current = highlightedIndex ?? currentIndex;
        if (handleDropdownNavigationKey(event, (key) => moveHighlight(current + (key === 'ArrowUp' ? -1 : 1)))) {
            return;
        }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            moveHighlight(current + (event.key === 'ArrowUp' ? -1 : 1));
            return;
        }
        if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            moveHighlight(event.key === 'Home' ? 0 : prompts.length - 1);
            return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleSelect(current);
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            close();
            listRef.current?.blur();
        }
    }, [close, currentIndex, handleSelect, highlightedIndex, moveHighlight, prompts.length]);

    const handleListBlur = React.useCallback((event: React.FocusEvent<HTMLDivElement>) => {
        if (event.currentTarget.contains(event.relatedTarget)) {
            return;
        }
        if (isKeyboardNavOpen) {
            close();
        }
    }, [close, isKeyboardNavOpen]);

    if (prompts.length === 0) {
        return null;
    }

    const tickCount = Math.min(prompts.length, INDICATOR_TICKS);
    const currentTick = resolveIndicatorTick(currentIndex, prompts.length, tickCount);
    const highlightedPrompt = highlightedIndex !== null ? prompts[highlightedIndex] : undefined;

    return (
        <nav
            aria-label={t('chat.promptNavigator.aria')}
            // Spans the chat so the panel can take the room it needs; only the
            // indicator and the panel take the pointer.
            className="pointer-events-none absolute inset-3 z-20 flex flex-col items-end"
            onMouseEnter={handleNavEnter}
            onMouseLeave={handleNavLeave}
        >
            {isOpen ? (
                // Opens over the indicator, in its place.
                <div
                    className={cn(
                        // About a dozen rows, less in a short chat; the rest scrolls.
                        'pointer-events-auto flex max-h-[min(100%,24rem)] w-full max-w-80 flex-col overflow-hidden rounded-xl',
                        'oc-glass-popover oc-glass-floating',
                    )}
                >
                    {canLoadEarlier ? (
                        <button
                            type="button"
                            tabIndex={-1}
                            className={cn(
                                'mx-1 mt-1 flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-start',
                                'typography-meta text-muted-foreground transition-colors hover:text-foreground',
                                isLoadingOlder && 'cursor-wait',
                            )}
                            disabled={isLoadingOlder}
                            // Keeps the keyboard in the list.
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                                if (!isLoadingOlder) {
                                    onLoadEarlier();
                                }
                            }}
                        >
                            {isLoadingOlder ? (
                                <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin" />
                            ) : (
                                <Icon name="arrow-up-s" className="size-3.5 shrink-0" />
                            )}
                            <span className="truncate">{loadMoreLabel}</span>
                        </button>
                    ) : null}
                    <div
                        ref={listRef}
                        role="listbox"
                        tabIndex={-1}
                        aria-label={t('chat.promptNavigator.aria')}
                        aria-activedescendant={highlightedPrompt ? rowId(highlightedPrompt.turnId) : undefined}
                        // Positioned, so row offsets are measured within the list.
                        className="relative min-h-0 overflow-y-auto overscroll-contain p-1 outline-none"
                        onKeyDown={handleKeyDown}
                        onBlur={handleListBlur}
                    >
                        {prompts.map((prompt, index) => {
                            const isActive = index === activeIndex;
                            const isHighlighted = index === highlightedIndex;
                            const text = prompt.preview.trim() || emptyPreviewLabel;
                            return (
                                <div
                                    key={prompt.turnId}
                                    id={rowId(prompt.turnId)}
                                    role="option"
                                    aria-selected={isHighlighted}
                                    aria-current={isActive ? 'true' : undefined}
                                    data-prompt-index={index}
                                    title={isActive ? `${currentPromptLabel}: ${text}` : text}
                                    // The current prompt carries the only fill; the row
                                    // under the pointer or keyboard brightens its text.
                                    className={cn(
                                        'cursor-pointer truncate rounded-lg px-2 py-1.5 typography-meta',
                                        isActive
                                            ? 'bg-interactive-selection text-interactive-selection-foreground'
                                            : isHighlighted
                                                ? 'text-foreground'
                                                : 'oc-title-rest',
                                    )}
                                    onMouseMove={() => {
                                        if (highlightedIndex !== index) {
                                            setHighlightedIndex(index);
                                        }
                                    }}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() => handleSelect(index)}
                                >
                                    {text}
                                </div>
                            );
                        })}
                    </div>
                </div>
            ) : (
                <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t('chat.promptNavigator.aria')}
                    aria-haspopup="listbox"
                    aria-expanded={false}
                    // A backing in the chat's colour keeps text scrolling under
                    // the corner from running through the ticks. Opaque enough,
                    // no blur: a blur here is redrawn every streamed frame.
                    className="pointer-events-auto flex flex-col items-end gap-[3px] rounded-md bg-background/85 p-1.5"
                    onMouseEnter={handleIndicatorEnter}
                    onClick={() => {
                        clearTimers();
                        setIsHoverOpen(true);
                    }}
                >
                    {Array.from({ length: tickCount }, (_, tick) => (
                        <span
                            key={tick}
                            aria-hidden="true"
                            className={cn(
                                'block h-0.5 w-3 rounded-full',
                                tick === currentTick
                                    ? 'bg-[var(--surface-foreground)]'
                                    : 'bg-[var(--surface-foreground)]/30',
                            )}
                        />
                    ))}
                </button>
            )}
        </nav>
    );
}

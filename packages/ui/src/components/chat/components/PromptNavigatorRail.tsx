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
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

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

const PREVIEW_MAX_CHARS = 160;
const INDICATOR_TICKS = 5;
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
    const { pinned } = useChatColumnActions();
    const isKeyboardNavOpen = useUIStore((state) => (pinned ? false : state.isPromptNavigatorPanelOpen));
    const setPromptNavigatorPanelOpen = useUIStore((state) => state.setPromptNavigatorPanelOpen);
    const listRef = React.useRef<HTMLDivElement | null>(null);
    const [isHoverOpen, setIsHoverOpen] = React.useState(false);
    const [highlightedIndex, setHighlightedIndex] = React.useState<number | null>(null);
    const isOpen = isHoverOpen || isKeyboardNavOpen;

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
            className="oc-prompt-navigator pointer-events-none absolute inset-y-3 inset-s-3 z-20 flex flex-col items-end"
            onMouseEnter={handleNavEnter}
            onMouseLeave={handleNavLeave}
        >
            {isOpen ? (
                <div
                    className={cn(
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
                    <ScrollableOverlay
                        ref={listRef}
                        role="listbox"
                        tabIndex={-1}
                        aria-label={t('chat.promptNavigator.aria')}
                        aria-activedescendant={highlightedPrompt ? rowId(highlightedPrompt.turnId) : undefined}
                        outerClassName="min-h-0"
                        className="relative overscroll-contain p-1 outline-none"
                        onKeyDown={handleKeyDown}
                        onBlur={handleListBlur}
                        disableHorizontal
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
                    </ScrollableOverlay>
                </div>
            ) : (
                <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t('chat.promptNavigator.aria')}
                    aria-haspopup="listbox"
                    aria-expanded={false}
                    className="pointer-events-auto flex flex-col items-end gap-[3px] rounded-md bg-background/85 p-1"
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
                                'block h-[1.5px] w-3 rounded-full',
                                tick === currentTick
                                    ? 'bg-muted-foreground'
                                    : 'bg-muted-foreground/40',
                            )}
                        />
                    ))}
                </button>
            )}
        </nav>
    );
}

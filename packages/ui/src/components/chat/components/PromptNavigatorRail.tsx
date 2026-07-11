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

type LineRailProps = {
    prompts: PromptEntry[];
    activeTurnId: string | null;
    lineGapClass: string;
    needsBackdrop: boolean;
    emptyPreviewLabel: string;
    onSelectTurn: (turnId: string) => void;
};

/** Compact marker stack only — never renders load-more. Markers stay out of tab order. */
function LineRail({
    prompts,
    activeTurnId,
    lineGapClass,
    needsBackdrop,
    emptyPreviewLabel,
    onSelectTurn,
}: LineRailProps) {
    const activeButtonRef = React.useRef<HTMLButtonElement | null>(null);

    React.useLayoutEffect(() => {
        activeButtonRef.current?.scrollIntoView({ block: 'nearest' });
    }, [activeTurnId, prompts.length]);

    return (
        <div
            className={cn(
                'flex flex-col items-center rounded-full px-1 py-1.5',
                needsBackdrop
                    ? 'border border-[var(--interactive-border)]/40 bg-[var(--surface-background)]/90 shadow-sm backdrop-blur-sm'
                    : 'bg-transparent',
            )}
        >
            <div
                className={cn(
                    'flex max-h-[40vh] min-h-0 flex-col items-center overflow-y-auto overflow-x-hidden',
                    lineGapClass,
                    '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
                )}
            >
                {prompts.map((prompt) => {
                    const isActive = prompt.turnId === activeTurnId;
                    const preview = prompt.preview.trim() || emptyPreviewLabel;

                    return (
                        <button
                            key={prompt.turnId}
                            ref={isActive ? activeButtonRef : undefined}
                            type="button"
                            tabIndex={-1}
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
                                onSelectTurn(prompt.turnId);
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
        </div>
    );
}

type PromptMenuPanelProps = {
    prompts: PromptEntry[];
    activeTurnId: string | null;
    canLoadEarlier: boolean;
    isLoadingOlder: boolean;
    emptyPreviewLabel: string;
    currentPromptLabel: string;
    loadMoreLabel: string;
    onSelectTurn: (turnId: string) => void;
    onLoadEarlier: (event: React.MouseEvent<HTMLButtonElement>) => void;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    focusOnMount: boolean;
};

/** Hover/keyboard menu — the only place load-more is allowed. */
function PromptMenuPanel({
    prompts,
    activeTurnId,
    canLoadEarlier,
    isLoadingOlder,
    emptyPreviewLabel,
    currentPromptLabel,
    loadMoreLabel,
    onSelectTurn,
    onLoadEarlier,
    onMouseEnter,
    onMouseLeave,
    focusOnMount,
}: PromptMenuPanelProps) {
    const activeItemRef = React.useRef<HTMLButtonElement | null>(null);

    React.useEffect(() => {
        if (!focusOnMount) {
            return;
        }
        activeItemRef.current?.focus();
    }, [focusOnMount]);

    return (
        <div
            className={cn(
                'absolute right-full top-1/2 z-30 mr-3 w-[min(18rem,calc(100vw-5rem))] -translate-y-1/2',
                'rounded-xl border border-[var(--interactive-border)]/60 bg-[var(--surface-elevated)] p-1 shadow-md',
            )}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
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
                            onClick={onLoadEarlier}
                        >
                            {isLoadingOlder ? (
                                <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin" />
                            ) : (
                                <Icon name="arrow-up-s" className="size-3.5 shrink-0" />
                            )}
                            <span>{loadMoreLabel}</span>
                        </button>
                    </li>
                ) : null}
                {prompts.map((prompt) => {
                    const isActive = prompt.turnId === activeTurnId;
                    const preview = prompt.preview.trim() || emptyPreviewLabel;

                    return (
                        <li key={prompt.turnId}>
                            <button
                                ref={isActive ? activeItemRef : undefined}
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
                                    onSelectTurn(prompt.turnId);
                                }}
                            >
                                <span className="min-w-0 flex-1">
                                    <span className="typography-meta line-clamp-2">{preview}</span>
                                    {isActive ? (
                                        <span className="mt-0.5 block typography-micro text-[var(--interactive-selection-foreground)]/80">
                                            {currentPromptLabel}
                                        </span>
                                    ) : null}
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

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
    const isPanelOpen = useUIStore((state) => state.isPromptNavigatorPanelOpen);
    const setPromptNavigatorPanelOpen = useUIStore((state) => state.setPromptNavigatorPanelOpen);
    const closeTimeoutRef = React.useRef<number | null>(null);
    const rootRef = React.useRef<HTMLElement | null>(null);
    const openedByPointerRef = React.useRef(false);
    const [focusActiveOnOpen, setFocusActiveOnOpen] = React.useState(false);

    const prompts = React.useMemo(
        () => buildPromptEntries(turnIds, previewsByTurnId),
        [previewsByTurnId, turnIds],
    );

    const needsBackdrop = screenWidth < COMPACT_BACKDROP_MAX_WIDTH_PX;
    const lineGapClass = resolveLineGapClass(prompts.length);
    const emptyPreviewLabel = t('chat.timeline.noTextContent');
    const currentPromptLabel = t('chat.promptNavigator.currentPrompt');
    const loadMoreLabel = t('chat.promptNavigator.loadMore');

    const clearCloseTimeout = React.useCallback(() => {
        if (closeTimeoutRef.current !== null) {
            window.clearTimeout(closeTimeoutRef.current);
            closeTimeoutRef.current = null;
        }
    }, []);

    const openPanel = React.useCallback(() => {
        clearCloseTimeout();
        openedByPointerRef.current = true;
        setFocusActiveOnOpen(false);
        setPromptNavigatorPanelOpen(true);
    }, [clearCloseTimeout, setPromptNavigatorPanelOpen]);

    const scheduleClosePanel = React.useCallback(() => {
        clearCloseTimeout();
        closeTimeoutRef.current = window.setTimeout(() => {
            // Keep keyboard-opened panel alive while focus is still inside the rail.
            if (rootRef.current?.contains(document.activeElement)) {
                return;
            }
            openedByPointerRef.current = false;
            setFocusActiveOnOpen(false);
            setPromptNavigatorPanelOpen(false);
        }, HOVER_CLOSE_DELAY_MS);
    }, [clearCloseTimeout, setPromptNavigatorPanelOpen]);

    React.useEffect(() => () => {
        clearCloseTimeout();
        setPromptNavigatorPanelOpen(false);
    }, [clearCloseTimeout, setPromptNavigatorPanelOpen]);

    // Keyboard shortcut flips the store open with focus outside the rail.
    // Pointer open sets openedByPointerRef so we don't steal focus on hover.
    React.useEffect(() => {
        if (!isPanelOpen) {
            setFocusActiveOnOpen(false);
            return;
        }
        if (openedByPointerRef.current) {
            openedByPointerRef.current = false;
            setFocusActiveOnOpen(false);
            return;
        }
        setFocusActiveOnOpen(true);
    }, [isPanelOpen]);

    const handleSelectPrompt = React.useCallback((turnId: string) => {
        onSelectTurn(turnId);
        openedByPointerRef.current = false;
        setFocusActiveOnOpen(false);
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

    const handleWrapperBlur = React.useCallback((event: React.FocusEvent<HTMLDivElement>) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) {
            return;
        }
        scheduleClosePanel();
    }, [scheduleClosePanel]);

    if (prompts.length === 0) {
        return null;
    }

    return (
        <nav
            ref={rootRef}
            aria-label={t('chat.promptNavigator.aria')}
            className="pointer-events-none absolute right-3 top-1/2 z-20 -translate-y-1/2"
        >
            <div
                className="pointer-events-auto relative"
                onMouseEnter={openPanel}
                onMouseLeave={scheduleClosePanel}
                onFocus={openPanel}
                onBlur={handleWrapperBlur}
            >
                <LineRail
                    prompts={prompts}
                    activeTurnId={activeTurnId}
                    lineGapClass={lineGapClass}
                    needsBackdrop={needsBackdrop}
                    emptyPreviewLabel={emptyPreviewLabel}
                    onSelectTurn={handleSelectPrompt}
                />

                {isPanelOpen ? (
                    <PromptMenuPanel
                        prompts={prompts}
                        activeTurnId={activeTurnId}
                        canLoadEarlier={canLoadEarlier}
                        isLoadingOlder={isLoadingOlder}
                        emptyPreviewLabel={emptyPreviewLabel}
                        currentPromptLabel={currentPromptLabel}
                        loadMoreLabel={loadMoreLabel}
                        onSelectTurn={handleSelectPrompt}
                        onLoadEarlier={handleLoadEarlier}
                        onMouseEnter={openPanel}
                        onMouseLeave={scheduleClosePanel}
                        focusOnMount={focusActiveOnOpen}
                    />
                ) : null}
            </div>
        </nav>
    );
}

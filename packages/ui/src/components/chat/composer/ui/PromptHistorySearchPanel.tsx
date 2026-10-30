import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { getDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import type { AttachedFile } from '@/stores/types/sessionTypes';

import { useMobileAutocompleteMaxHeight } from '../../useMobileAutocompleteMaxHeight';
import { filterPromptHistory, preparePromptHistory, type PromptHistoryCandidate } from '../state/promptHistorySearch';
import type { MessageHistoryValue } from '../state/useMessageHistory';
import { ComposerFloatingPanel } from './ComposerFloatingPanel';

const PREVIEW_LIMIT = 500;
const LIST_MAX_HEIGHT_PX = 320;
const PANEL_MAX_HEIGHT_PX = 400;
const PANEL_GAP_PX = 12;

type Direction = 'older' | 'newer';

type PromptHistorySearchPanelProps = {
    history: readonly MessageHistoryValue<AttachedFile>[];
    initialQuery: string;
    olderRequest: number;
    onPick: (candidate: PromptHistoryCandidate<AttachedFile>) => void;
    onClose: (reason: 'dismiss' | 'blur') => void;
};

function preview(text: string): string {
    return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

function arrowDirection(key: string): Direction | null {
    if (key === 'ArrowUp') return 'older';
    if (key === 'ArrowDown') return 'newer';
    return null;
}

function historyStepForKey(event: React.KeyboardEvent): Direction | null {
    const direction = arrowDirection(event.key);
    if (direction) {
        if (event.altKey || event.shiftKey || (event.ctrlKey && event.metaKey)) return null;
        return direction;
    }
    const navigationKey = getDropdownNavigationKey(event);
    if (navigationKey === 'ArrowUp') return 'older';
    if (navigationKey === 'ArrowDown') return 'newer';
    return null;
}

function PromptHistorySearchPanelView({ history, initialQuery, olderRequest, onPick, onClose }: PromptHistorySearchPanelProps) {
    const { t } = useI18n();
    const panelRef = React.useRef<HTMLDivElement>(null);
    const inputRef = React.useRef<HTMLInputElement>(null);
    const rowRefs = React.useRef(new Map<string, HTMLElement>());
    const ids = React.useRef(new Map<string, number>());
    const previousHistoryRef = React.useRef(history);
    const nextIdRef = React.useRef(0);
    const previousOlderRequestRef = React.useRef(olderRequest);
    const panelId = React.useId();
    const candidates = React.useMemo(() => preparePromptHistory(history), [history]);
    const [query, setQuery] = React.useState(initialQuery);
    const matchingCandidates = React.useMemo(() => filterPromptHistory(candidates, query), [candidates, query]);
    const [selectedCandidate, setSelectedCandidate] = React.useState<PromptHistoryCandidate<AttachedFile> | null>(null);
    const activeCandidate = selectedCandidate && matchingCandidates.includes(selectedCandidate)
        ? selectedCandidate
        : matchingCandidates.at(-1) ?? null;
    const listId = `prompt-history-list-${panelId}`;
    const availableHeight = useMobileAutocompleteMaxHeight(panelRef, true, PANEL_MAX_HEIGHT_PX + PANEL_GAP_PX, 0);
    const panelMaxHeight = availableHeight === undefined
        ? PANEL_MAX_HEIGHT_PX
        : Math.max(0, availableHeight - PANEL_GAP_PX);

    if (previousHistoryRef.current !== history) {
        const currentTexts = new Set(candidates.map((candidate) => candidate.value.text));
        for (const text of ids.current.keys()) {
            if (!currentTexts.has(text)) ids.current.delete(text);
        }
        previousHistoryRef.current = history;
    }

    const rowIdFor = (text: string) => {
        let identifier = ids.current.get(text);
        if (identifier === undefined) {
            identifier = nextIdRef.current;
            nextIdRef.current += 1;
            ids.current.set(text, identifier);
        }
        return `${listId}-option-${identifier}`;
    };

    const moveSelection = React.useCallback((direction: Direction, steps = 1) => {
        if (!activeCandidate) return;
        const currentIndex = matchingCandidates.indexOf(activeCandidate);
        const nextIndex = Math.max(0, Math.min(matchingCandidates.length - 1, currentIndex + (direction === 'older' ? -steps : steps)));
        setSelectedCandidate(matchingCandidates[nextIndex] ?? null);
    }, [activeCandidate, matchingCandidates]);

    React.useLayoutEffect(() => {
        inputRef.current?.focus({ preventScroll: true });
        inputRef.current?.select();
    }, []);

    React.useLayoutEffect(() => {
        if (!activeCandidate) return;
        rowRefs.current.get(activeCandidate.value.text)?.scrollIntoView({ block: 'nearest' });
    }, [activeCandidate, panelMaxHeight, matchingCandidates]);

    React.useEffect(() => {
        const requested = olderRequest - previousOlderRequestRef.current;
        previousOlderRequestRef.current = olderRequest;
        if (requested > 0) moveSelection('older', requested);
    }, [moveSelection, olderRequest]);

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (isIMECompositionEvent(event)) {
            event.stopPropagation();
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose('dismiss');
            return;
        }
        if (event.target !== inputRef.current) return;
        const step = historyStepForKey(event);
        if (step) {
            event.preventDefault();
            event.stopPropagation();
            moveSelection(step);
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            if (activeCandidate) onPick(activeCandidate);
        }
    };

    const handleBlur = (event: React.FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onClose('blur');
    };

    // Pointer presses on non-interactive panel areas (padding, hint, scrollbar)
    // would otherwise move focus to nothing and close the panel while the
    // pointer stays inside it. Buttons and the input keep their native focus.
    const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
        if (event.target instanceof Element && event.target.closest('input, button')) return;
        event.preventDefault();
    };

    return (
        <div ref={panelRef} data-prompt-history-search onKeyDownCapture={handleKeyDown} onBlur={handleBlur} onMouseDown={handleMouseDown}>
            <ComposerFloatingPanel
                role="dialog"
                ariaLabel={t('chat.promptHistorySearch.title')}
                maxHeight={panelMaxHeight}
                header={<>
                    <Icon name="search" className="size-3.5 shrink-0 text-muted-foreground/70" />
                    <input
                        ref={inputRef}
                        data-prompt-history-search-input
                        role="combobox"
                        aria-autocomplete="list"
                        aria-controls={listId}
                        aria-expanded="true"
                        aria-activedescendant={activeCandidate ? rowIdFor(activeCandidate.value.text) : undefined}
                        aria-label={t('chat.promptHistorySearch.title')}
                        placeholder={t('chat.promptHistorySearch.searchPlaceholder')}
                        value={query}
                        onChange={(event) => {
                            setSelectedCandidate(null);
                            setQuery(event.target.value);
                        }}
                        className="h-8 min-w-0 flex-1 bg-transparent p-0 typography-meta text-[max(16px,0.875rem)] outline-none placeholder:text-muted-foreground"
                    />
                    <Button type="button" variant="ghost" size="xs" aria-label={t('chat.promptHistorySearch.close')} data-prompt-history-search-close onClick={() => onClose('dismiss')} className="size-6 rounded-full p-0">
                        <Icon name="close" className="size-3.5" />
                    </Button>
                </>}
            >
                {candidates.length === 0 ? (
                    <div data-prompt-history-search-empty className="min-h-0 overflow-y-auto px-3 py-4 text-center typography-meta text-muted-foreground" role="status">
                        {t('chat.promptHistorySearch.empty')}
                    </div>
                ) : matchingCandidates.length === 0 ? (
                    <div data-prompt-history-search-no-matches className="min-h-0 overflow-y-auto px-3 py-4 text-center typography-meta text-muted-foreground" role="status">
                        {t('chat.promptHistorySearch.noMatches')}
                    </div>
                ) : (
                    <ScrollableOverlay as="div" id={listId} role="listbox" aria-label={t('chat.promptHistorySearch.title')} data-prompt-history-search-list disableHorizontal style={{ maxHeight: LIST_MAX_HEIGHT_PX }}>
                        {matchingCandidates.map((candidate) => {
                            const attachmentCount = candidate.value.attachments.length;
                            const selected = candidate === activeCandidate;
                            return (
                                <div
                                    ref={(element) => {
                                        if (element) rowRefs.current.set(candidate.value.text, element);
                                        else rowRefs.current.delete(candidate.value.text);
                                    }}
                                    key={candidate.value.text}
                                    id={rowIdFor(candidate.value.text)}
                                    role="option"
                                    tabIndex={-1}
                                    aria-selected={selected}
                                    data-prompt-history-search-row
                                    data-history-index={candidate.index}
                                    onPointerDown={(event) => event.preventDefault()}
                                    onClick={() => onPick(candidate)}
                                    className="aria-selected:bg-interactive-selection aria-selected:text-interactive-selection-foreground hover:bg-interactive-hover flex cursor-pointer flex-col items-stretch gap-0.5 rounded-none px-3 py-2 typography-meta outline-hidden select-none"
                                >
                                    <span data-prompt-history-search-row-text dir="auto" className="line-clamp-2 oc-ui-start-align">
                                        {preview(candidate.value.text)}
                                    </span>
                                    {attachmentCount > 0 ? (
                                        <span data-prompt-history-search-row-attachments className="inline-flex items-center gap-1 typography-micro text-muted-foreground">
                                            <Icon name="file" className="size-3" />
                                            {attachmentCount === 1
                                                ? t('chat.promptHistorySearch.attachmentsSingle', { count: String(attachmentCount) })
                                                : t('chat.promptHistorySearch.attachmentsPlural', { count: String(attachmentCount) })}
                                        </span>
                                    ) : null}
                                </div>
                            );
                        })}
                    </ScrollableOverlay>
                )}
                <div data-prompt-history-search-hint aria-hidden="true" className="hidden shrink-0 border-t border-[var(--interactive-border)] px-3 py-1.5 typography-micro text-muted-foreground sm:block">
                    {t('chat.promptHistorySearch.hint')}
                </div>
            </ComposerFloatingPanel>
        </div>
    );
}

export const PromptHistorySearchPanel = React.memo(PromptHistorySearchPanelView);

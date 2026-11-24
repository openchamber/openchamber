import React from 'react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessageLoader, useSessionMessageRecords, useSyncDirectory } from '@/sync/sync-context';
import { useChatSessionSelection } from './chatColumnSession';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { getFullText, getMessagePreview } from './lib/messagePreview';
import { useSourceControlDescriptorOf } from '@/lib/source-control/providers/registry';
import { foldPromptEntries } from './lib/promptPreviews';
import { buildQuestionEntriesByTurnId, withoutRecommendationPicks, type QuestionAnswerEntry } from './lib/questionEntries';
import { buildTurnWindowModel } from './lib/turns/windowTurns';
import type { ChatMessageEntry } from './lib/turns/types';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

interface TimelineDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onScrollToMessage?: (messageId: string) => void | Promise<boolean>;
    onScrollByTurnOffset?: (offset: number) => void;
    onResumeToLatest?: () => void;
    canLoadEarlier?: boolean;
    isLoadingEarlier?: boolean;
    onLoadEarlier?: () => void;
}

const dateGroupFormatters = new Map<string, Intl.DateTimeFormat>();
const messageTimeFormatters = new Map<string, Intl.DateTimeFormat>();

const getFormatter = (
    cache: Map<string, Intl.DateTimeFormat>,
    options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat => {
    const locale = getCurrentIntlLocale();
    let formatter = cache.get(locale);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat(locale, options);
        cache.set(locale, formatter);
    }
    return formatter;
};

const formatDateGroup = (timestamp: number): string =>
    getFormatter(dateGroupFormatters, { year: 'numeric', month: 'short', day: 'numeric' }).format(timestamp);

const formatMessageTime = (timestamp: number): string =>
    getFormatter(messageTimeFormatters, { hour: 'numeric', minute: '2-digit' }).format(timestamp);

export const TimelineDialog: React.FC<TimelineDialogProps> = ({
    open,
    onOpenChange,
    ...bodyProps
}) => {
    const { sessionId: currentSessionId, directory: currentSessionDirectory } = useChatSessionSelection();
    const [searchQuery, setSearchQuery] = React.useState('');

    if (!currentSessionId) return null;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[70vh] max-md:max-h-[85dvh] flex flex-col overflow-y-auto">
                <TimelineDialogBody
                    {...bodyProps}
                    onOpenChange={onOpenChange}
                    currentSessionId={currentSessionId}
                    currentSessionDirectory={currentSessionDirectory ?? undefined}
                    searchQuery={searchQuery}
                    onSearchQueryChange={setSearchQuery}
                />
            </DialogContent>
        </Dialog>
    );
};

interface TimelineDialogBodyProps extends Omit<TimelineDialogProps, 'open'> {
    currentSessionId: string;
    currentSessionDirectory: string | undefined;
    searchQuery: string;
    onSearchQueryChange: (query: string) => void;
}

type TimelinePromptGroup = {
    message: ChatMessageEntry;
    turnId: string;
    isUserPrompt: boolean;
    questions: QuestionAnswerEntry[];
};

// The dialog navigates one flat run of rows, the same model the prompt rail
// uses: a prompt, then the answered questions it asked.
type TimelineRow =
    | { kind: 'prompt'; group: TimelinePromptGroup; showDateGroup: boolean }
    | { kind: 'question'; question: QuestionAnswerEntry };

const lastPromptRowIndex = (rows: readonly TimelineRow[]): number => {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index].kind === 'prompt') return index;
    }
    return 0;
};

const TimelineDialogBody: React.FC<TimelineDialogBodyProps> = ({
    onOpenChange,
    onScrollToMessage,
    onScrollByTurnOffset,
    onResumeToLatest,
    canLoadEarlier = false,
    isLoadingEarlier = false,
    onLoadEarlier,
    currentSessionId,
    currentSessionDirectory,
    searchQuery,
    onSearchQueryChange,
}) => {
    const { t } = useI18n();
    const noAnswerLabel = t('chat.toolPart.question.noAnswer');
    const descriptorOf = useSourceControlDescriptorOf();
    const messages = useSessionMessageRecords(currentSessionId, currentSessionDirectory);
    const messageLoader = useSessionMessageLoader();
    const syncDirectory = useSyncDirectory();
    const historyDirectory = currentSessionDirectory ?? syncDirectory;
    React.useEffect(() => {
        if (!historyDirectory) return;
        return messageLoader.retainSessionHistory({ directory: historyDirectory, sessionID: currentSessionId }, 'browsing');
    }, [currentSessionId, historyDirectory, messageLoader]);
    const revertToMessage = useSessionUIStore((state) => state.revertToMessage);
    const forkFromMessage = useSessionUIStore((state) => state.forkFromMessage);
    const { isMobile, isTablet } = useDeviceInfo();
    const alwaysShowActions = isMobile || isTablet;

    const [forkingMessageId, setForkingMessageId] = React.useState<string | null>(null);
    const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
    const listRef = React.useRef<HTMLDivElement | null>(null);
    const pendingLoadAnchorRef = React.useRef<{ messageId: string; top: number } | null>(null);
    const preservingLoadPositionRef = React.useRef(false);

    // Timeline actions are only valid for user messages. Folding the injected
    // context back on is what gives a quote-only prompt a title, and makes the
    // quote itself searchable.
    const turnModel = React.useMemo(() => buildTurnWindowModel(messages), [messages]);
    const questionsByTurnId = React.useMemo(() => buildQuestionEntriesByTurnId(messages), [messages]);
    const promptGroups = React.useMemo(() => {
        const folded = new Map(foldPromptEntries(messages).map((message) => [message.info.id, message]));
        const turnIds = new Set(turnModel.turnIds);
        const groups: TimelinePromptGroup[] = [];
        for (const message of messages) {
            if (!turnIds.has(message.info.id)) continue;
            const questions = questionsByTurnId.get(message.info.id) ?? [];
            const foldedMessage = folded.get(message.info.id);
            // A prompt with nothing readable still gets a row when its turn
            // asked a question, so the question keeps a place to hang.
            if (!foldedMessage && questions.length === 0) continue;
            groups.push({
                message: foldedMessage ?? message,
                turnId: message.info.id,
                isUserPrompt: message.info.role === 'user',
                questions,
            });
        }
        return groups;
    }, [messages, questionsByTurnId, turnModel.turnIds]);

    // Filter by search query using all text parts in each prompt, and the
    // questions its turn asked.
    const filteredGroups = React.useMemo(() => {
        const trimmedQuery = searchQuery.trim();
        if (!trimmedQuery) return promptGroups;

        const query = trimmedQuery.toLowerCase();
        return promptGroups.filter(({ message, questions }) => {
            const fullText = getFullText(message.parts).toLowerCase();
            if (fullText.includes(query)) return true;
            return questions.some((question) => (
                `${question.question} ${question.answer ? withoutRecommendationPicks(question.answer) : ''}`.toLowerCase().includes(query)
            ));
        });
    }, [promptGroups, searchQuery]);

    const rows = React.useMemo<TimelineRow[]>(() => {
        const next: TimelineRow[] = [];
        let previousDateGroup: string | null = null;
        for (const group of filteredGroups) {
            const dateGroup = formatDateGroup(group.message.info.time.created);
            next.push({ kind: 'prompt', group, showDateGroup: dateGroup !== previousDateGroup });
            previousDateGroup = dateGroup;
            for (const question of group.questions) {
                next.push({ kind: 'question', question });
            }
        }
        return next;
    }, [filteredGroups]);

    const [selectedIndex, setSelectedIndex] = React.useState(() => (
        searchQuery.trim() ? 0 : lastPromptRowIndex(rows)
    ));

    React.useEffect(() => {
        if (preservingLoadPositionRef.current) {
            return;
        }

        setSelectedIndex(searchQuery.trim() ? 0 : lastPromptRowIndex(rows));
    }, [rows, searchQuery]);

    React.useEffect(() => {
        itemRefs.current = itemRefs.current.slice(0, rows.length);
    }, [rows.length]);

    React.useEffect(() => {
        if (preservingLoadPositionRef.current) {
            return;
        }

        itemRefs.current[selectedIndex]?.scrollIntoView({
            block: 'nearest',
        });
    }, [selectedIndex]);

    React.useEffect(() => {
        if (!preservingLoadPositionRef.current || pendingLoadAnchorRef.current || isLoadingEarlier) {
            return;
        }

        preservingLoadPositionRef.current = false;
    }, [rows.length, isLoadingEarlier]);

    const openedWithQueryRef = React.useRef(searchQuery.trim() !== '');
    React.useLayoutEffect(() => {
        const container = listRef.current;
        if (openedWithQueryRef.current || !container) {
            return;
        }

        container.scrollTop = container.scrollHeight;
    }, []);

    React.useLayoutEffect(() => {
        const anchor = pendingLoadAnchorRef.current;
        const container = listRef.current;
        if (!anchor || !container || isLoadingEarlier) {
            return;
        }

        pendingLoadAnchorRef.current = null;
        const anchoredRow = itemRefs.current.find((row) => row?.dataset.timelineMessageId === anchor.messageId);
        if (!anchoredRow) {
            return;
        }

        const nextTop = anchoredRow.getBoundingClientRect().top - container.getBoundingClientRect().top;
        container.scrollTop += nextTop - anchor.top;
    }, [rows.length, isLoadingEarlier]);

    const handleLoadEarlier = React.useCallback(() => {
        const container = listRef.current;
        if (container) {
            const containerTop = container.getBoundingClientRect().top;
            const firstVisibleRow = itemRefs.current.find((row) => {
                if (!row) return false;
                return row.getBoundingClientRect().bottom >= containerTop;
            });

            if (firstVisibleRow?.dataset.timelineMessageId) {
                pendingLoadAnchorRef.current = {
                    messageId: firstVisibleRow.dataset.timelineMessageId,
                    top: firstVisibleRow.getBoundingClientRect().top - containerTop,
                };
            }
        }

        preservingLoadPositionRef.current = true;
        onLoadEarlier?.();
    }, [onLoadEarlier]);

    const navigateToMessage = React.useCallback(async (messageId: string) => {
        const didNavigate = await onScrollToMessage?.(messageId);
        if (didNavigate === false) {
            return;
        }
        onOpenChange(false);
    }, [onOpenChange, onScrollToMessage]);

    const handleSearchKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
        const total = rows.length;
        if (total === 0) {
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSelectedIndex((current) => (current + 1) % total);
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSelectedIndex((current) => (current - 1 + total) % total);
            return;
        }

        if (event.key === 'Enter') {
            event.preventDefault();
            const safeIndex = ((selectedIndex % total) + total) % total;
            const selected = rows[safeIndex];
            if (selected) {
                void navigateToMessage(selected.kind === 'question' ? selected.question.messageId : selected.group.message.info.id);
            }
        }
    }, [navigateToMessage, rows, selectedIndex]);

    const handleFork = async (messageId: string) => {
        setForkingMessageId(messageId);
        try {
            await forkFromMessage(currentSessionId, messageId);
            onOpenChange(false);
        } finally {
            setForkingMessageId(null);
        }
    };

    const turnActions = (
        <>
            <button
                type="button"
                className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                onClick={() => {
                    void onScrollByTurnOffset?.(-1);
                    onOpenChange(false);
                }}
            >
                {t('chat.timeline.actions.previousTurn')}
            </button>
            <span className="text-muted-foreground/50">/</span>
            <button
                type="button"
                className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                onClick={() => {
                    onResumeToLatest?.();
                    onOpenChange(false);
                }}
            >
                {t('chat.timeline.actions.latest')}
            </button>
        </>
    );

    return (
        <>
                <DialogHeader className="shrink-0">
                    <DialogTitle className="flex items-center gap-2">
                        <Icon name="time" className="h-5 w-5" />
                        {t('chat.timeline.title')}
                    </DialogTitle>
                    {!isMobile && (
                        <DialogDescription>
                            {t('chat.timeline.description')}
                        </DialogDescription>
                    )}
                </DialogHeader>

                <div className="relative mt-2 shrink-0">
                    <Icon name="search" className="absolute inset-s-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        autoFocus
                        placeholder={t('chat.timeline.searchPlaceholder')}
                        value={searchQuery}
                        onChange={(e) => onSearchQueryChange(e.target.value)}
                        onKeyDown={handleSearchKeyDown}
                        className="ps-9 w-full"
                    />
                </div>

                {canLoadEarlier && onLoadEarlier && (
                    <div className="flex shrink-0 justify-center py-1">
                        <Button
                            type="button"
                            variant="link"
                            size="sm"
                            onClick={handleLoadEarlier}
                            disabled={isLoadingEarlier}
                            className="h-auto px-1 py-0 text-muted-foreground hover:text-foreground"
                        >
                            {isLoadingEarlier && (
                                <Icon name="loader-4" className="size-4 animate-spin" />
                            )}
                            {t('chat.history.loadOlder')}
                        </Button>
                    </div>
                )}

                <ScrollableOverlay ref={listRef} outerClassName="min-h-0 flex-1" disableHorizontal>
                    {rows.length === 0 ? (
                        <div className="text-center text-muted-foreground py-8">
                            {searchQuery ? t('chat.timeline.empty.search') : t('chat.timeline.empty.session')}
                        </div>
                    ) : (
                        rows.map((row, index) => {
                            if (row.kind === 'question') {
                                const { question } = row;
                                // The tool marks its recommended option in the
                                // reply; the transcript drops that mark, and so
                                // does this row.
                                const answer = question.answer ? withoutRecommendationPicks(question.answer.trim()) : noAnswerLabel;
                                const questionText = `${question.question} ${question.answer ? answer : ''}`;
                                const questionSnippet = searchQuery.trim()
                                    ? getSearchSnippet(questionText, searchQuery)
                                    : null;
                                const isSelected = index === selectedIndex;
                                return (
                                    <div
                                        key={question.partId}
                                        ref={(element) => {
                                            itemRefs.current[index] = element;
                                        }}
                                        // The row jumps to this message, so "Load earlier"
                                        // anchors on it like a prompt row.
                                        data-timeline-message-id={question.messageId}
                                        className={cn(
                                            'group flex items-start gap-3 rounded py-1 ps-6 transition-colors cursor-pointer',
                                            isSelected
                                                ? 'bg-interactive-selection text-interactive-selection-foreground'
                                                : 'hover:bg-interactive-hover/30',
                                        )}
                                        onClick={() => void navigateToMessage(question.messageId)}
                                        onMouseEnter={() => setSelectedIndex(index)}
                                        title={`${question.question} — ${answer}`}
                                    >
                                        <span className={cn(
                                            'typography-meta min-w-16 flex-shrink-0 text-end',
                                            isSelected ? 'text-interactive-selection-foreground' : 'text-muted-foreground',
                                        )}>
                                            ?
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span
                                                className={cn(
                                                    'block truncate typography-small oc-ui-start-align',
                                                    isSelected ? 'text-interactive-selection-foreground' : 'text-muted-foreground',
                                                )}
                                                dir="auto"
                                            >
                                                {questionSnippet ?? question.question}
                                            </span>
                                            <span
                                                className={cn(
                                                    'block truncate typography-meta oc-ui-start-align',
                                                    isSelected ? 'text-interactive-selection-foreground' : 'text-muted-foreground',
                                                )}
                                                dir="auto"
                                            >
                                                {answer}
                                            </span>
                                        </span>
                                    </div>
                                );
                            }

                            const { group } = row;
                            const { message } = group;
                            const preview = getMessagePreview(message.parts, undefined, t, descriptorOf);
                            const timestamp = message.info.time.created;
                            const messageTime = formatMessageTime(timestamp);
                            const isSelected = index === selectedIndex;

                            const snippet = searchQuery.trim()
                                ? getSearchSnippet(getFullText(message.parts), searchQuery)
                                : null;

                            return (
                                <React.Fragment key={message.info.id}>
                                    {row.showDateGroup && (
                                        <div className="sticky top-0 z-10 flex items-center gap-3 bg-background/95 py-2 backdrop-blur-sm">
                                            <div className="h-px flex-1 bg-edge" />
                                            <span className="typography-meta text-muted-foreground">
                                                {formatDateGroup(timestamp)}
                                            </span>
                                            <div className="h-px flex-1 bg-edge" />
                                        </div>
                                    )}
                                    <div
                                        ref={(element) => {
                                            itemRefs.current[index] = element;
                                        }}
                                        data-timeline-message-id={message.info.id}
                                        className={cn(
                                            "group flex items-center gap-3 py-1.5 hover:bg-interactive-hover/30 rounded transition-colors cursor-pointer",
                                            isSelected && "bg-interactive-selection text-interactive-selection-foreground"
                                        )}
                                        onClick={() => void navigateToMessage(message.info.id)}
                                        onMouseEnter={() => setSelectedIndex(index)}
                                    >
                                        <span className={cn(
                                            "typography-meta min-w-16 flex-shrink-0 text-end tabular-nums whitespace-nowrap",
                                            isSelected ? "text-interactive-selection-foreground/70" : "text-muted-foreground"
                                        )}>
                                            {messageTime}
                                        </span>
                                        <p dir="auto" className={cn(
                                            "flex-1 min-w-0 typography-small truncate oc-ui-start-align",
                                            isSelected ? "text-interactive-selection-foreground" : "text-foreground"
                                        )}>
                                            {snippet ?? (preview || t('chat.timeline.noTextContent'))}
                                            {!snippet && preview && preview.length >= 80 && '…'}
                                        </p>

                                        {group.isUserPrompt ? (
                                            <div className="flex-shrink-0 h-5 flex items-center me-2">
                                                <div className={cn("gap-1", alwaysShowActions ? "flex" : "hidden group-hover:flex")}>
                                                    <Tooltip>
                                                        <TooltipTrigger asChild>
                                                            <button
                                                                type="button"
                                                                className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                                                                onClick={async (e) => {
                                                                    e.stopPropagation();
                                                                    await revertToMessage(currentSessionId, message.info.id);
                                                                    onOpenChange(false);
                                                                }}
                                                            >
                                                                <Icon name="arrow-go-back" className="h-4 w-4" />
                                                            </button>
                                                        </TooltipTrigger>
                                                        <TooltipContent sideOffset={6}>{t('chat.timeline.actions.revertFromHere')}</TooltipContent>
                                                    </Tooltip>

                                                    <Tooltip>
                                                        <TooltipTrigger asChild>
                                                            <button
                                                                type="button"
                                                                className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleFork(message.info.id);
                                                                }}
                                                                disabled={forkingMessageId === message.info.id}
                                                            >
                                                                {forkingMessageId === message.info.id ? (
                                                                    <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                                                                ) : (
                                                                    <Icon name="git-branch" className="h-4 w-4" />
                                                                )}
                                                            </button>
                                                        </TooltipTrigger>
                                                        <TooltipContent sideOffset={6}>{t('chat.timeline.actions.forkFromHere')}</TooltipContent>
                                                    </Tooltip>
                                                </div>
                                            </div>
                                        ) : null}
                                    </div>
                                </React.Fragment>
                            );
                        })
                    )}
                </ScrollableOverlay>

                {isMobile ? (
                    <div className="mt-2 flex shrink-0 items-center justify-center gap-2 border-t border-edge pt-2">
                        {turnActions}
                    </div>
                ) : (
                    <div className="mt-4 p-3 bg-muted/30 rounded-lg shrink-0">
                        <p className="typography-meta text-muted-foreground font-medium mb-2">{t('chat.timeline.actions.title')}</p>
                        <div className="mb-2 flex items-center gap-2">
                            {turnActions}
                        </div>
                        <div className="flex flex-col gap-1.5 typography-meta text-muted-foreground">
                            <div className="flex items-center gap-2">
                                <span>{t('chat.timeline.help.clickMessage')}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <Icon name="arrow-go-back" className="h-4 w-4 flex-shrink-0" />
                                <span>{t('chat.timeline.help.undoToPoint')}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <Icon name="git-branch" className="h-4 w-4 flex-shrink-0" />
                                <span>{t('chat.timeline.help.createSessionFromHere')}</span>
                            </div>
                        </div>
                    </div>
                )}
        </>
    );
};

function getSearchSnippet(text: string, query: string, contextChars: number = 30): string | null {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const matchIndex = lowerText.indexOf(lowerQuery);
    if (matchIndex === -1) return null;

    const start = Math.max(0, matchIndex - contextChars);
    const end = Math.min(text.length, matchIndex + query.length + contextChars);
    return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\n/g, ' ')}${end < text.length ? '…' : ''}`;
}

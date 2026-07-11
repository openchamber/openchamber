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
import { useSessionMessageRecords } from '@/sync/sync-context';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import type { Part } from '@opencode-ai/sdk/v2';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';

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

export const TimelineDialog: React.FC<TimelineDialogProps> = ({
    open,
    onOpenChange,
    onScrollToMessage,
    onScrollByTurnOffset,
    onResumeToLatest,
    canLoadEarlier = false,
    isLoadingEarlier = false,
    onLoadEarlier,
}) => {
    const { t } = useI18n();
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const messages = useSessionMessageRecords(currentSessionId ?? '');
    const revertToMessage = useSessionUIStore((state) => state.revertToMessage);
    const forkFromMessage = useSessionUIStore((state) => state.forkFromMessage);
    const { isMobile, isTablet } = useDeviceInfo();
    const alwaysShowActions = isMobile || isTablet;

    const [forkingMessageId, setForkingMessageId] = React.useState<string | null>(null);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [selectedIndex, setSelectedIndex] = React.useState(0);
    const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
    const listRef = React.useRef<HTMLDivElement | null>(null);
    const pendingLoadAnchorRef = React.useRef<{ messageId: string; top: number } | null>(null);
    const preservingLoadPositionRef = React.useRef(false);
    const wasOpenRef = React.useRef(open);

    const formatDateGroup = React.useCallback((timestamp: number): string => {
        return new Date(timestamp).toLocaleDateString(getCurrentIntlLocale(), {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    }, []);

    const formatMessageTime = React.useCallback((timestamp: number): string => {
        return new Date(timestamp).toLocaleTimeString(getCurrentIntlLocale(), {
            hour: 'numeric',
            minute: '2-digit',
        });
    }, []);

    // Timeline actions are only valid for user messages.
    const userMessages = React.useMemo(() => {
        return messages
            .filter((message) => message.info.role === 'user')
            .map((message) => ({ message }));
    }, [messages]);

    // Filter by search query using all text parts in each user message.
    const filteredMessages = React.useMemo(() => {
        const trimmedQuery = searchQuery.trim();
        if (!trimmedQuery) return userMessages;

        const query = trimmedQuery.toLowerCase();
        return userMessages.filter(({ message }) => {
            const fullText = getFullText(message.parts).toLowerCase();
            return fullText.includes(query);
        });
    }, [userMessages, searchQuery]);

    React.useEffect(() => {
        if (preservingLoadPositionRef.current) {
            return;
        }

        setSelectedIndex(searchQuery.trim() ? 0 : Math.max(0, filteredMessages.length - 1));
    }, [filteredMessages, searchQuery]);

    React.useEffect(() => {
        itemRefs.current = itemRefs.current.slice(0, filteredMessages.length);
    }, [filteredMessages.length]);

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
    }, [filteredMessages.length, isLoadingEarlier]);

    React.useLayoutEffect(() => {
        const wasOpen = wasOpenRef.current;
        wasOpenRef.current = open;

        if (!open || wasOpen || preservingLoadPositionRef.current || searchQuery.trim()) {
            return;
        }

        const container = listRef.current;
        if (!container) {
            return;
        }

        container.scrollTop = container.scrollHeight;
    }, [open, searchQuery]);

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
    }, [filteredMessages.length, isLoadingEarlier]);

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
        const total = filteredMessages.length;
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
            const selected = filteredMessages[safeIndex];
            if (selected) {
                void navigateToMessage(selected.message.info.id);
            }
        }
    }, [filteredMessages, navigateToMessage, selectedIndex]);

    // Handle fork with loading state and session refresh
    const handleFork = async (messageId: string) => {
        if (!currentSessionId) return;
        setForkingMessageId(messageId);
        try {
            await forkFromMessage(currentSessionId, messageId);
            onOpenChange(false);
        } finally {
            setForkingMessageId(null);
        }
    };

    if (!currentSessionId) return null;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[70vh] flex flex-col">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Icon name="time" className="h-5 w-5" />
                        {t('chat.timeline.title')}
                    </DialogTitle>
                    <DialogDescription>
                        {t('chat.timeline.description')}
                    </DialogDescription>
                </DialogHeader>

                <div className="relative mt-2">
                    <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        autoFocus
                        placeholder={t('chat.timeline.searchPlaceholder')}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={handleSearchKeyDown}
                        className="pl-9 w-full"
                    />
                </div>

                {canLoadEarlier && onLoadEarlier && (
                    <div className="flex justify-center py-1">
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

                <div ref={listRef} className="flex-1 overflow-y-auto">
                    {filteredMessages.length === 0 ? (
                        <div className="text-center text-muted-foreground py-8">
                            {searchQuery ? t('chat.timeline.empty.search') : t('chat.timeline.empty.session')}
                        </div>
                    ) : (
                        filteredMessages.map(({ message }, index) => {
                            const preview = getMessagePreview(message.parts);
                            const timestamp = message.info.time.created;
                            const dateGroup = formatDateGroup(timestamp);
                            const previous = filteredMessages[index - 1];
                            const previousDateGroup = previous
                                ? formatDateGroup(previous.message.info.time.created)
                                : null;
                            const showDateGroup = dateGroup !== previousDateGroup;
                            const messageTime = formatMessageTime(timestamp);
                            const isSelected = index === selectedIndex;

                            const snippet = searchQuery.trim()
                                ? getSearchSnippet(getFullText(message.parts), searchQuery)
                                : null;

                            return (
                                <React.Fragment key={message.info.id}>
                                    {showDateGroup && (
                                        <div className="sticky top-0 z-10 flex items-center gap-3 bg-background/95 py-2 backdrop-blur-sm">
                                            <div className="h-px flex-1 bg-border/60" />
                                            <span className="typography-meta text-muted-foreground">
                                                {dateGroup}
                                            </span>
                                            <div className="h-px flex-1 bg-border/60" />
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
                                            "typography-meta w-16 flex-shrink-0 text-right tabular-nums",
                                            isSelected ? "text-interactive-selection-foreground/70" : "text-muted-foreground"
                                        )}>
                                            {messageTime}
                                        </span>
                                        <p className={cn(
                                            "flex-1 min-w-0 typography-small truncate",
                                            isSelected ? "text-interactive-selection-foreground" : "text-foreground"
                                        )}>
                                            {snippet ?? (preview || t('chat.timeline.noTextContent'))}
                                            {!snippet && preview && preview.length >= 80 && '…'}
                                        </p>

                                        <div className="flex-shrink-0 h-5 flex items-center mr-2">
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
                                    </div>
                                </React.Fragment>
                            );
                        })
                    )}
                </div>

                <div className="mt-4 p-3 bg-muted/30 rounded-lg">
                    <p className="typography-meta text-muted-foreground font-medium mb-2">{t('chat.timeline.actions.title')}</p>
                    <div className="mb-2 flex items-center gap-2">
                        <button
                            type="button"
                            className="text-[11px] uppercase tracking-wide text-muted-foreground/90 hover:text-foreground"
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
                            className="text-[11px] uppercase tracking-wide text-muted-foreground/90 hover:text-foreground"
                            onClick={() => {
                                onResumeToLatest?.();
                                onOpenChange(false);
                            }}
                        >
                            {t('chat.timeline.actions.latest')}
                        </button>
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
            </DialogContent>
        </Dialog>
    );
};

function getFullText(parts: Part[]): string {
    return parts
        .filter((p): p is Part & { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n');
}

function getMessagePreview(parts: Part[]): string {
    const full = getFullText(parts);
    const singleLine = full.replace(/\n/g, ' ');
    return singleLine.length > 80 ? singleLine.slice(0, 80) : singleLine;
}

function getSearchSnippet(text: string, query: string, contextChars: number = 30): string | null {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const matchIndex = lowerText.indexOf(lowerQuery);
    if (matchIndex === -1) return null;

    const start = Math.max(0, matchIndex - contextChars);
    const end = Math.min(text.length, matchIndex + query.length + contextChars);
    return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\n/g, ' ')}${end < text.length ? '…' : ''}`;
}

import React from 'react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessageRecords } from '@/sync/sync-context';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import type { Part } from '@opencode-ai/sdk/v2';
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';

interface TimelineDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onScrollToMessage?: (messageId: string) => void | Promise<boolean>;
    onScrollByTurnOffset?: (offset: number) => void;
    onResumeToLatest?: () => void;
}

export const TimelineDialog: React.FC<TimelineDialogProps> = ({
    open,
    onOpenChange,
    onScrollToMessage,
    onScrollByTurnOffset,
    onResumeToLatest,
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

    const formatRelativeTime = React.useCallback((timestamp: number): string => {
        const now = Date.now();
        const diffMs = now - timestamp;
        const diffSecs = Math.floor(diffMs / 1000);
        const diffMins = Math.floor(diffSecs / 60);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffSecs < 60) return t('chat.timeline.relative.justNow');
        if (diffMins < 60) return t('chat.timeline.relative.minutesAgo', { count: diffMins });
        if (diffHours < 24) return t('chat.timeline.relative.hoursAgo', { count: diffHours });
        if (diffDays < 7) return t('chat.timeline.relative.daysAgo', { count: diffDays });
        return new Date(timestamp).toLocaleDateString();
    }, [t]);

    // Timeline actions are only valid for user messages.
    const userMessages = React.useMemo(() => {
        return messages
            .filter((message) => message.info.role === 'user')
            .map((message, index) => ({
                message,
                messageNumber: index + 1,
            }))
            .reverse();
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
        setSelectedIndex(0);
    }, [filteredMessages]);

    React.useEffect(() => {
        itemRefs.current = itemRefs.current.slice(0, filteredMessages.length);
    }, [filteredMessages.length]);

    React.useEffect(() => {
        itemRefs.current[selectedIndex]?.scrollIntoView({
            block: 'nearest',
        });
    }, [selectedIndex]);

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

                <div className="flex-1 overflow-y-auto">
                    {filteredMessages.length === 0 ? (
                        <div className="text-center text-muted-foreground py-8">
                            {searchQuery ? t('chat.timeline.empty.search') : t('chat.timeline.empty.session')}
                        </div>
                    ) : (
                        filteredMessages.map(({ message, messageNumber }, index) => {
                            const preview = getMessagePreview(message.parts);
                            const timestamp = message.info.time.created;
                            const relativeTime = formatRelativeTime(timestamp);
                            const isSelected = index === selectedIndex;

                            const snippet = searchQuery.trim()
                                ? getSearchSnippet(getFullText(message.parts), searchQuery)
                                : null;

                            return (
                                <div
                                    key={message.info.id}
                                    ref={(element) => {
                                        itemRefs.current[index] = element;
                                    }}
                                    className={cn(
                                        "group flex items-center gap-2 py-1.5 hover:bg-interactive-hover/30 rounded transition-colors cursor-pointer",
                                        isSelected && "bg-interactive-selection text-interactive-selection-foreground"
                                    )}
                                    onClick={() => void navigateToMessage(message.info.id)}
                                    onMouseEnter={() => setSelectedIndex(index)}
                                >
                                    <span className={cn(
                                        "typography-meta w-5 text-right flex-shrink-0",
                                        isSelected ? "text-interactive-selection-foreground/70" : "text-muted-foreground"
                                    )}>
                                        {messageNumber}.
                                    </span>
                                    <p className={cn(
                                        "flex-1 min-w-0 typography-small truncate ml-0.5",
                                        isSelected ? "text-interactive-selection-foreground" : "text-foreground"
                                    )}>
                                        {snippet ?? (preview || t('chat.timeline.noTextContent'))}
                                        {!snippet && preview && preview.length >= 80 && '…'}
                                    </p>

                                    <div className="flex-shrink-0 h-5 flex items-center mr-2">
                                        <span className={cn(
                                            "typography-meta whitespace-nowrap",
                                            isSelected ? "text-interactive-selection-foreground/70" : "text-muted-foreground",
                                            alwaysShowActions ? "hidden" : "group-hover:hidden"
                                        )}>
                                            {relativeTime}
                                        </span>

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

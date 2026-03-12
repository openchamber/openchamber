import React from 'react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useSessionStore } from '@/stores/useSessionStore';
import { useMessageStore } from '@/stores/messageStore';
import { RiLoader4Line, RiSearchLine, RiTimeLine, RiGitBranchLine, RiArrowGoBackLine } from '@remixicon/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Part } from '@opencode-ai/sdk/v2';

interface TimelineDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onScrollToMessage?: (messageId: string) => void | Promise<boolean>;
    onScrollByTurnOffset?: (offset: number) => void;
    onResumeToLatest?: () => void;
}

// Helper: format relative time (e.g., "2 hours ago")
function formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 60) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return new Date(timestamp).toLocaleDateString();
}

export const TimelineDialog: React.FC<TimelineDialogProps> = ({
    open,
    onOpenChange,
    onScrollToMessage,
    onScrollByTurnOffset,
    onResumeToLatest,
}) => {
    const currentSessionId = useSessionStore((state) => state.currentSessionId);
    const messages = useMessageStore((state) =>
        currentSessionId ? state.messages.get(currentSessionId) || [] : []
    );
    const revertToMessage = useSessionStore((state) => state.revertToMessage);
    const forkFromMessage = useSessionStore((state) => state.forkFromMessage);
    const loadSessions = useSessionStore((state) => state.loadSessions);

    const [forkingMessageId, setForkingMessageId] = React.useState<string | null>(null);
    const [searchQuery, setSearchQuery] = React.useState('');

    // Filter user messages (reversed for newest first)
    const userMessages = React.useMemo(() => {
        const filtered = messages.filter(m => m.info.role === 'user');
        return filtered.reverse();
    }, [messages]);

    // Filter by search query
    const filteredMessages = React.useMemo(() => {
        if (!searchQuery.trim()) return userMessages;

        const query = searchQuery.toLowerCase();
        return userMessages.filter((message) => {
            const preview = getMessagePreview(message.parts).toLowerCase();
            return preview.includes(query);
        });
    }, [userMessages, searchQuery]);

    // Handle fork with loading state and session refresh
    const handleFork = async (messageId: string) => {
        if (!currentSessionId) return;
        setForkingMessageId(messageId);
        try {
            await forkFromMessage(currentSessionId, messageId);
            await loadSessions();
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
                        <RiTimeLine className="h-5 w-5" />
                        Conversation Timeline
                    </DialogTitle>
                    <DialogDescription>
                        Navigate to any point in the conversation or fork a new session
                    </DialogDescription>
                </DialogHeader>

                <div className="relative mt-2">
                    <RiSearchLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Search messages..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-9 w-full"
                    />
                </div>

                <div className="flex-1 overflow-y-auto">
                    {filteredMessages.length === 0 ? (
                        <div className="text-center text-muted-foreground py-8">
                            {searchQuery ? 'No messages found' : 'No messages in this session yet'}
                        </div>
                    ) : (
                        filteredMessages.map((message) => {
                            const preview = getMessagePreview(message.parts);
                            const timestamp = message.info.time.created;
                            const relativeTime = formatRelativeTime(timestamp);
                            const messageNumber = userMessages.length - userMessages.indexOf(message);

                            return (
                                <div
                                    key={message.info.id}
                                    className="group flex items-center gap-2 py-1.5 hover:bg-interactive-hover/30 rounded transition-colors cursor-pointer"
                                    onClick={async () => {
                                        const didNavigate = await onScrollToMessage?.(message.info.id);
                                        if (didNavigate === false) {
                                            return;
                                        }
                                        onOpenChange(false);
                                    }}
                                >
                                    <span className="typography-meta text-muted-foreground w-5 text-right flex-shrink-0">
                                        {messageNumber}.
                                    </span>
                                    <p className="flex-1 min-w-0 typography-small text-foreground truncate ml-0.5">
                                        {preview || '[No text content]'}
                                        {preview && preview.length >= 80 && '…'}
                                    </p>

                                    <div className="flex-shrink-0 h-5 flex items-center mr-2">
                                        <span className="typography-meta text-muted-foreground whitespace-nowrap group-hover:hidden">
                                            {relativeTime}
                                        </span>

                                        <div className="hidden group-hover:flex gap-1">
                                            <Tooltip delayDuration={1000}>
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
                                                        <RiArrowGoBackLine className="h-4 w-4" />
                                                    </button>
                                                </TooltipTrigger>
                                                <TooltipContent sideOffset={6}>Revert from here</TooltipContent>
                                            </Tooltip>

                                            <Tooltip delayDuration={1000}>
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
                                                            <RiLoader4Line className="h-4 w-4 animate-spin" />
                                                        ) : (
                                                            <RiGitBranchLine className="h-4 w-4" />
                                                        )}
                                                    </button>
                                                </TooltipTrigger>
                                                <TooltipContent sideOffset={6}>Fork from here</TooltipContent>
                                            </Tooltip>
                                        </div>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>

                <div className="mt-4 p-3 bg-muted/30 rounded-lg">
                    <p className="typography-meta text-muted-foreground font-medium mb-2">Actions</p>
                    <div className="mb-2 flex items-center gap-2">
                        <button
                            type="button"
                            className="text-[11px] uppercase tracking-wide text-muted-foreground/90 hover:text-foreground"
                            onClick={() => {
                                void onScrollByTurnOffset?.(-1);
                                onOpenChange(false);
                            }}
                        >
                            Previous turn
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
                            Latest
                        </button>
                    </div>
                    <div className="flex flex-col gap-1.5 typography-meta text-muted-foreground">
                        <div className="flex items-center gap-2">
                            <span>Click on a message to scroll to it in the conversation</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <RiArrowGoBackLine className="h-4 w-4 flex-shrink-0" />
                            <span>Undo to this point (message text will populate input)</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <RiGitBranchLine className="h-4 w-4 flex-shrink-0" />
                            <span>Create a new session starting from here</span>
                        </div>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
};

function getMessagePreview(parts: Part[]): string {
    const textPart = parts.find(p => p.type === 'text');
    if (!textPart || typeof textPart.text !== 'string') return '';
    return textPart.text.replace(/\n/g, ' ').slice(0, 80);
}

import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';

import UserTextPart from './parts/UserTextPart';
import ToolPart from './parts/ToolPart';
import ProgressiveGroup from './parts/ProgressiveGroup';
import ReasoningPart from './parts/ReasoningPart';
import { MessageFilesDisplay } from '../FileAttachment';
import type { ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';
import type { StreamPhase, ToolPopupContent, AgentMentionInfo } from './types';
import type { TurnGroupingContext } from '../hooks/useTurnGrouping';
import { cn } from '@/lib/utils';
import { isEmptyTextPart, extractTextContent } from './partUtils';
import { FadeInOnReveal } from './FadeInOnReveal';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RiCheckLine, RiFileCopyLine, RiChatNewLine, RiArrowGoBackLine, RiGitBranchLine, RiHourglassLine, RiVolumeUpLine, RiStopLine } from '@remixicon/react';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';

import { SimpleMarkdownRenderer } from '../MarkdownRenderer';
import { useMessageStore } from '@/stores/messageStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import { flattenAssistantTextParts } from '@/lib/messages/messageText';
import { MULTIRUN_EXECUTION_FORK_PROMPT_META_TEXT } from '@/lib/messages/executionMeta';
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { useConfigStore } from '@/stores/useConfigStore';
import { TextSelectionMenu } from './TextSelectionMenu';
import { copyTextToClipboard } from '@/lib/clipboard';
import { formatTimestampForDisplay } from './timeFormat';

type SubtaskPartLike = Part & {
    type: 'subtask';
    description?: unknown;
    command?: unknown;
    agent?: unknown;
    prompt?: unknown;
    taskSessionID?: unknown;
    model?: {
        providerID?: unknown;
        modelID?: unknown;
    };
};

type ShellActionPartLike = Part & {
    type: 'text';
    shellAction?: {
        command?: unknown;
        output?: unknown;
        status?: unknown;
    };
};

const isSubtaskPart = (part: Part): part is SubtaskPartLike => {
    return part.type === 'subtask';
};

const isShellActionPart = (part: Part): part is ShellActionPartLike => {
    const textPart = part as unknown as { type?: unknown; shellAction?: unknown };
    return textPart.type === 'text' && typeof textPart.shellAction === 'object' && textPart.shellAction !== null;
};

const normalizeSubtaskModel = (model: SubtaskPartLike['model']): string | null => {
    if (!model || typeof model !== 'object') return null;
    const providerID = typeof model.providerID === 'string' ? model.providerID.trim() : '';
    const modelID = typeof model.modelID === 'string' ? model.modelID.trim() : '';
    if (!providerID || !modelID) return null;
    return `${providerID}/${modelID}`;
};

const UserSubtaskPart: React.FC<{ part: SubtaskPartLike }> = ({ part }) => {
    const [expanded, setExpanded] = React.useState(false);
    const setCurrentSession = useSessionStore((state) => state.setCurrentSession);

    const description = typeof part.description === 'string' ? part.description.trim() : '';
    const command = typeof part.command === 'string' ? part.command.trim() : '';
    const agent = typeof part.agent === 'string' ? part.agent.trim() : '';
    const prompt = typeof part.prompt === 'string' ? part.prompt.trim() : '';
    const taskSessionID = typeof part.taskSessionID === 'string' ? part.taskSessionID.trim() : '';
    const model = normalizeSubtaskModel(part.model);

    return (
        <div className="mt-2">
            <div className="flex items-center gap-2 flex-wrap">
                <span className="typography-meta font-semibold text-foreground">Delegated task</span>
                {command ? (
                    <span className="inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none bg-foreground/5 text-muted-foreground">
                        /{command}
                    </span>
                ) : null}
                {agent ? (
                    <span className="inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none bg-foreground/5 text-muted-foreground">
                        @{agent}
                    </span>
                ) : null}
                {model ? (
                    <span className="inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none bg-foreground/5 text-muted-foreground">
                        {model}
                    </span>
                ) : null}
            </div>

            {description ? (
                <div className="typography-ui-label text-foreground/90 mt-1.5">
                    {description}
                </div>
            ) : null}

            {prompt ? (
                <div className="mt-2 border-t border-border/60 pt-1.5">
                    <button
                        type="button"
                        className="typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                        onClick={() => setExpanded((value) => !value)}
                    >
                        {expanded ? 'Hide prompt' : 'Show prompt'}
                    </button>
                    {expanded ? (
                        <pre className="typography-meta mt-1.5 overflow-x-auto whitespace-pre-wrap break-words text-foreground/85">
                            {prompt}
                        </pre>
                    ) : null}
                </div>
            ) : null}

            {taskSessionID ? (
                <div className="mt-1.5">
                    <button
                        type="button"
                        className="typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                        onClick={() => {
                            void setCurrentSession(taskSessionID);
                        }}
                    >
                        Open subtask session
                    </button>
                </div>
            ) : null}
        </div>
    );
};

const UserShellActionPart: React.FC<{ part: ShellActionPartLike }> = ({ part }) => {
    const [expanded, setExpanded] = React.useState(false);
    const [copiedOutput, setCopiedOutput] = React.useState(false);
    const copiedResetTimeoutRef = React.useRef<number | null>(null);

    const command = typeof part.shellAction?.command === 'string' ? part.shellAction.command.trim() : '';
    const output = typeof part.shellAction?.output === 'string' ? part.shellAction.output : '';
    const status = typeof part.shellAction?.status === 'string' ? part.shellAction.status.trim().toLowerCase() : '';
    const hasOutput = output.trim().length > 0;

    const clearCopiedResetTimeout = React.useCallback(() => {
        if (copiedResetTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(copiedResetTimeoutRef.current);
            copiedResetTimeoutRef.current = null;
        }
    }, []);

    React.useEffect(() => {
        return () => {
            clearCopiedResetTimeout();
        };
    }, [clearCopiedResetTimeout]);

    const copyOutputToClipboard = React.useCallback(async () => {
        if (!hasOutput) return;

        const result = await copyTextToClipboard(output);
        if (!result.ok) return;

        clearCopiedResetTimeout();
        setCopiedOutput(true);
        if (typeof window !== 'undefined') {
            copiedResetTimeoutRef.current = window.setTimeout(() => {
                setCopiedOutput(false);
                copiedResetTimeoutRef.current = null;
            }, 2000);
        }
    }, [clearCopiedResetTimeout, hasOutput, output]);

    return (
        <div className="mt-2">
            <div className="flex items-center gap-2 flex-wrap">
                <span className="typography-meta font-semibold text-foreground">Shell command</span>
                {status ? (
                    <span className={cn(
                        'inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none',
                        status === 'error'
                            ? 'bg-[var(--status-error-background)] text-[var(--status-error)]'
                            : 'bg-foreground/5 text-muted-foreground'
                    )}>
                        {status}
                    </span>
                ) : null}
            </div>

            {command ? (
                <pre className="typography-meta mt-1.5 overflow-x-auto whitespace-pre-wrap break-words text-foreground/90 font-mono">
                    {command}
                </pre>
            ) : null}

            {hasOutput ? (
                <div className="mt-2 border-t border-border/60 pt-1.5">
                    <div className="flex items-center gap-3 flex-wrap">
                        <button
                            type="button"
                            className="typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                            onClick={() => setExpanded((value) => !value)}
                        >
                            {expanded ? 'Hide output' : 'Show output'}
                        </button>
                        <button
                            type="button"
                            className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                            onClick={() => {
                                void copyOutputToClipboard();
                            }}
                            aria-label={copiedOutput ? 'Copied' : 'Copy output'}
                            title={copiedOutput ? 'Copied' : 'Copy output'}
                        >
                            {copiedOutput ? <RiCheckLine className="h-3.5 w-3.5" /> : <RiFileCopyLine className="h-3.5 w-3.5" />}
                        </button>
                    </div>
                    {expanded ? (
                        <pre className="typography-meta mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words text-foreground/85 font-mono">
                            {output}
                        </pre>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};

const formatTurnDuration = (durationMs: number): string => {
    const totalSeconds = durationMs / 1000;
    if (totalSeconds < 60) {
        return `${totalSeconds.toFixed(1)}s`;
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.round(totalSeconds % 60);
    return `${minutes}m ${seconds}s`;
};

const ACTIVITY_STANDALONE_TOOL_NAMES = new Set<string>(['task']);

const isActivityStandaloneTool = (toolName: unknown): boolean => {
    return typeof toolName === 'string' && ACTIVITY_STANDALONE_TOOL_NAMES.has(toolName.toLowerCase());
};

interface MessageBodyProps {
    messageId: string;
    parts: Part[];
    isUser: boolean;
    isMessageCompleted: boolean;
    messageFinish?: string;
    messageCompletedAt?: number;
    messageCreatedAt?: number;

    syntaxTheme: { [key: string]: React.CSSProperties };

    isMobile: boolean;
    hasTouchInput?: boolean;
    copiedCode: string | null;
    onCopyCode: (code: string) => void;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    streamPhase: StreamPhase;
    allowAnimation: boolean;
    onContentChange?: (reason?: ContentChangeReason, messageId?: string) => void;

    shouldShowHeader?: boolean;
    hasTextContent?: boolean;
    onCopyMessage?: () => void;
    copiedMessage?: boolean;
    onAuxiliaryContentComplete?: () => void;
    showReasoningTraces?: boolean;
    agentMention?: AgentMentionInfo;
    turnGroupingContext?: TurnGroupingContext;
    onRevert?: () => void;
    onFork?: () => void;
    errorMessage?: string;
}

const UserMessageBody: React.FC<{
    messageId: string;
    parts: Part[];
    isMobile: boolean;
    hasTouchInput?: boolean;
    hasTextContent?: boolean;
    onCopyMessage?: () => void;
    copiedMessage?: boolean;
    onShowPopup: (content: ToolPopupContent) => void;
    agentMention?: AgentMentionInfo;
    onRevert?: () => void;
    onFork?: () => void;
}> = ({ messageId, parts, isMobile, hasTouchInput, hasTextContent, onCopyMessage, copiedMessage, onShowPopup, agentMention, onRevert, onFork }) => {
    const [copyHintVisible, setCopyHintVisible] = React.useState(false);
    const copyHintTimeoutRef = React.useRef<number | null>(null);

    const userContentParts = React.useMemo(() => {
        return parts.filter((part) => {
            if (part.type === 'text') {
                return !isEmptyTextPart(part);
            }
            if (isSubtaskPart(part)) {
                return true;
            }
            if (isShellActionPart(part)) {
                return true;
            }
            return false;
        });
    }, [parts]);

    const mentionToken = agentMention?.token;
    let mentionInjected = false;

    const canCopyMessage = Boolean(onCopyMessage);
    const isMessageCopied = Boolean(copiedMessage);
    const isTouchContext = Boolean(hasTouchInput ?? isMobile);
    const hasCopyableText = Boolean(hasTextContent);

    const clearCopyHintTimeout = React.useCallback(() => {
        if (copyHintTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(copyHintTimeoutRef.current);
            copyHintTimeoutRef.current = null;
        }
    }, []);

    const revealCopyHint = React.useCallback(() => {
        if (!isTouchContext || !canCopyMessage || !hasCopyableText || typeof window === 'undefined') {
            return;
        }

        clearCopyHintTimeout();
        setCopyHintVisible(true);
        copyHintTimeoutRef.current = window.setTimeout(() => {
            setCopyHintVisible(false);
            copyHintTimeoutRef.current = null;
        }, 1800);
    }, [canCopyMessage, clearCopyHintTimeout, hasCopyableText, isTouchContext]);

    React.useEffect(() => {
        if (!hasCopyableText) {
            setCopyHintVisible(false);
            clearCopyHintTimeout();
        }
    }, [clearCopyHintTimeout, hasCopyableText]);

    const handleCopyButtonClick = React.useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            if (!onCopyMessage || !hasCopyableText) {
                return;
            }

            event.stopPropagation();
            event.preventDefault();
            onCopyMessage();

            if (isTouchContext) {
                revealCopyHint();
            }
        },
        [hasCopyableText, isTouchContext, onCopyMessage, revealCopyHint]
    );

    return (
        <div
            className="relative w-full group/message"
            style={{ contain: 'layout', transform: 'translateZ(0)' }}
            onTouchStart={isTouchContext && canCopyMessage && hasCopyableText ? revealCopyHint : undefined}
        >
            <div className="leading-relaxed overflow-hidden text-foreground/90 text-base">
                {userContentParts.map((part, index) => {
                    if (isSubtaskPart(part)) {
                        return (
                            <FadeInOnReveal key={part.id ?? `user-subtask-${index}`}>
                                <UserSubtaskPart part={part} />
                            </FadeInOnReveal>
                        );
                    }

                    if (isShellActionPart(part)) {
                        return (
                            <FadeInOnReveal key={part.id ?? `user-shell-${index}`}>
                                <UserShellActionPart part={part} />
                            </FadeInOnReveal>
                        );
                    }

                    let mentionForPart: AgentMentionInfo | undefined;
                    if (agentMention && mentionToken && !mentionInjected) {
                        const candidateText = extractTextContent(part);
                        if (candidateText.includes(mentionToken)) {
                            mentionForPart = agentMention;
                            mentionInjected = true;
                        }
                    }
                    return (
                        <FadeInOnReveal key={part.id ?? `user-text-${index}`}>
                            <UserTextPart
                                part={part}
                                messageId={messageId}
                                isMobile={isMobile}
                                agentMention={mentionForPart}
                            />
                        </FadeInOnReveal>
                    );
                })}
            </div>
            <MessageFilesDisplay files={parts} onShowPopup={onShowPopup} compact />
            {(canCopyMessage && hasCopyableText) || onRevert || onFork ? (
                <div className={cn(
                    "absolute top-full left-0 right-0 z-10 group/user-actions",
                    isMobile ? "pt-2 pb-3" : "pt-5"
                )}>
                    <div
                        className={cn(
                            "flex translate-x-5 items-center justify-end gap-1",
                            isMobile
                                ? "pointer-events-auto opacity-100"
                                : "pointer-events-none opacity-0 transition-opacity duration-150 group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-hover/user-actions:pointer-events-auto group-hover/user-actions:opacity-100"
                        )}
                    >
                    {onRevert && (
                        <Tooltip delayDuration={1000}>
                            <TooltipTrigger asChild>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                                    aria-label="Revert to this message"
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onRevert();
                                    }}
                                >
                                    <RiArrowGoBackLine className="h-3 w-3" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent sideOffset={6}>Revert from here</TooltipContent>
                        </Tooltip>
                    )}
                    {onFork && (
                        <Tooltip delayDuration={1000}>
                            <TooltipTrigger asChild>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onFork();
                                    }}
                                >
                                    <RiGitBranchLine className="h-3 w-3" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent sideOffset={6}>Fork from here</TooltipContent>
                        </Tooltip>
                    )}
                    {canCopyMessage && hasCopyableText && (
                        <Tooltip delayDuration={1000}>
                            <TooltipTrigger asChild>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    data-visible={copyHintVisible || isMessageCopied ? 'true' : undefined}
                                    className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                                    aria-label="Copy message text"
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={handleCopyButtonClick}
                                    onFocus={() => setCopyHintVisible(true)}
                                    onBlur={() => {
                                        if (!isMessageCopied) {
                                            setCopyHintVisible(false);
                                        }
                                    }}
                                >
                                    {isMessageCopied ? (
                                        <RiCheckLine className="h-3 w-3 text-[color:var(--status-success)]" />
                                    ) : (
                                        <RiFileCopyLine className="h-3 w-3" />
                                    )}
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent sideOffset={6}>Copy message</TooltipContent>
                        </Tooltip>
                    )}
                    </div>
                </div>
            ) : null}
        </div>
    );
};

const AssistantMessageBody: React.FC<Omit<MessageBodyProps, 'isUser'>> = ({
    messageId,
    parts,
    isMessageCompleted,
    messageFinish,
    messageCompletedAt,
    messageCreatedAt,

    syntaxTheme,
    isMobile,
    hasTouchInput,
    expandedTools,
    onToggleTool,
    onShowPopup,
    streamPhase: _streamPhase,
    allowAnimation: _allowAnimation,
    onContentChange,
    hasTextContent = false,
    onCopyMessage,
    copiedMessage = false,
    onAuxiliaryContentComplete,
    showReasoningTraces = false,
    turnGroupingContext,
    errorMessage,
}) => {

    void _streamPhase;
    void _allowAnimation;
    const [copyHintVisible, setCopyHintVisible] = React.useState(false);
    const copyHintTimeoutRef = React.useRef<number | null>(null);
    const messageContentRef = React.useRef<HTMLDivElement>(null);

    const canCopyMessage = Boolean(onCopyMessage);
    const isMessageCopied = Boolean(copiedMessage);
    const isTouchContext = Boolean(hasTouchInput ?? isMobile);
    const awaitingMessageCompletion = !isMessageCompleted;

    const visibleParts = React.useMemo(() => {
        return parts
            .filter((part) => !isEmptyTextPart(part))
            .filter((part) => {
                const rawPart = part as Record<string, unknown>;
                return rawPart.type !== 'compaction';
            });
    }, [parts]);

    const toolParts = React.useMemo(() => {
        return visibleParts.filter((part): part is ToolPartType => part.type === 'tool');
    }, [visibleParts]);

    const assistantTextParts = React.useMemo(() => {
        return visibleParts.filter((part) => part.type === 'text');
    }, [visibleParts]);

    const createSessionFromAssistantMessage = useSessionStore((state) => state.createSessionFromAssistantMessage);
    const openMultiRunLauncherWithPrompt = useUIStore((state) => state.openMultiRunLauncherWithPrompt);
    const isLastAssistantInTurn = turnGroupingContext?.isLastAssistantInTurn ?? false;
    const hasStopFinish = messageFinish === 'stop';

    // TTS for message playback
    const { isPlaying: isTTSPlaying, play: playTTS, stop: stopTTS } = useMessageTTS();
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    const voiceProvider = useConfigStore((state) => state.voiceProvider);

    const readAloudTooltip = React.useMemo(() => {
        if (isTTSPlaying) {
            return 'Stop speaking';
        }
        const providerLabel = voiceProvider === 'browser' ? 'Browser' : voiceProvider === 'openai' ? 'OpenAI' : 'Say';
        return `Read aloud (${providerLabel} voice)`;
    }, [isTTSPlaying, voiceProvider]);


    const hasTools = toolParts.length > 0;

    const hasPendingTools = React.useMemo(() => {
        return toolParts.some((toolPart) => {
            const state = (toolPart as Record<string, unknown>).state as Record<string, unknown> | undefined ?? {};
            const status = state?.status;
            return status === 'pending' || status === 'running' || status === 'started';
        });
    }, [toolParts]);

    const isToolFinalized = React.useCallback((toolPart: ToolPartType) => {
        const state = (toolPart as Record<string, unknown>).state as Record<string, unknown> | undefined ?? {};
        const status = state?.status;
        if (status === 'pending' || status === 'running' || status === 'started') {
            return false;
        }
        const time = state?.time as Record<string, unknown> | undefined ?? {};
        const endTime = typeof time?.end === 'number' ? time.end : undefined;
        const startTime = typeof time?.start === 'number' ? time.start : undefined;
        if (typeof endTime !== 'number') {
            return false;
        }
        if (typeof startTime === 'number' && endTime < startTime) {
            return false;
        }
        return true;
    }, []);

    const allToolsFinalized = React.useMemo(() => {
        if (toolParts.length === 0) {
            return true;
        }
        if (hasPendingTools) {
            return false;
        }
        return toolParts.every((toolPart) => isToolFinalized(toolPart));
    }, [toolParts, hasPendingTools, isToolFinalized]);


    const reasoningParts = React.useMemo(() => {
        return visibleParts.filter((part) => part.type === 'reasoning');
    }, [visibleParts]);

    const reasoningComplete = React.useMemo(() => {
        if (reasoningParts.length === 0) {
            return true;
        }
        return reasoningParts.every((part) => {
            const time = (part as Record<string, unknown>).time as { end?: number } | undefined;
            return typeof time?.end === 'number';
        });
    }, [reasoningParts]);

    // Message is considered to have an "open step" if info.finish is not yet present
    const hasOpenStep = typeof messageFinish !== 'string';

    const shouldHoldForReasoning =
        reasoningParts.length > 0 &&
        hasTools &&
        (hasPendingTools || hasOpenStep || !allToolsFinalized);


    const shouldHoldTools = awaitingMessageCompletion
        || (hasTools && (hasPendingTools || hasOpenStep || !allToolsFinalized));
    const shouldHoldReasoning = awaitingMessageCompletion || shouldHoldForReasoning;

    const hasAuxiliaryContent = hasTools || reasoningParts.length > 0;
    const isTextlessAssistantMessage = assistantTextParts.length === 0;
    const auxiliaryContentComplete = hasAuxiliaryContent && isTextlessAssistantMessage && !shouldHoldTools && !shouldHoldReasoning && allToolsFinalized && reasoningComplete;
    const auxiliaryCompletionAnnouncedRef = React.useRef(false);
    const soloReasoningScrollTriggeredRef = React.useRef(false);

    React.useEffect(() => {
        soloReasoningScrollTriggeredRef.current = false;
    }, [messageId]);

    React.useEffect(() => {
        if (!auxiliaryContentComplete) {
            auxiliaryCompletionAnnouncedRef.current = false;
            return;
        }
        if (auxiliaryCompletionAnnouncedRef.current) {
            return;
        }
        auxiliaryCompletionAnnouncedRef.current = true;
        onAuxiliaryContentComplete?.();
    }, [auxiliaryContentComplete, onAuxiliaryContentComplete]);

    React.useEffect(() => {
        if (awaitingMessageCompletion) {
            soloReasoningScrollTriggeredRef.current = false;
            return;
        }
        if (hasTools) {
            soloReasoningScrollTriggeredRef.current = false;
            return;
        }
        if (reasoningParts.length === 0) {
            return;
        }
        if (shouldHoldReasoning || !reasoningComplete) {
            return;
        }
        if (soloReasoningScrollTriggeredRef.current) {
            return;
        }
        soloReasoningScrollTriggeredRef.current = true;
        onContentChange?.('structural');
    }, [awaitingMessageCompletion, hasTools, onContentChange, reasoningComplete, reasoningParts.length, shouldHoldReasoning]);

    const hasCopyableText = Boolean(hasTextContent) && !awaitingMessageCompletion;

    const clearCopyHintTimeout = React.useCallback(() => {
        if (copyHintTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(copyHintTimeoutRef.current);
            copyHintTimeoutRef.current = null;
        }
    }, []);

    const revealCopyHint = React.useCallback(() => {
        if (!isTouchContext || !canCopyMessage || !hasCopyableText || typeof window === 'undefined') {
            return;
        }

        clearCopyHintTimeout();
        setCopyHintVisible(true);
        copyHintTimeoutRef.current = window.setTimeout(() => {
            setCopyHintVisible(false);
            copyHintTimeoutRef.current = null;
        }, 1800);
    }, [canCopyMessage, clearCopyHintTimeout, hasCopyableText, isTouchContext]);

    React.useEffect(() => {
        if (!hasCopyableText) {
            setCopyHintVisible(false);
            clearCopyHintTimeout();
        }
    }, [clearCopyHintTimeout, hasCopyableText]);

    const handleCopyButtonClick = React.useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            if (!onCopyMessage || !hasCopyableText) {
                return;
            }

            event.stopPropagation();
            event.preventDefault();
            onCopyMessage();

            if (isTouchContext) {
                revealCopyHint();
            }
        },
        [hasCopyableText, isTouchContext, onCopyMessage, revealCopyHint]
    );

    const handleForkClick = React.useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            event.preventDefault();
            if (!createSessionFromAssistantMessage) {
                return;
            }
            void createSessionFromAssistantMessage(messageId);
        },
        [createSessionFromAssistantMessage, messageId]
    );

    const handleForkMultiRunClick = React.useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            event.preventDefault();

            const assistantPlanText = flattenAssistantTextParts(assistantTextParts);
            if (!assistantPlanText.trim()) {
                return;
            }

            const prefilledPrompt = `${MULTIRUN_EXECUTION_FORK_PROMPT_META_TEXT}\n\n${assistantPlanText}`;
            openMultiRunLauncherWithPrompt(prefilledPrompt);
        },
        [assistantTextParts, openMultiRunLauncherWithPrompt]
    );

    const handleTTSClick = React.useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            event.preventDefault();
            
            if (isTTSPlaying) {
                stopTTS();
                return;
            }
            
            const messageText = flattenAssistantTextParts(assistantTextParts);
            if (messageText.trim()) {
                void playTTS(messageText);
            }
        },
        [assistantTextParts, isTTSPlaying, playTTS, stopTTS]
    );

    React.useEffect(() => {
        return () => {
            clearCopyHintTimeout();
        };
    }, [clearCopyHintTimeout]);

    const toolConnections = React.useMemo(() => {
        const connections: Record<string, { hasPrev: boolean; hasNext: boolean }> = {};
        const displayableTools = toolParts.filter((toolPart) => {
            if (isActivityStandaloneTool(toolPart.tool)) {
                return false;
            }
            if (shouldHoldTools) {
                return false;
            }
            return isToolFinalized(toolPart);
        });

        displayableTools.forEach((toolPart, index) => {
            connections[toolPart.id] = {
                hasPrev: index > 0,
                hasNext: index < displayableTools.length - 1,
            };
        });

        return connections;
    }, [toolParts, shouldHoldTools, isToolFinalized]);

    const activityPartsForTurn = React.useMemo(() => {
        return turnGroupingContext?.activityParts ?? [];
    }, [turnGroupingContext]);

    const activityPartsForMessage = React.useMemo(() => {
        if (!turnGroupingContext) return [];
        return activityPartsForTurn.filter((activity) => activity.messageId === messageId);
    }, [activityPartsForTurn, messageId, turnGroupingContext]);

    const activityGroupSegmentsForMessage = React.useMemo(() => {
        if (!turnGroupingContext) return [];
        return turnGroupingContext.activityGroupSegments.filter((segment) => segment.anchorMessageId === messageId);
    }, [messageId, turnGroupingContext]);

    const activityPartsByPart = React.useMemo(() => {
        const map = new Map<Part, (typeof activityPartsForMessage)[number]>();
        activityPartsForMessage.forEach((activity) => {
            map.set(activity.part, activity);
        });
        return map;
    }, [activityPartsForMessage]);


    const visibleActivityPartsForTurn = React.useMemo(() => {
        if (!turnGroupingContext) return [];

        // Filter out reasoning if showReasoningTraces is off.
        // Justification parts are already filtered at the source (useTurnGrouping)
        // based on showTextJustificationActivity, so we keep them here.
        const base = !showReasoningTraces
            ? activityPartsForTurn.filter((activity) => activity.kind !== 'reasoning')
            : activityPartsForTurn;

        // Tools rendered standalone are excluded from Activity group.
        return base.filter((activity) => {
            if (activity.kind !== 'tool') {
                return true;
            }
            const toolName = (activity.part as ToolPartType).tool;
            return !isActivityStandaloneTool(toolName);
        });
    }, [activityPartsForTurn, showReasoningTraces, turnGroupingContext]);

    const [hasEverHadMultipleVisibleActivities, setHasEverHadMultipleVisibleActivities] = React.useState(false);

    React.useEffect(() => {
        if (!turnGroupingContext) {
            return;
        }

        const hasTaskSplitSegments = turnGroupingContext.activityGroupSegments.some(
            (segment) => segment.afterToolPartId !== null
        );

        const hasReasoningActivity = visibleActivityPartsForTurn.some(
            (activity) => activity.kind === 'reasoning'
        );

        if (
            visibleActivityPartsForTurn.length > 1 ||
            (hasTaskSplitSegments && visibleActivityPartsForTurn.length > 0) ||
            hasReasoningActivity
        ) {
            setHasEverHadMultipleVisibleActivities(true);
        }
    }, [turnGroupingContext, visibleActivityPartsForTurn]);

    const shouldShowActivityGroup = Boolean(turnGroupingContext && hasEverHadMultipleVisibleActivities);

    const shouldRenderActivityGroup = Boolean(
        turnGroupingContext &&
            shouldShowActivityGroup &&
            visibleActivityPartsForTurn.length > 0 &&
            activityGroupSegmentsForMessage.length > 0
    );

    const standaloneToolParts = React.useMemo(() => {
        return toolParts.filter((toolPart) => isActivityStandaloneTool(toolPart.tool));
    }, [toolParts]);


    const renderedParts = React.useMemo(() => {
        const rendered: React.ReactNode[] = [];

        const renderActivitySegments = (afterToolPartId: string | null) => {
            if (!turnGroupingContext || !shouldRenderActivityGroup) {
                return;
            }

            activityGroupSegmentsForMessage
                .filter((segment) => (segment.afterToolPartId ?? null) === afterToolPartId)
                .forEach((segment) => {
                    // Filter out reasoning if showReasoningTraces is off.
                    // Justification parts are already filtered at the source (useTurnGrouping)
                    // based on showTextJustificationActivity, so we keep them here.
                    const visibleSegmentParts = !showReasoningTraces
                        ? segment.parts.filter((activity) => activity.kind !== 'reasoning')
                        : segment.parts;

                    if (visibleSegmentParts.length === 0) {
                        return;
                    }

                    rendered.push(
                        <ProgressiveGroup
                            key={`progressive-group-${segment.id}`}
                            parts={visibleSegmentParts}
                            isExpanded={turnGroupingContext.isGroupExpanded}
                            onToggle={turnGroupingContext.toggleGroup}
                            syntaxTheme={syntaxTheme}
                            isMobile={isMobile}
                            expandedTools={expandedTools}
                            onToggleTool={onToggleTool}
                            onShowPopup={onShowPopup}
                            onContentChange={onContentChange}
                            diffStats={turnGroupingContext.diffStats}
                        />
                    );
                });
        };

        // Activity groups and standalone tasks are interleaved in message order.
        // Note: Reasoning parts are rendered in the visibleParts.forEach loop below
        // when Activity group isn't showing, to maintain proper ordering with tools.
        renderActivitySegments(null);

        standaloneToolParts.forEach((standaloneToolPart) => {
            rendered.push(
                <FadeInOnReveal key={`standalone-tool-${standaloneToolPart.id}`}>
                    <ToolPart
                        part={standaloneToolPart}
                        isExpanded={expandedTools.has(standaloneToolPart.id)}
                        onToggle={onToggleTool}
                        syntaxTheme={syntaxTheme}
                        isMobile={isMobile}
                        onContentChange={onContentChange}
                        onShowPopup={onShowPopup}
                        hasPrevTool={false}
                        hasNextTool={false}
                    />
                </FadeInOnReveal>
            );

            renderActivitySegments(standaloneToolPart.id);
        });

        const partsWithTime: Array<{
            part: Part;
            index: number;
            endTime: number | null;
            element: React.ReactNode;
        }> = [];

        visibleParts.forEach((part, index) => {
            const activity = activityPartsByPart.get(part);
            if (!activity) {
                return;
            }

            if (!turnGroupingContext) {
                return;
            }

            let endTime: number | null = null;
            let element: React.ReactNode | null = null;

            if (!shouldShowActivityGroup) {
                if (activity.kind === 'tool') {
                    const toolPart = part as ToolPartType;

                    if (isActivityStandaloneTool(toolPart.tool)) {
                        return;
                    }

                    const toolState = (toolPart as { state?: { time?: { end?: number | null | undefined } | null | undefined } | null | undefined }).state;
                    const time = toolState?.time;
                    const isFinalized = isToolFinalized(toolPart);
                    const shouldShowTool = !shouldHoldTools && isFinalized;

                    if (!shouldShowTool) {
                        return;
                    }

                    const connection = toolConnections[toolPart.id];

                    const toolElement = (
                        <FadeInOnReveal key={`tool-${toolPart.id}`}>
                            <ToolPart
                                part={toolPart}
                                isExpanded={expandedTools.has(toolPart.id)}
                                onToggle={onToggleTool}
                                syntaxTheme={syntaxTheme}
                                isMobile={isMobile}
                                onContentChange={onContentChange}
                                onShowPopup={onShowPopup}
                                hasPrevTool={connection?.hasPrev ?? false}
                                hasNextTool={connection?.hasNext ?? false}
                            />
                        </FadeInOnReveal>
                    );

                    element = toolElement;
                    endTime = isFinalized && typeof time?.end === 'number' ? time.end : null;
                } else if (activity.kind === 'reasoning' && showReasoningTraces) {
                    // Fallback rendering for reasoning when Activity group isn't shown
                    const time = (part as { time?: { end?: number | null | undefined } | null | undefined }).time;
                    const partEndTime = typeof time?.end === 'number' ? time.end : null;

                    const reasoningElement = (
                        <FadeInOnReveal key={`reasoning-${activity.id}`}>
                            <ReasoningPart
                                part={part}
                                messageId={messageId}
                                onContentChange={onContentChange}
                            />
                        </FadeInOnReveal>
                    );

                    element = reasoningElement;
                    endTime = partEndTime;
                }

                if (element) {
                    partsWithTime.push({
                        part,
                        index,
                        endTime,
                        element,
                    });
                }
            }
        });

        partsWithTime.sort((a, b) => {
            if (a.endTime === null && b.endTime === null) {
                return a.index - b.index;
            }
            if (a.endTime === null) {
                return 1;
            }
            if (b.endTime === null) {
                return -1;
            }
            return a.endTime - b.endTime;
        });

        partsWithTime.forEach(({ element }) => {
            rendered.push(element);
        });

        return rendered;
    }, [
        activityPartsByPart,
        activityGroupSegmentsForMessage,
        expandedTools,
        isMobile,
        isToolFinalized,
        messageId,
        onContentChange,
        onShowPopup,
        onToggleTool,
        shouldHoldTools,
        shouldShowActivityGroup,
        showReasoningTraces,
        syntaxTheme,
        toolConnections,
        turnGroupingContext,
        visibleParts,
        standaloneToolParts,
        shouldRenderActivityGroup,
    ]);

    const userMessageId = turnGroupingContext?.turnId;
    const currentSessionId = useSessionStore((state) => state.currentSessionId);

    const rawSummaryBodyFromStore = useMessageStore((state) => {
        if (!userMessageId || !currentSessionId) return undefined;
        const sessionMessages = state.messages.get(currentSessionId);
        if (!sessionMessages) return undefined;
        const userMsg = sessionMessages.find((m) => m.info?.id === userMessageId);
        if (!userMsg) return undefined;
        const summary = (userMsg.info as { summary?: { body?: string | null | undefined } | null | undefined }).summary;
        const body = summary?.body;
        return typeof body === 'string' && body.trim().length > 0 ? body : undefined;
    });

    const summaryCandidate =
        typeof turnGroupingContext?.summaryBody === 'string' && turnGroupingContext.summaryBody.trim().length > 0
            ? turnGroupingContext.summaryBody
            : rawSummaryBodyFromStore;

    const summaryBodyRef = React.useRef<string | undefined>(undefined);
    if (summaryCandidate && summaryCandidate.trim().length > 0) {
        summaryBodyRef.current = summaryCandidate;
    }
    const prevUserMessageId = React.useRef(userMessageId);
    if (prevUserMessageId.current !== userMessageId) {
        prevUserMessageId.current = userMessageId;
        summaryBodyRef.current = undefined;
    }
    const summaryBody = summaryBodyRef.current;

    const showSummaryBody =
        turnGroupingContext?.isLastAssistantInTurn &&
        summaryBody &&
        summaryBody.trim().length > 0;

    const showErrorMessage = Boolean(errorMessage);

    const shouldShowFooter = isLastAssistantInTurn && hasTextContent && (hasStopFinish || Boolean(errorMessage));

    const turnDurationText = React.useMemo(() => {
        if (!isLastAssistantInTurn || !hasStopFinish) return undefined;
        const userCreatedAt = turnGroupingContext?.userMessageCreatedAt;
        if (typeof userCreatedAt !== 'number' || typeof messageCompletedAt !== 'number') return undefined;
        if (messageCompletedAt <= userCreatedAt) return undefined;
        return formatTurnDuration(messageCompletedAt - userCreatedAt);
    }, [isLastAssistantInTurn, hasStopFinish, turnGroupingContext?.userMessageCreatedAt, messageCompletedAt]);

    const footerTimestamp = React.useMemo(() => {
        const timestamp = typeof messageCompletedAt === 'number' && messageCompletedAt > 0
            ? messageCompletedAt
            : (typeof messageCreatedAt === 'number' && messageCreatedAt > 0 ? messageCreatedAt : null);
        if (timestamp === null) return null;

        const formatted = formatTimestampForDisplay(timestamp);
        return formatted.length > 0 ? formatted : null;
    }, [messageCompletedAt, messageCreatedAt]);

    const footerButtons = (
         <>
              {onCopyMessage && (
                  <Tooltip delayDuration={1000}>
                      <TooltipTrigger asChild>
                          <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              data-visible={copyHintVisible || isMessageCopied ? 'true' : undefined}
                              className={cn(
                                  'h-8 w-8 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50',
                                  !hasCopyableText && 'opacity-50'
                              )}
                              disabled={!hasCopyableText}
                              aria-label="Copy message text"
                              aria-hidden={!hasCopyableText}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={handleCopyButtonClick}
                              onFocus={() => {
                                  if (hasCopyableText) {
                                      setCopyHintVisible(true);
                                  }
                              }}
                              onBlur={() => {
                                  if (!isMessageCopied) {
                                      setCopyHintVisible(false);
                                  }
                              }}
                          >
                              {isMessageCopied ? (
                                  <RiCheckLine className="h-3.5 w-3.5 text-[color:var(--status-success)]" />
                              ) : (
                                  <RiFileCopyLine className="h-3.5 w-3.5" />
                              )}
                          </Button>
                      </TooltipTrigger>
                      <TooltipContent sideOffset={6}>Copy answer</TooltipContent>
                  </Tooltip>
              )}
              <Tooltip delayDuration={1000}>
                  <TooltipTrigger asChild>
                      <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={handleForkClick}
                      >
                          <RiChatNewLine className="h-4 w-4" />
                      </Button>
                  </TooltipTrigger>
                  <TooltipContent sideOffset={6}>Start new session from this answer</TooltipContent>
              </Tooltip>
              <Tooltip delayDuration={1000}>
                  <TooltipTrigger asChild>
                      <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={handleForkMultiRunClick}
                      >
                          <ArrowsMerge className="h-4 w-4" />
                      </Button>
                  </TooltipTrigger>
                  <TooltipContent sideOffset={6}>Start new multi-run from this answer</TooltipContent>
              </Tooltip>

              {showMessageTTSButtons && hasCopyableText && (
                  <Tooltip delayDuration={1000}>
                      <TooltipTrigger asChild>
                         <Button
                             type="button"
                             variant="ghost"
                             size="icon"
                             className={cn(
                                 'h-8 w-8 bg-transparent hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50',
                                 isTTSPlaying ? 'text-green-500' : 'text-muted-foreground hover:text-foreground'
                             )}
                             aria-label={isTTSPlaying ? 'Stop speaking' : 'Read aloud'}
                             onPointerDown={(event) => event.stopPropagation()}
                             onClick={handleTTSClick}
                         >
                             {isTTSPlaying ? (
                                 <RiStopLine className="h-3.5 w-3.5" />
                             ) : (
                                 <RiVolumeUpLine className="h-3.5 w-3.5" />
                             )}
                         </Button>
                     </TooltipTrigger>
                       <TooltipContent sideOffset={6}>{readAloudTooltip}</TooltipContent>
                   </Tooltip>
               )}
          </>
      );
 
      return (

         <div
             ref={messageContentRef}
             className={cn(
                 'relative w-full group/message'
             )}
             style={{
                 contain: 'layout',
                 transform: 'translateZ(0)',
             }}
             onTouchStart={isTouchContext && canCopyMessage && hasCopyableText ? revealCopyHint : undefined}
         >
             <TextSelectionMenu containerRef={messageContentRef} />
             <div>
                 <div
                     className="message-content-text leading-relaxed overflow-hidden text-foreground/90 [&_p:last-child]:mb-0 [&_ul:last-child]:mb-0 [&_ol:last-child]:mb-0"
                 >
                    {renderedParts}
                    {showErrorMessage && (
                        <FadeInOnReveal key="assistant-error">
                            <div className="group/assistant-text relative break-words">
                                <SimpleMarkdownRenderer content={errorMessage ?? ''} onShowPopup={onShowPopup} />
                            </div>
                        </FadeInOnReveal>
                    )}
                    {showSummaryBody && (
                        <FadeInOnReveal key="summary-body">
                            <div
                                className="group/assistant-text relative break-words"
                            >
                                <SimpleMarkdownRenderer content={summaryBody} onShowPopup={onShowPopup} />
                                {shouldShowFooter && (
                                    <div className="mt-2 mb-1 flex items-center justify-start gap-1.5">
                                        <div className="flex items-center gap-1.5">
                                            {footerButtons}
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            {turnDurationText ? (
                                                <span className="text-sm text-muted-foreground/60 tabular-nums flex items-center gap-1">
                                                    <RiHourglassLine className="h-3.5 w-3.5" />
                                                    {turnDurationText}
                                                </span>
                                            ) : null}
                                            {footerTimestamp ? (
                                                <span className="text-sm text-muted-foreground/60 tabular-nums">{footerTimestamp}</span>
                                            ) : null}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </FadeInOnReveal>
                    )}
                </div>
                <MessageFilesDisplay files={parts} onShowPopup={onShowPopup} />
                {!showSummaryBody && shouldShowFooter && (
                    <div className="mt-2 mb-1 flex items-center justify-start gap-1.5">
                        <div className="flex items-center gap-1.5">
                            {footerButtons}
                        </div>
                        <div className="flex items-center gap-1.5">
                            {turnDurationText ? (
                                <span className="text-sm text-muted-foreground/60 tabular-nums flex items-center gap-1">
                                    <RiHourglassLine className="h-3.5 w-3.5" />
                                    {turnDurationText}
                                </span>
                            ) : null}
                            {footerTimestamp ? (
                                <span className="text-sm text-muted-foreground/60 tabular-nums">{footerTimestamp}</span>
                            ) : null}
                        </div>
                    </div>
                )}

            </div>
        </div>
    );
};

const MessageBody: React.FC<MessageBodyProps> = ({ isUser, ...props }) => {

    if (isUser) {
        return (
            <UserMessageBody
                messageId={props.messageId}
                parts={props.parts}
                isMobile={props.isMobile}
                hasTouchInput={props.hasTouchInput}
                hasTextContent={props.hasTextContent}
                onCopyMessage={props.onCopyMessage}
                copiedMessage={props.copiedMessage}
                onShowPopup={props.onShowPopup}
                agentMention={props.agentMention}
                onRevert={props.onRevert}
                onFork={props.onFork}
            />
        );
    }

    return <AssistantMessageBody {...props} />;
};

export default React.memo(MessageBody);

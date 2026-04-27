import React from 'react';

import UserTextPart from './parts/UserTextPart';
import ToolPart from './parts/ToolPart';
import AssistantTextPart from './parts/AssistantTextPart';
import ReasoningPart from './parts/ReasoningPart';
import { MessageFilesDisplay } from '../FileAttachment';
import { TurnChangedFilesDropdown } from '../TurnChangedFilesDropdown';
import type { StreamPhase, ToolPopupContent, AgentMentionInfo } from './types';
import type { TurnGroupingContext } from '../lib/turns/types';
import { cn } from '@/lib/utils';
import { isEmptyTextPart, extractTextContent } from './partUtils';
import { FadeInOnReveal } from './FadeInOnReveal';
import { Button } from '@/components/ui/button';
import { SaveProjectPlanDialog } from '@/components/session/SaveProjectPlanDialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RiCheckLine, RiFileCopyLine, RiChatNewLine, RiArrowGoBackLine, RiGitBranchLine, RiHourglassLine, RiTimeLine, RiVolumeUpLine, RiStopLine, RiImageDownloadLine, RiLoader4Line, RiErrorWarningLine, RiBookletLine } from '@remixicon/react';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';
import type { RenderablePart, RenderableToolPart } from './renderable';

import { SimpleMarkdownRenderer } from '../MarkdownRenderer';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { flattenAssistantTextParts, suggestPlanTitleFromText } from '@/lib/messages/messageText';
import { MULTIRUN_EXECUTION_FORK_PROMPT_META_TEXT } from '@/lib/messages/executionMeta';
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { TextSelectionMenu } from './TextSelectionMenu';
import { copyTextToClipboard } from '@/lib/clipboard';
import { isVSCodeRuntime } from '@/lib/desktop';
import { toPng } from 'html-to-image';
import { toast } from '@/components/ui';
import { formatTimestampForDisplay } from './timeFormat';
import { ToolRevealOnMount } from './parts/ToolRevealOnMount';
import { StaticToolRow } from './parts/ProgressiveGroup';
import { isExpandableTool, isStandaloneTool } from './parts/toolRenderUtils';
import TurnActivity from '../components/TurnActivity';
import { createProjectPlanFile } from '@/lib/openchamberConfig';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useSessions } from '@/sync/sync-context';
import { useI18n } from '@/lib/i18n';

const CONTAIN_LAYOUT_STYLE = { contain: 'layout' as const, transform: 'translateZ(0)' };
const MESSAGE_FOOTER_CONTAINER_STYLE = { containerType: 'inline-size' as const, containerName: 'message-footer' };
const INLINE_MESSAGE_ACTIONS_CLASS_NAME = 'mt-2 mb-1 flex items-center justify-start gap-1.5';

type SubtaskPartLike = RenderablePart & {
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

type ShellActionPartLike = RenderablePart & {
    type: 'text';
    shellAction?: {
        command?: unknown;
        output?: unknown;
        status?: unknown;
    };
};

const isSubtaskPart = (part: RenderablePart): part is SubtaskPartLike => {
    return part.type === 'subtask';
};

const isShellActionPart = (part: RenderablePart): part is ShellActionPartLike => {
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
    const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
    const { t } = useI18n();

    const description = typeof part.description === 'string' ? part.description.trim() : '';
    const command = typeof part.command === 'string' ? part.command.trim() : '';
    const agent = typeof part.agent === 'string' ? part.agent.trim() : '';
    const prompt = typeof part.prompt === 'string' ? part.prompt.trim() : '';
    const taskSessionID = typeof part.taskSessionID === 'string' ? part.taskSessionID.trim() : '';
    const model = normalizeSubtaskModel(part.model);

    return (
        <div className="mt-2">
            <div className="flex items-center gap-2 flex-wrap">
                <span className="typography-meta font-semibold text-foreground">{t('chat.messageBody.subtask.title')}</span>
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
                        {expanded ? t('chat.messageBody.subtask.hidePrompt') : t('chat.messageBody.subtask.showPrompt')}
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
                        {t('chat.messageBody.subtask.openSession')}
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
    const { t } = useI18n();

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
                <span className="typography-meta font-semibold text-foreground">{t('chat.messageBody.shellCommand.title')}</span>
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
                            {expanded ? t('chat.messageBody.shellCommand.hideOutput') : t('chat.messageBody.shellCommand.showOutput')}
                        </button>
                        <button
                            type="button"
                            className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                            onClick={() => {
                                void copyOutputToClipboard();
                            }}
                            aria-label={copiedOutput ? t('chat.messageBody.shellCommand.copied') : t('chat.messageBody.shellCommand.copyOutput')}
                            title={copiedOutput ? t('chat.messageBody.shellCommand.copied') : t('chat.messageBody.shellCommand.copyOutput')}
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



interface MessageBodyProps {
    sessionId?: string;
    messageId: string;
    parts: RenderablePart[];
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
    onCopyMessage?: () => void | boolean | Promise<void | boolean>;
    copiedMessage?: boolean;
    onAuxiliaryContentComplete?: () => void;
    showReasoningTraces?: boolean;
    agentMention?: AgentMentionInfo;
    turnGroupingContext?: TurnGroupingContext;
    onRevert?: () => void;
    onFork?: () => void;
    errorMessage?: string;
    userActionsMode?: 'inline' | 'external-content' | 'external-actions';
    stickyUserHeaderEnabled?: boolean;
}

const TOOL_REVEAL_CACHE_MAX = 200;
const revealedToolIdsByMessage = new Map<string, Set<string>>();

const readRevealedToolIds = (messageId: string): Set<string> => {
    const cached = revealedToolIdsByMessage.get(messageId);
    return cached ? new Set(cached) : new Set<string>();
};

const writeRevealedToolIds = (messageId: string, value: Set<string>): void => {
    if (revealedToolIdsByMessage.size >= TOOL_REVEAL_CACHE_MAX && !revealedToolIdsByMessage.has(messageId)) {
        const oldest = revealedToolIdsByMessage.keys().next().value;
        if (oldest) {
            revealedToolIdsByMessage.delete(oldest);
        }
    }
    revealedToolIdsByMessage.set(messageId, new Set(value));
};

const UserMessageBody = React.memo(({ messageId, parts, isMobile, hasTouchInput, hasTextContent, onCopyMessage, copiedMessage, onShowPopup, agentMention, onRevert, onFork, userActionsMode = 'inline', stickyUserHeaderEnabled = true }: {
    messageId: string;
    parts: RenderablePart[];
    isMobile: boolean;
    hasTouchInput?: boolean;
    hasTextContent?: boolean;
    onCopyMessage?: () => void;
    copiedMessage?: boolean;
    onShowPopup: (content: ToolPopupContent) => void;
    agentMention?: AgentMentionInfo;
    onRevert?: () => void;
    onFork?: () => void;
    userActionsMode?: 'inline' | 'external-content' | 'external-actions';
    stickyUserHeaderEnabled?: boolean;
}) => {
    const { t } = useI18n();
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
    const showUserContent = userActionsMode !== 'external-actions';
    const showUserActions = userActionsMode !== 'external-content';
    const useStickyScrollableUserContent = stickyUserHeaderEnabled && userActionsMode === 'inline';

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

    const actionsBlock = ((canCopyMessage && hasCopyableText) || onRevert || onFork) && showUserActions ? (
        <div className={cn(
            'group/user-actions',
            isMobile
                ? userActionsMode === 'inline'
                    ? 'flex items-center justify-end pt-2 pb-3'
                    : stickyUserHeaderEnabled
                        ? 'flex h-9 items-start justify-end pt-0'
                        : 'flex h-11 items-start justify-end pt-0'
                : userActionsMode === 'inline'
                    ? 'absolute top-full left-0 right-0 z-10 pt-5'
                    : 'flex h-8 items-start justify-end pt-2'
        )}>
            <div
                className={cn(
                    'flex items-center justify-end gap-1',
                    isMobile
                        ? userActionsMode === 'inline'
                            ? 'translate-x-5'
                            : 'translate-x-0'
                        : userActionsMode === 'inline'
                            ? 'translate-x-5'
                            : 'translate-x-0',
                    isMobile
                        ? 'pointer-events-auto opacity-100'
                        : 'pointer-events-none opacity-0 transition-opacity duration-150 group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-hover/user-actions:pointer-events-auto group-hover/user-actions:opacity-100 group-hover/user-shell:pointer-events-auto group-hover/user-shell:opacity-100'
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
                                aria-label={t('chat.messageBody.actions.revertAria')}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onRevert();
                                }}
                            >
                                <RiArrowGoBackLine className="h-3 w-3" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.revert')}</TooltipContent>
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
                                aria-label={t('chat.messageBody.actions.forkAria')}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onFork();
                                }}
                            >
                                <RiGitBranchLine className="h-3 w-3" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.fork')}</TooltipContent>
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
                                aria-label={t('chat.messageBody.actions.copyMessageAria')}
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
                        <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.copyMessage')}</TooltipContent>
                    </Tooltip>
                )}
            </div>
        </div>
    ) : null;

    if (!showUserContent) {
        return <>{actionsBlock}</>;
    }

    return (
        <div
            className="relative w-full group/message"
            style={CONTAIN_LAYOUT_STYLE}
            onTouchStart={isTouchContext && canCopyMessage && hasCopyableText ? revealCopyHint : undefined}
        >
            <div
                className={cn(
                    'leading-relaxed text-foreground/90 text-base overflow-x-hidden',
                    useStickyScrollableUserContent
                        ? 'overflow-y-auto overscroll-contain scrollbar-none'
                        : 'overflow-y-hidden'
                )}
                style={useStickyScrollableUserContent ? { maxHeight: 'calc(var(--chat-scroll-height, 100dvh) * 0.4)' } : undefined}
            >
                {userContentParts.map((part, index) => {
                    if (isSubtaskPart(part)) {
                        return (
                            <React.Fragment key={part.id ?? `user-subtask-${index}`}>
                                <UserSubtaskPart part={part} />
                            </React.Fragment>
                        );
                    }

                    if (isShellActionPart(part)) {
                        return (
                            <React.Fragment key={part.id ?? `user-shell-${index}`}>
                                <UserShellActionPart part={part} />
                            </React.Fragment>
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
                        <React.Fragment key={part.id ?? `user-text-${index}`}>
                            <UserTextPart
                                part={part}
                                messageId={messageId}
                                isMobile={isMobile}
                                agentMention={mentionForPart}
                            />
                        </React.Fragment>
                    );
                })}
            </div>
            <MessageFilesDisplay files={parts} onShowPopup={onShowPopup} compact />
            {actionsBlock}
        </div>
    );
});

interface AssistantMessageActionButtonsProps {
    hasCopyableText: boolean;
    isTouchContext: boolean;
    onCopyMessage?: () => void | boolean | Promise<void | boolean>;
    onShareImage: (sourceElement?: HTMLElement | null) => Promise<void>;
    ttsText: string;
}

const AssistantMessageActionButtons = React.memo(({
    hasCopyableText,
    isTouchContext,
    onCopyMessage,
    onShareImage,
    ttsText,
}: AssistantMessageActionButtonsProps) => {
    const { t } = useI18n();
    const { isPlaying: isTTSPlaying, play: playTTS, stop: stopTTS } = useMessageTTS();
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    const voiceProvider = useConfigStore((state) => state.voiceProvider);
    const [copyHintVisible, setCopyHintVisible] = React.useState(false);
    const [isMessageCopied, setIsMessageCopied] = React.useState(false);
    const [isSharing, setIsSharing] = React.useState(false);
    const copyHintTimeoutRef = React.useRef<number | null>(null);
    const copiedResetTimeoutRef = React.useRef<number | null>(null);
    const canCopyMessage = Boolean(onCopyMessage);

    const clearCopyHintTimeout = React.useCallback(() => {
        if (copyHintTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(copyHintTimeoutRef.current);
            copyHintTimeoutRef.current = null;
        }
    }, []);

    const clearCopiedResetTimeout = React.useCallback(() => {
        if (copiedResetTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(copiedResetTimeoutRef.current);
            copiedResetTimeoutRef.current = null;
        }
    }, []);

    React.useEffect(() => {
        return () => {
            clearCopyHintTimeout();
            clearCopiedResetTimeout();
        };
    }, [clearCopiedResetTimeout, clearCopyHintTimeout]);

    React.useEffect(() => {
        if (!hasCopyableText || !canCopyMessage) {
            setCopyHintVisible(false);
            setIsMessageCopied(false);
            clearCopyHintTimeout();
            clearCopiedResetTimeout();
        }
    }, [canCopyMessage, clearCopiedResetTimeout, clearCopyHintTimeout, hasCopyableText]);

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

    const handleCopyButtonClick = React.useCallback(
        async (event: React.MouseEvent<HTMLButtonElement>) => {
            if (!onCopyMessage || !hasCopyableText) {
                return;
            }

            event.stopPropagation();
            event.preventDefault();

            const copied = await onCopyMessage();
            if (copied === false) {
                return;
            }

            clearCopiedResetTimeout();
            setIsMessageCopied(true);
            if (typeof window !== 'undefined') {
                copiedResetTimeoutRef.current = window.setTimeout(() => {
                    setIsMessageCopied(false);
                    copiedResetTimeoutRef.current = null;
                }, 2000);
            }

            if (isTouchContext) {
                revealCopyHint();
            }
        },
        [clearCopiedResetTimeout, hasCopyableText, isTouchContext, onCopyMessage, revealCopyHint]
    );

    const handleShareImageClick = React.useCallback(
        async (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            event.preventDefault();

            if (isSharing || !hasCopyableText) {
                return;
            }

            setIsSharing(true);
            try {
            const root = event.currentTarget.closest('[data-message-text-export-root]');
            const sourceElement = root?.querySelector<HTMLElement>('[data-message-text-export-source]') ?? null;
            await onShareImage(sourceElement);
            } finally {
                setIsSharing(false);
            }
        },
        [hasCopyableText, isSharing, onShareImage]
    );

    const readAloudTooltip = React.useMemo(() => {
        if (isTTSPlaying) {
            return t('chat.messageBody.tts.stopSpeaking');
        }
        const providerLabel = voiceProvider === 'browser'
            ? 'Browser'
            : voiceProvider === 'openai'
                ? 'OpenAI'
                : voiceProvider === 'openai-compatible'
                    ? 'Custom'
                    : 'Say';
        return t('chat.messageBody.tts.readAloudWithProvider', { provider: providerLabel });
    }, [isTTSPlaying, t, voiceProvider]);

    const handleTTSClick = React.useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            event.preventDefault();

            if (isTTSPlaying) {
                stopTTS();
                return;
            }

            if (ttsText.trim()) {
                void playTTS(ttsText);
            }
        },
        [isTTSPlaying, playTTS, stopTTS, ttsText]
    );

    return (
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
                            aria-label={t('chat.messageBody.actions.copyMessageAria')}
                            aria-hidden={!hasCopyableText}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                void handleCopyButtonClick(event);
                            }}
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
                    <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.copyAnswer')}</TooltipContent>
                </Tooltip>
            )}
            <Tooltip delayDuration={1000}>
                <TooltipTrigger asChild>
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        disabled={isSharing || !hasCopyableText}
                        className={cn(
                            'h-8 w-8 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50',
                            (!hasCopyableText || isSharing) && 'opacity-50'
                        )}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            void handleShareImageClick(event);
                        }}
                    >
                        {isSharing ? (
                            <RiLoader4Line className="h-4 w-4 animate-spin" />
                        ) : (
                            <RiImageDownloadLine className="h-4 w-4" />
                        )}
                    </Button>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>{isSharing ? t('chat.messageBody.actions.savingImage') : t('chat.messageBody.actions.saveAsImage')}</TooltipContent>
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
                            aria-label={isTTSPlaying ? t('chat.messageBody.tts.stopSpeaking') : t('chat.messageBody.tts.readAloud')}
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
});

const AssistantMessageBody = React.memo(({
    sessionId,
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
    onAuxiliaryContentComplete,
    showReasoningTraces = false,
    turnGroupingContext,
    errorMessage,
}: Omit<MessageBodyProps, 'isUser'>) => {
    const { t } = useI18n();
    const streamPhase = _streamPhase;
    void _allowAnimation;
    const messageContentRef = React.useRef<HTMLDivElement>(null);
    const messageTextContentRef = React.useRef<HTMLDivElement>(null);
    const toolRevealReadyRef = React.useRef(false);

    React.useEffect(() => {
        toolRevealReadyRef.current = true;
    }, []);

    const isTouchContext = Boolean(hasTouchInput ?? isMobile);
    const awaitingMessageCompletion = !isMessageCompleted;
    const animateActivityRows = awaitingMessageCompletion || Boolean(turnGroupingContext?.isWorking);

    const visibleParts = React.useMemo(() => {
        return parts
            .filter((part) => !isEmptyTextPart(part))
            .filter((part) => {
                const rawPart = part as Record<string, unknown>;
                return rawPart.type !== 'compaction';
            });
    }, [parts]);

    const toolParts = React.useMemo(() => {
        return visibleParts.filter((part): part is RenderableToolPart => part.type === 'tool');
    }, [visibleParts]);

    const toolRevealStateRef = React.useRef<{
        messageId: string;
        hasCommitted: boolean;
        persistedToolIds: Set<string>;
        animatedToolIds: Set<string>;
    }>({
        messageId,
        hasCommitted: false,
        persistedToolIds: readRevealedToolIds(messageId),
        animatedToolIds: new Set<string>(),
    });

    if (toolRevealStateRef.current.messageId !== messageId) {
        toolRevealStateRef.current = {
            messageId,
            hasCommitted: false,
            persistedToolIds: readRevealedToolIds(messageId),
            animatedToolIds: new Set<string>(),
        };
    }

    const currentToolIds = React.useMemo(() => {
        const ids = new Set<string>();

        for (const toolPart of toolParts) {
            ids.add(toolPart.id);
        }

        const activitySegments = turnGroupingContext?.activityGroupSegments;
        if (Array.isArray(activitySegments)) {
            for (const segment of activitySegments) {
                if (segment.anchorMessageId !== messageId) {
                    continue;
                }
                for (const activity of segment.parts) {
                    if (activity.kind !== 'tool') {
                        continue;
                    }
                    const toolId = (activity.part as { id?: unknown }).id;
                    if (typeof toolId === 'string' && toolId.length > 0) {
                        ids.add(toolId);
                    }
                }
            }
        }

        return Array.from(ids);
    }, [messageId, toolParts, turnGroupingContext?.activityGroupSegments]);
    const shouldAnimateNewToolMount = Boolean(turnGroupingContext?.isWorking && toolRevealReadyRef.current);
    const persistedToolIds = toolRevealStateRef.current.persistedToolIds;
    const animatedToolIds = toolRevealStateRef.current.animatedToolIds;

    if (shouldAnimateNewToolMount && toolRevealStateRef.current.hasCommitted) {
        for (const toolId of currentToolIds) {
            if (!persistedToolIds.has(toolId)) {
                animatedToolIds.add(toolId);
            }
        }
    }

    const animatedToolIdsKey = Array.from(animatedToolIds).join('\u0000');
    const animatedToolIdsLookup = React.useMemo(
        () => new Set(animatedToolIdsKey ? animatedToolIdsKey.split('\u0000') : []),
        [animatedToolIdsKey]
    );

    React.useEffect(() => {
        const nextPersistedToolIds = new Set(toolRevealStateRef.current.persistedToolIds);
        for (const toolId of currentToolIds) {
            nextPersistedToolIds.add(toolId);
        }
        toolRevealStateRef.current.persistedToolIds = nextPersistedToolIds;
        toolRevealStateRef.current.hasCommitted = true;
        writeRevealedToolIds(messageId, nextPersistedToolIds);
    }, [currentToolIds, messageId]);

    const assistantTextParts = React.useMemo(() => {
        return visibleParts.filter((part) => part.type === 'text');
    }, [visibleParts]);
    const assistantPlanText = React.useMemo(() => flattenAssistantTextParts(assistantTextParts), [assistantTextParts]);
    const suggestedPlanTitle = React.useMemo(() => suggestPlanTitleFromText(assistantPlanText), [assistantPlanText]);

    const createSessionFromAssistantMessage = useSessionUIStore((state) => state.createSessionFromAssistantMessage);
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const openMultiRunLauncherWithPrompt = useUIStore((state) => state.openMultiRunLauncherWithPrompt);
    const projects = useProjectsStore((state) => state.projects);
    const effectiveDirectory = useEffectiveDirectory();
    const sessions = useSessions();
    const [isPlanDialogOpen, setIsPlanDialogOpen] = React.useState(false);
    const [isSavingPlan, setIsSavingPlan] = React.useState(false);
    const chatRenderMode = useUIStore((state) => state.chatRenderMode);
    const showSplitAssistantMessageActions = useUIStore((state) => state.showSplitAssistantMessageActions);
    const isSortedRenderMode = chatRenderMode === 'sorted';
    const collapsedPreviewCount = 7;
    const isLastAssistantInTurn = turnGroupingContext?.isLastAssistantInTurn ?? false;
    const hasStopFinish = messageFinish === 'stop';

    const currentSession = React.useMemo(() => {
        if (!currentSessionId) {
            return null;
        }
        return sessions.find((session) => session.id === currentSessionId) ?? null;
    }, [currentSessionId, sessions]);

    const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
    const currentProjectRef = React.useMemo(() => {
        const directory = effectiveDirectory
            ?? (typeof currentSession?.directory === 'string' ? currentSession.directory : '');
        const resolved = resolveProjectForSessionDirectory(projects, availableWorktreesByProject, directory);
        return resolved ? { id: resolved.id, path: resolved.path } : null;
    }, [availableWorktreesByProject, currentSession?.directory, effectiveDirectory, projects]);


    const hasTools = toolParts.length > 0;

    const hasPendingTools = React.useMemo(() => {
        return toolParts.some((toolPart) => {
            const state = (toolPart as Record<string, unknown>).state as Record<string, unknown> | undefined ?? {};
            const status = state?.status;
            return status === 'pending' || status === 'running' || status === 'started';
        });
    }, [toolParts]);

    const isActiveTool = React.useCallback((toolPart: RenderableToolPart): boolean => {
        const state = (toolPart as Record<string, unknown>).state as Record<string, unknown> | undefined ?? {};
        const status = state?.status;
        return status === 'pending' || status === 'running' || status === 'started';
    }, []);

    const isToolFinalized = React.useCallback((toolPart: RenderableToolPart) => {
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

    const shouldShowTool = React.useCallback((toolPart: RenderableToolPart): boolean => {
        return isActiveTool(toolPart) || isToolFinalized(toolPart);
    }, [isActiveTool, isToolFinalized]);

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

            if (!assistantPlanText.trim()) {
                return;
            }

            const prefilledPrompt = `${MULTIRUN_EXECUTION_FORK_PROMPT_META_TEXT}\n\n${assistantPlanText}`;
            openMultiRunLauncherWithPrompt(prefilledPrompt);
        },
        [assistantPlanText, openMultiRunLauncherWithPrompt]
    );

    const handleSaveAsPlanClick = React.useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            event.preventDefault();
            if (!assistantPlanText.trim()) {
                return;
            }
            setIsPlanDialogOpen(true);
        },
        [assistantPlanText]
    );

    const handleConfirmSaveAsPlan = React.useCallback(
        async (title: string) => {
            if (!assistantPlanText.trim()) {
                return;
            }
            if (!currentProjectRef) {
                toast.error(t('chat.messageBody.toast.noProject'));
                return;
            }

            setIsSavingPlan(true);
            try {
                const created = await createProjectPlanFile(currentProjectRef, {
                    title,
                    body: assistantPlanText,
                });
                if (!created) {
                    toast.error(t('chat.messageBody.toast.savePlanFailed'));
                    return;
                }
                window.dispatchEvent(new CustomEvent('openchamber:project-plan-saved', {
                    detail: { projectId: currentProjectRef.id },
                }));
                setIsPlanDialogOpen(false);
                toast.success(t('chat.messageBody.toast.planSaved'));
            } finally {
                setIsSavingPlan(false);
            }
        },
        [assistantPlanText, currentProjectRef, t]
    );

    const shareMessageAsImage = React.useCallback(
        async (requestedSourceElement?: HTMLElement | null) => {
            const sourceElement = requestedSourceElement ?? messageTextContentRef.current ?? messageContentRef.current;
            if (!sourceElement) return;

            let wrapper: HTMLDivElement | null = null;
            try {
                const originalElement = sourceElement;
                const computedStyle = window.getComputedStyle(originalElement);
                const rootStyle = window.getComputedStyle(document.documentElement);
                const resolvedBackgroundColor =
                    rootStyle.getPropertyValue('--surface-background').trim() ||
                    computedStyle.backgroundColor ||
                    window.getComputedStyle(document.body).backgroundColor;
                const paddingSize = 24;

                wrapper = document.createElement('div');
                wrapper.style.cssText = `
                    padding: ${paddingSize}px;
                    background-color: ${resolvedBackgroundColor};
                    display: inline-block;
                `;

                const clone = originalElement.cloneNode(true) as HTMLElement;
                clone.style.cssText = `
                    ${computedStyle.cssText}
                    transform: none;
                    contain: none;
                `;

                const actionRows = clone.querySelectorAll<HTMLElement>('[data-message-actions="true"]');
                actionRows.forEach((row) => {
                    row.style.display = 'none';
                });
                const actionGroups = clone.querySelectorAll<HTMLElement>('[data-message-action-group="true"]');
                actionGroups.forEach((group) => {
                    group.style.display = 'none';
                });

                const timestampElements = clone.querySelectorAll<HTMLElement>('[aria-label^="Message time:"]');
                const footerRowsAdjusted = new Set<HTMLElement>();
                timestampElements.forEach((element) => {
                    const label = element.getAttribute('aria-label');
                    const timestamp = label?.replace('Message time:', '').trim();
                    if (!timestamp || element.textContent?.includes(timestamp)) {
                        return;
                    }

                    const timestampText = document.createElement('span');
                    timestampText.style.marginLeft = '4px';
                    timestampText.textContent = timestamp;
                    element.appendChild(timestampText);

                    const metaGroup = element.parentElement;
                    const footerRow = metaGroup?.parentElement as HTMLElement | null;
                    if (!footerRow || footerRowsAdjusted.has(footerRow)) {
                        return;
                    }

                    footerRow.style.justifyContent = 'flex-start';
                    footerRowsAdjusted.add(footerRow);
                });

                wrapper.appendChild(clone);
                document.body.appendChild(wrapper);

                const dataUrl = await toPng(wrapper, {
                    quality: 1,
                    pixelRatio: 2,
                    backgroundColor: resolvedBackgroundColor,
                });

                const fileName = `message-${messageId}.png`;

                if (isVSCodeRuntime()) {
                    const response = await fetch('/api/vscode/save-image', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ fileName, dataUrl }),
                    });

                    if (!response.ok) {
                        throw new Error('Failed to save image in VS Code');
                    }

                    const payload = await response.json() as { saved?: boolean; canceled?: boolean; error?: string };
                    if (payload.saved !== true) {
                        if (payload.canceled) {
                            return;
                        }
                        throw new Error(payload.error || 'Failed to save image in VS Code');
                    }
                } else {
                    const link = document.createElement('a');
                    link.download = fileName;
                    link.href = dataUrl;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                }

                toast.success(t('chat.messageBody.toast.imageSaved'));
            } catch (error) {
                console.error('Failed to generate image:', error);
                toast.error(t('chat.messageBody.toast.generateImageFailed'));
            } finally {
                if (wrapper && wrapper.parentNode) {
                    wrapper.parentNode.removeChild(wrapper);
                }
            }
        },
        [messageId, t]
    );

    const activityPartsForTurn = React.useMemo(() => {
        const all = turnGroupingContext?.activityParts;
        if (!isSortedRenderMode || !all) {
            return [];
        }
        return all;
    }, [isSortedRenderMode, turnGroupingContext?.activityParts]);

    const activityGroupSegmentsForMessage = React.useMemo(() => {
        const all = turnGroupingContext?.activityGroupSegments;
        if (!isSortedRenderMode || !all) {
            return [];
        }
        return all.filter((segment) => segment.anchorMessageId === messageId);
    }, [isSortedRenderMode, messageId, turnGroupingContext?.activityGroupSegments]);

    const hasAnchoredActivitySegments = activityGroupSegmentsForMessage.length > 0;

    const activityByPart = React.useMemo(() => {
        const byRef = new Map<RenderablePart, (typeof activityPartsForTurn)[number]>();
        const byId = new Map<string, (typeof activityPartsForTurn)[number]>();
        activityPartsForTurn.forEach((activity) => {
            byRef.set(activity.part, activity);
            const partId = (activity.part as { id?: unknown }).id;
            if (typeof partId === 'string' && partId.length > 0) {
                byId.set(partId, activity);
            }
        });

        return {
            get: (part: RenderablePart) => {
                const direct = byRef.get(part);
                if (direct) {
                    return direct;
                }
                const partId = (part as { id?: unknown }).id;
                if (typeof partId === 'string' && partId.length > 0) {
                    return byId.get(partId);
                }
                return undefined;
            },
        };
    }, [activityPartsForTurn]);

    const toggleActivityGroup = turnGroupingContext?.toggleGroup;
    const isActivityOwnerMessage = !isSortedRenderMode
        || !turnGroupingContext?.activityOwnerMessageId
        || turnGroupingContext.activityOwnerMessageId === messageId
        || hasAnchoredActivitySegments;

    const shouldRenderActivityGroup = isSortedRenderMode
        && isActivityOwnerMessage
        && hasAnchoredActivitySegments
        && Boolean(toggleActivityGroup);

    const shouldDeferSortedInlineText = isSortedRenderMode && !hasStopFinish;
    const showErrorMessage = Boolean(errorMessage);
    const shouldShowMessageActions = hasCopyableText;
    const shouldShowTurnFooter = isLastAssistantInTurn && hasTextContent && (hasStopFinish || Boolean(errorMessage));
    const shouldRenderActionsInActivity = isSortedRenderMode;
    const shouldShowStandaloneMessageActions = showSplitAssistantMessageActions && shouldShowMessageActions && !shouldShowTurnFooter && !shouldRenderActionsInActivity;

    const messageActionButtons = React.useMemo(() => (
        <AssistantMessageActionButtons
            hasCopyableText={hasCopyableText}
            isTouchContext={isTouchContext}
            onCopyMessage={onCopyMessage}
            onShareImage={shareMessageAsImage}
            ttsText={assistantPlanText}
        />
    ), [assistantPlanText, hasCopyableText, isTouchContext, onCopyMessage, shareMessageAsImage]);

    const renderJustificationActions = React.useCallback((activity: NonNullable<TurnGroupingContext['activityParts']>[number]) => {
        if (!showSplitAssistantMessageActions || !isSortedRenderMode) {
            return null;
        }

        const text = extractTextContent(activity.part).trim();
        if (!text) {
            return null;
        }

        const copyJustificationText = async () => {
            const result = await copyTextToClipboard(text);
            return result.ok;
        };

        return (
            <AssistantMessageActionButtons
                hasCopyableText={true}
                isTouchContext={isTouchContext}
                onCopyMessage={copyJustificationText}
                onShareImage={shareMessageAsImage}
                ttsText={text}
            />
        );
    }, [isSortedRenderMode, isTouchContext, shareMessageAsImage, showSplitAssistantMessageActions]);

    const lastRenderableTextPartIndex = React.useMemo(() => {
        if (!shouldShowStandaloneMessageActions) {
            return -1;
        }

        let lastIndex = -1;
        for (let index = 0; index < visibleParts.length; index += 1) {
            const part = visibleParts[index];
            if (!part || part.type !== 'text') {
                continue;
            }
            if (shouldDeferSortedInlineText) {
                continue;
            }
            const activity = activityByPart.get(part);
            if (activity?.kind === 'justification') {
                continue;
            }
            lastIndex = index;
        }

        return lastIndex;
    }, [activityByPart, shouldDeferSortedInlineText, shouldShowStandaloneMessageActions, visibleParts]);

    const shouldRenderStandaloneActionsAfterContent = shouldShowStandaloneMessageActions && lastRenderableTextPartIndex < 0;


    const renderedParts = React.useMemo(() => {
        const rendered: React.ReactNode[] = [];

        if (shouldRenderActivityGroup && toggleActivityGroup) {
            activityGroupSegmentsForMessage.forEach((segment) => {
                const visibleSegmentParts = showReasoningTraces
                    ? segment.parts
                    : segment.parts.filter((activity) => activity.kind !== 'reasoning');
                if (visibleSegmentParts.length === 0) {
                    return;
                }
                rendered.push(
                    <div key={`progressive-group-${segment.id}`} className="mb-3">
                        <TurnActivity
                            parts={visibleSegmentParts}
                            isExpanded={turnGroupingContext.isGroupExpanded === true}
                            collapsedPreviewCount={collapsedPreviewCount}
                            onToggle={toggleActivityGroup}
                            syntaxTheme={syntaxTheme}
                            isMobile={isMobile}
                            expandedTools={expandedTools}
                            onToggleTool={onToggleTool}
                            onShowPopup={onShowPopup}
                            onContentChange={onContentChange}
                            streamPhase={streamPhase}
                            showHeader={true}
                            animateRows={animateActivityRows}
                            animatedToolIds={animatedToolIdsLookup}
                            diffStats={turnGroupingContext.diffStats}
                            renderJustificationActions={renderJustificationActions}
                        />
                    </div>
                );
            });
        }

        // Flat rendering: iterate parts in natural order.
        // Group consecutive static tools (read, grep, glob, etc.) into compact rows.
        // Expandable tools (bash, edit, task) get individual rows.
        // Text and reasoning render inline at their natural position.
        let i = 0;
        while (i < visibleParts.length) {
            const part = visibleParts[i];

            if (part.type === 'text') {
                const activity = activityByPart.get(part);
                if (shouldDeferSortedInlineText) {
                    i += 1;
                    continue;
                }
                if (activity?.kind === 'justification') {
                    i += 1;
                    continue;
                }
                rendered.push(
                    <div key={`assistant-text-${messageId}-${i}`} ref={messageTextContentRef} data-message-text-export-source="true">
                        <AssistantTextPart
                            part={part}
                            sessionId={sessionId}
                            messageId={messageId}
                            streamPhase={streamPhase}
                            chatRenderMode={chatRenderMode}
                            onContentChange={onContentChange}
                        />
                    </div>
                );
                if (shouldShowStandaloneMessageActions && i === lastRenderableTextPartIndex) {
                    rendered.push(
                        <div key={`message-actions-${messageId}`} className={INLINE_MESSAGE_ACTIONS_CLASS_NAME} data-message-actions="true">
                            <div className="flex items-center gap-1.5" data-message-action-group="true">
                                {messageActionButtons}
                            </div>
                        </div>
                    );
                }
                i++;
                continue;
            }

            if (part.type === 'reasoning') {
                const activity = activityByPart.get(part);
                if (activity?.kind === 'reasoning') {
                    i += 1;
                    continue;
                }
                if (showReasoningTraces) {
                    if (isSortedRenderMode) {
                        rendered.push(
                            <ReasoningPart
                                key={`reasoning-${messageId}-${i}`}
                                part={part}
                                messageId={messageId}
                                onContentChange={onContentChange}
                            />
                        );
                    } else {
                        rendered.push(
                            <AssistantTextPart
                                key={`reasoning-${messageId}-${i}`}
                                part={part}
                                sessionId={sessionId}
                                messageId={messageId}
                                streamPhase={streamPhase}
                                chatRenderMode={chatRenderMode}
                                onContentChange={onContentChange}
                            />
                        );
                    }
                }
                i++;
                continue;
            }

            if (part.type === 'tool') {
                const toolPart = part as RenderableToolPart;
                const toolName = toolPart.tool?.toLowerCase() ?? '';

                if (isSortedRenderMode && !isActivityOwnerMessage) {
                    i += 1;
                    continue;
                }

                const activity = activityByPart.get(part);
                if (activity?.kind === 'tool' && (shouldRenderActivityGroup || !isStandaloneTool(toolName))) {
                    i += 1;
                    continue;
                }

                if (!shouldShowTool(toolPart)) {
                    i++;
                    continue;
                }

                // Expandable tools: bash, edit, write, task, question — individual rows
                if (isExpandableTool(toolName)) {
                    rendered.push(
                        <FadeInOnReveal key={`tool-${toolPart.id}`}>
                            <ToolRevealOnMount animate={animatedToolIdsLookup.has(toolPart.id)} wipe>
                                <ToolPart
                                    part={toolPart}
                                    isExpanded={expandedTools.has(toolPart.id)}
                                    onToggle={onToggleTool}
                                    syntaxTheme={syntaxTheme}
                                    isMobile={isMobile}
                                    onContentChange={onContentChange}
                                    onShowPopup={onShowPopup}
                                    animateTailText={animatedToolIdsLookup.has(toolPart.id)}
                                />
                            </ToolRevealOnMount>
                        </FadeInOnReveal>
                    );
                    i++;
                    continue;
                }

                // Static tools: one row per tool call (no grouping)
                rendered.push(
                    <FadeInOnReveal key={`static-tools-${toolPart.id}`}>
                        <ToolRevealOnMount animate={animatedToolIdsLookup.has(toolPart.id)} wipe>
                            <StaticToolRow
                                toolName={toolName}
                                activities={[
                                    {
                                        id: toolPart.id,
                                        turnId: '',
                                        messageId,
                                        partIndex: 0,
                                        part: toolPart,
                                        kind: 'tool' as const,
                                    },
                                ]}
                                animateTailText={animatedToolIdsLookup.has(toolPart.id)}
                            />
                        </ToolRevealOnMount>
                    </FadeInOnReveal>
                );
                i++;
                continue;
            }

            // Unknown part type — skip
            i++;
        }

        return rendered;
    }, [
        activityByPart,
        activityGroupSegmentsForMessage,
        animatedToolIdsLookup,
        animateActivityRows,
        chatRenderMode,
        collapsedPreviewCount,
        expandedTools,
        isMobile,
        isActivityOwnerMessage,
        isSortedRenderMode,
        lastRenderableTextPartIndex,
        messageId,
        messageActionButtons,
        renderJustificationActions,
        sessionId,
        onContentChange,
        onShowPopup,
        onToggleTool,
        shouldRenderActivityGroup,
        shouldShowStandaloneMessageActions,
        shouldShowTool,
        streamPhase,
        showReasoningTraces,
        shouldDeferSortedInlineText,
        syntaxTheme,
        toggleActivityGroup,
        turnGroupingContext,
        visibleParts,
    ]);

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

    const footerTimestampClassName = 'text-sm text-muted-foreground/60 tabular-nums flex items-center gap-1';

    const finalTurnActionButtons = (
        <>
            {!isVSCodeRuntime() ? (
                <Tooltip delayDuration={1000}>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            disabled={!hasCopyableText || !currentProjectRef}
                            className={cn(
                                'h-8 w-8 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50',
                                (!hasCopyableText || !currentProjectRef) && 'opacity-50'
                            )}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={handleSaveAsPlanClick}
                        >
                            <RiBookletLine className="h-4 w-4" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.saveAsPlan')}</TooltipContent>
                </Tooltip>
            ) : null}
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
                <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.startNewSession')}</TooltipContent>
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
                <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.startNewMultiRun')}</TooltipContent>
            </Tooltip>
        </>
    );
 
      return (

         <div
              ref={messageContentRef}
              data-message-text-export-root="true"
              className={cn(
                 'relative w-full group/message'
             )}
              style={CONTAIN_LAYOUT_STYLE}
          >
              <TextSelectionMenu containerRef={messageContentRef} />
             <SaveProjectPlanDialog
                 open={isPlanDialogOpen}
                 onOpenChange={setIsPlanDialogOpen}
                 initialTitle={suggestedPlanTitle}
                 sourceText={assistantPlanText}
                 saving={isSavingPlan}
                 onSave={handleConfirmSaveAsPlan}
             />
              <div>
                 <div
                     className="message-content-text leading-relaxed overflow-hidden text-foreground/90 [&_p:last-child]:mb-0 [&_ul:last-child]:mb-0 [&_ol:last-child]:mb-0"
                 >
                    {renderedParts}
                    {showErrorMessage && (
                        <FadeInOnReveal key="assistant-error">
                            <div className="group/assistant-text relative mt-3 p-3 rounded-lg border bg-[var(--status-error-background)] border-[var(--status-error-border)] break-all max-w-full">
                                <div className="flex items-start gap-2">
                                    <RiErrorWarningLine className="h-4 w-4 shrink-0 mt-0.5 text-[var(--status-error)]" />
                                    <div className="break-all min-w-0 flex-1">
                                        <SimpleMarkdownRenderer content={errorMessage ?? ''} onShowPopup={onShowPopup} />
                                    </div>
                                </div>
                            </div>
                        </FadeInOnReveal>
                    )}
                </div>
                <MessageFilesDisplay files={parts} onShowPopup={onShowPopup} />
                {shouldRenderStandaloneActionsAfterContent && (
                    <div className={INLINE_MESSAGE_ACTIONS_CLASS_NAME} data-message-actions="true">
                        <div className="flex items-center gap-1.5" data-message-action-group="true">
                            {messageActionButtons}
                        </div>
                    </div>
                )}
                {shouldShowTurnFooter && (
                    <div
                        className="mt-2 mb-1 flex items-center justify-start gap-1.5"
                        style={MESSAGE_FOOTER_CONTAINER_STYLE}
                    >
                        <div className="flex items-center gap-1.5" data-message-action-group="true">
                            {messageActionButtons}
                            {finalTurnActionButtons}
                        </div>
                        <div className="flex items-center gap-1.5">
                            {turnDurationText ? (
                                <Tooltip delayDuration={300}>
                                    <TooltipTrigger asChild>
                                        <span className="text-sm text-muted-foreground/60 tabular-nums flex items-center gap-1">
                                            <RiHourglassLine className="h-3.5 w-3.5" />
                                            <span className="message-footer__label">{turnDurationText}</span>
                                        </span>
                                    </TooltipTrigger>
                                    <TooltipContent>{turnDurationText}</TooltipContent>
                                </Tooltip>
                            ) : null}
                            {footerTimestamp ? (
                                <Tooltip delayDuration={300}>
                                    <TooltipTrigger asChild>
                                        <span
                                            className={footerTimestampClassName}
                                            aria-label={`Message time: ${footerTimestamp}`}
                                        >
                                            <RiTimeLine className="h-3.5 w-3.5" />
                                            <span className="message-footer__label">{footerTimestamp}</span>
                                        </span>
                                    </TooltipTrigger>
                                    <TooltipContent>{footerTimestamp}</TooltipContent>
                                </Tooltip>
                            ) : null}
                            {isLastAssistantInTurn && hasStopFinish ? (
                                <TurnChangedFilesDropdown activityParts={turnGroupingContext?.activityParts} />
                            ) : null}
                        </div>
                    </div>
                )}

            </div>
        </div>
    );
});

const MessageBody = React.memo(({ isUser, ...props }: MessageBodyProps) => {

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
                userActionsMode={props.userActionsMode}
                stickyUserHeaderEnabled={props.stickyUserHeaderEnabled}
            />
        );
    }

    return <AssistantMessageBody {...props} />;
});

export default MessageBody;

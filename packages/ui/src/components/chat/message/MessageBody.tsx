import React from 'react';
import type { FilePart, Part } from '@/lib/opencode/model';

import { sessionMentionChipsOf } from './parts/sessionMentionChips';
import UserTextPart from './parts/UserTextPart';
import ToolPart from './parts/ToolPart';
import AssistantTextPart from './parts/AssistantTextPart';
import ReasoningPart from './parts/ReasoningPart';
import { MessageFilesDisplay } from '../FileAttachment';
import type { ToolPart as ToolPartType } from '@/lib/opencode/model';
import type { StreamPhase, ToolPopupContent, AgentMentionInfo } from './types';
import type { TurnChangedFile, TurnGroupingContext } from '../lib/turns/types';
import { cn } from '@/lib/utils';
import { isEmptyTextPart, extractTextContent } from './partUtils';
import { isInvisibleText } from '@/lib/invisibleText';
import { FadeInOnReveal } from './FadeInOnReveal';
import { SessionNoticeBlock } from './SessionNoticeBlock';
import { readSessionNoticePart } from '@/lib/opencode/session-notices';
import type { PromptOrigin } from '@/lib/opencode/prompt-origin';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { useSessionSelector } from '@/sync/sync-context';
import { Button } from '@/components/ui/button';
import { ErrorResponseDetails } from '@/components/chat/ErrorResponseDetails';
import { SaveProjectPlanDialog } from '@/components/session/SaveProjectPlanDialog';
import { ForkSessionDialog, type ForkSessionExecution } from '@/components/session/ForkSessionDialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';

import { SimpleMarkdownRenderer } from '../MarkdownRenderer';
import { LongErrorText } from '../LongErrorText';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useChatSessionSelection } from '../chatColumnSession';
import { useUIStore } from '@/stores/useUIStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import type { Session } from '@/lib/opencode/model';
import { getMultiRunIdentity } from '@/lib/multirun/identity';
import { openParallelComposer } from '@/lib/multirun/openParallelComposer';
import { AskOtherModelsDialog } from '@/components/multirun/AskOtherModelsDialog';
import { assistantTextSegments, flattenAssistantTextParts, suggestPlanTitleFromText } from '@/lib/messages/messageText';
import { MULTIRUN_EXECUTION_FORK_PROMPT_META_TEXT } from '@/lib/messages/executionMeta';
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useFactsFit } from './useFactsFit';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { TextSelectionMenu } from './TextSelectionMenu';
import { useChatSurfaceMode } from '@/components/chat/useChatSurfaceMode';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { toast } from '@/components/ui';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from "@/components/icon/Icon";
import { formatTimestampForDisplay } from './timeFormat';
import { ToolRevealOnMount } from './parts/ToolRevealOnMount';
import { StaticToolRow } from './parts/ProgressiveGroup';
import { isExpandableTool } from './parts/toolRenderUtils';
import { ShownToolCard } from './parts/ShownToolCard';
import { isShownInPlace } from '@/lib/opencode/tools';
import { LiveActivityCollapse } from '../components/LiveActivityCollapse';
import { ActivityRowSkipContext, isActivityRowPart, isToolRowShown } from '../lib/turns/activityRows';
import { LiveFinalActivityContext, LiveTurnHoistedPagesContext } from '../components/liveActivityContext';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import {
    type ReviewTransferDirection,
    sendImplementationResponseToReviewer,
    sendReviewFeedbackToOriginal,
} from '@/lib/reviewFlow';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { useAgentColors } from '@/hooks/useAgentColors';
import { isCapacitorMobileApp } from '@/apps/mobileNativeChrome';
import { shareFileFromNativeApp } from '@/lib/nativeFileShare';
import { WorktreeRequiresGitRepositoryError } from '@/lib/worktrees/worktreeCreate';
import { buildTurnImageExportSource, cloneMessageImageExportSource } from './imageExport';
import { hasTextSelectionInside } from '@/lib/textSelection';


const CONTAIN_LAYOUT_STYLE = { contain: 'layout' as const, transform: 'translateZ(0)' };
const MESSAGE_FOOTER_CONTAINER_STYLE = { containerType: 'inline-size' as const, containerName: 'message-footer' };
const INLINE_MESSAGE_ACTIONS_CLASS_NAME = 'mt-2 mb-1 flex items-center justify-start gap-1.5';

const getDisplayFileName = (file: string): string => {
    const normalized = file.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    return segments.at(-1) ?? file;
};

const CHANGED_FILE_CHIP_CLASS_NAME = 'inline-flex max-w-full items-center gap-1.5 rounded-lg oc-tile px-2 py-1 text-xs text-muted-foreground';
const CHANGED_FILE_CHIP_HOVER_CLASS_NAME = 'oc-tile-hover';
const CHANGED_FILE_CHIP_STYLE = { lineHeight: 'round(1.35em, 1px)' };
const CHANGED_FILE_CHIP_BUTTON_CLASS_NAME = 'inline-flex h-8 max-w-full cursor-pointer items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]';

const TurnChangedFileChipContent = React.memo(({ file, interactive = false }: { file: TurnChangedFile; interactive?: boolean }) => (
    <span
        className={cn(CHANGED_FILE_CHIP_CLASS_NAME, interactive && CHANGED_FILE_CHIP_HOVER_CLASS_NAME)}
        style={CHANGED_FILE_CHIP_STYLE}
    >
        <FileTypeIcon filePath={file.file} className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="max-w-52 truncate text-foreground/80" title={file.file}>{getDisplayFileName(file.file)}</span>
        {file.additions !== undefined && file.deletions !== undefined ? (
            <span className="flex-shrink-0 inline-flex items-center gap-0 typography-meta" style={{ fontSize: '0.8rem', lineHeight: '1' }}>
                <span style={{ color: 'var(--status-success)' }}>+{file.additions}</span>
                <span className="text-muted-foreground/70">/</span>
                <span style={{ color: 'var(--status-error)' }}>-{file.deletions}</span>
            </span>
        ) : null}
    </span>
));

const TurnChangedFilePillButton = React.memo(({
    file,
    onOpen,
}: {
    file: TurnChangedFile;
    onOpen: (file: string) => void;
}) => {
    const { t } = useI18n();
    return (
        <button
            type="button"
            className={CHANGED_FILE_CHIP_BUTTON_CLASS_NAME}
            aria-label={t('chat.changedFiles.actions.openFileTitle', { path: file.file })}
            title={file.file}
            onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                // Keep a filename selection selectable instead of opening the file.
                if (hasTextSelectionInside(event.currentTarget)) return;
                onOpen(file.file);
            }}
        >
            <TurnChangedFileChipContent file={file} interactive />
        </button>
    );
});

const StaticTurnChangedFilePills = React.memo(({ files }: { files: TurnChangedFile[] }) => (
    <>
        {files.map((file) => (
            <span key={file.file} className="inline-flex h-8 max-w-full items-center" title={file.file}>
                <TurnChangedFileChipContent file={file} />
            </span>
        ))}
    </>
));

const InteractiveTurnChangedFilePills = React.memo(({ files }: { files: TurnChangedFile[] }) => {
    const effectiveDirectory = useEffectiveDirectory();
    const isMobile = useUIStore((state) => state.isMobile);
    const navigateToDiff = useUIStore((state) => state.navigateToDiff);
    const openContextDiff = useUIStore((state) => state.openContextDiff);

    const openLastTurnDiff = React.useCallback((file: string) => {
        if (!isMobile && effectiveDirectory) {
            openContextDiff(effectiveDirectory, file, false, 'turn');
            return;
        }

        navigateToDiff(file, false, 'turn');
    }, [effectiveDirectory, isMobile, navigateToDiff, openContextDiff]);

    return (
        <>
            {files.map((file) => file.inTurnDiff === false ? (
                // The turn diff has no entry to open for this path.
                <span key={file.file} className="inline-flex h-8 max-w-full items-center" title={file.file}>
                    <TurnChangedFileChipContent file={file} />
                </span>
            ) : (
                <TurnChangedFilePillButton key={file.file} file={file} onOpen={openLastTurnDiff} />
            ))}
        </>
    );
});

const CHANGED_FILE_CHIP_LIMIT = 4;

/**
 * Past the limit one more chip reveals the rest in the row; while they show,
 * the same chip at the row's end hides them again.
 */
const TurnChangedFilePills = React.memo(({ files, isInteractive }: { files?: TurnChangedFile[]; isInteractive: boolean }) => {
    const { t } = useI18n();
    const [expanded, setExpanded] = React.useState(false);
    const toggleRef = React.useRef<HTMLButtonElement>(null);
    React.useLayoutEffect(() => {
        const toggle = toggleRef.current;
        if (!expanded && toggle && toggle.ownerDocument.activeElement === toggle) {
            // Keep the focused control visible after a long list shrinks.
            toggle.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }, [expanded]);
    if (!files || files.length === 0) return null;

    const Pills = isInteractive ? InteractiveTurnChangedFilePills : StaticTurnChangedFilePills;
    const hiddenCount = files.length - CHANGED_FILE_CHIP_LIMIT;
    if (hiddenCount <= 0) return <Pills files={files} />;

    const label = expanded
        ? t('chat.changedFiles.actions.showFewer')
        : t('chat.changedFiles.actions.otherFiles', { count: hiddenCount });
    return (
        <>
            <Pills files={expanded ? files : files.slice(0, CHANGED_FILE_CHIP_LIMIT)} />
            <button
                ref={toggleRef}
                type="button"
                className={CHANGED_FILE_CHIP_BUTTON_CLASS_NAME}
                aria-expanded={expanded}
                aria-label={label}
                title={label}
                onClick={(event) => {
                    event.stopPropagation();
                    setExpanded((value) => !value);
                }}
            >
                <span className={cn(CHANGED_FILE_CHIP_CLASS_NAME, CHANGED_FILE_CHIP_HOVER_CLASS_NAME)} style={CHANGED_FILE_CHIP_STYLE}>
                    {expanded ? (
                        // A text line tall, so the icon-only chip matches the file chips.
                        <span className="inline-flex h-[round(1.35em,1px)] items-center">
                            <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
                        </span>
                    ) : `+${hiddenCount}`}
                </span>
            </button>
        </>
    );
});

const formatTurnDuration = (durationMs: number): string => {
    if (durationMs < 60_000) {
        return `${(durationMs / 1000).toFixed(1)}s`;
    }
    const totalSeconds = Math.round(durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
};

interface MessageBodyProps {
    sessionId?: string;
    messageId: string;
    parts: Part[];
    isUser: boolean;
    isMessageCompleted: boolean;
    messageFinish?: string;
    messageCompletedAt?: number;
    messageCreatedAt?: number;


    isMobile: boolean;
    alwaysShowActions?: boolean;
    hasTouchInput?: boolean;
    copiedCode: string | null;
    onCopyCode: (code: string) => void;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    streamPhase: StreamPhase;
    allowAnimation: boolean;
    shouldShowHeader?: boolean;
    hasTextContent?: boolean;
    onCopyMessage?: () => void | boolean | Promise<void | boolean>;
    /** Copies the whole turn's reply; the turn footer uses it instead of `onCopyMessage`. */
    onCopyTurn?: () => Promise<boolean>;
    copiedMessage?: boolean;
    /** Copies a link to this message; absent where the surface has no message links. */
    onCopyLink?: () => void;
    showReasoningTraces?: boolean;
    agentMention?: AgentMentionInfo;
    turnGroupingContext?: TurnGroupingContext;
    onRevert?: () => void;
    onFork?: () => void;
    errorMessage?: string;
    /** Raw provider response behind `errorMessage`, shown as collapsed details. */
    errorResponseBody?: string;
    /** A user message renders as two siblings: the bubble, and the actions row under it. */
    userMessagePart?: 'bubble' | 'actions';
    reviewTransferDirection?: ReviewTransferDirection | null;
    contextPinned?: boolean;
    contextPinPending?: boolean;
    onToggleContextPin?: () => void;
    footerProviderID?: string | null;
    footerModelName?: string;
    footerAgentName?: string;
    footerVariant?: string;
    isDarkTheme?: boolean;
    /** Actions installed extensions contribute for this message's role; rendered after the built-ins. */
    extraActions?: MessageExtraAction[];
    /** The session whose agent sent this user message, linked at the foot of the bubble. */
    promptOrigin?: PromptOrigin;
}

/** One extension action on a message: an icon button on hover, a labelled row in the touch sheet. */
export type MessageExtraAction = {
    id: string;
    label: string;
    icon: React.ReactNode;
    onSelect: () => void;
};

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

/**
 * Extension actions on desktop live behind one apps button, the same way the
 * touch sheets already fold every action away, so several extensions never
 * stretch the hover row.
 */
const MessageExtraActionButtons: React.FC<{ actions?: MessageExtraAction[] }> = ({ actions }) => {
    const { t } = useI18n();
    if (!actions || actions.length === 0) return null;
    return (
        <DropdownMenu>
            <Tooltip>
                <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={t('chat.messageBody.actions.moreActions')}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                        >
                            <Icon name="apps" className="h-3.5 w-3.5" />
                        </Button>
                    </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.moreActions')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" onPointerDown={(event) => event.stopPropagation()}>
                {actions.map((action) => (
                    <DropdownMenuItem key={action.id} className="typography-meta" onSelect={() => action.onSelect()}>
                        <span className="flex items-center gap-2 min-w-0">
                            <span className="flex size-4 shrink-0 items-center justify-center">{action.icon}</span>
                            <span className="truncate">{action.label}</span>
                        </span>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

/** Copies a link to the message; the toast confirms, as the link is not visible. */
const CopyMessageLinkButton: React.FC<{ onCopyLink: () => void }> = ({ onCopyLink }) => {
    const { t } = useI18n();
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t('chat.messageBody.actions.copyLink')}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        event.preventDefault();
                        onCopyLink();
                    }}
                >
                    <Icon name="link" className="h-3 w-3" />
                </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.copyLink')}</TooltipContent>
        </Tooltip>
    );
};

const UserMessageBody = React.memo(({ messageId, parts, messageCreatedAt, isMobile, alwaysShowActions = isMobile, hasTouchInput, hasTextContent, onCopyMessage, copiedMessage, onShowPopup, agentMention, onRevert, onFork, contextPinned, contextPinPending, onToggleContextPin, userMessagePart = 'bubble', extraActions, promptOrigin }: {
    messageId: string;
    parts: Part[];
    promptOrigin?: PromptOrigin;
    messageCreatedAt?: number | null;
    isMobile: boolean;
    alwaysShowActions?: boolean;
    hasTouchInput?: boolean;
    hasTextContent?: boolean;
    onCopyMessage?: () => void | boolean | Promise<void | boolean>;
    copiedMessage?: boolean;
    onShowPopup: (content: ToolPopupContent) => void;
    agentMention?: AgentMentionInfo;
    onRevert?: () => void;
    onFork?: () => void;
    contextPinned?: boolean;
    contextPinPending?: boolean;
    onToggleContextPin?: () => void;
    userMessagePart?: 'bubble' | 'actions';
    extraActions?: MessageExtraAction[];
}) => {
    const { locale, t } = useI18n();
    const chatSurfaceMode = useChatSurfaceMode();
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const [copyHintVisible, setCopyHintVisible] = React.useState(false);
    const copyHintTimeoutRef = React.useRef<number | null>(null);

    // One expanded state for the whole message: text parts and context cards
    // collapse and expand together, with a single show more / show less link
    // under the text instead of one control per part.
    const collapsibleUserMessages = useUIStore((state) => state.collapsibleUserMessages);
    const [messageExpanded, setMessageExpanded] = React.useState(false);
    const [truncatedPartIndexes, setTruncatedPartIndexes] = React.useState<ReadonlySet<number>>(() => new Set());
    const expandMessage = React.useCallback(() => setMessageExpanded(true), []);
    const toggleMessageExpanded = React.useCallback((event: React.MouseEvent) => {
        event.stopPropagation();
        setMessageExpanded((value) => !value);
    }, []);
    const handlePartTruncationChange = React.useCallback((partIndex: number, truncated: boolean) => {
        setTruncatedPartIndexes((current) => {
            if (current.has(partIndex) === truncated) return current;
            const next = new Set(current);
            if (truncated) next.add(partIndex);
            else next.delete(partIndex);
            return next;
        });
    }, []);
    const showMessageExpandToggle = collapsibleUserMessages && (messageExpanded || truncatedPartIndexes.size > 0);
    React.useEffect(() => {
        if (!collapsibleUserMessages) setMessageExpanded(false);
    }, [collapsibleUserMessages]);

    const userContentParts = React.useMemo(() => {
        return parts.filter((part) => {
            if (part.type === 'text') {
                return !isEmptyTextPart(part);
            }
            return false;
        });
    }, [parts]);

    const sessionMentionChips = React.useMemo(() => sessionMentionChipsOf(parts), [parts]);
    const attachmentFilenames = React.useMemo(() => parts.flatMap((part) => (
        part.type === 'file' && part.filename ? [part.filename] : []
    )), [parts]);

    const attachmentFiles = React.useMemo(() => parts.filter((part): part is FilePart => (
        part.type === 'file' && Boolean(part.url)
    )), [parts]);

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

    const effectiveOnFork = chatSurfaceMode === 'mini-chat' ? undefined : onFork;
    const [userActionSheetOpen, setUserActionSheetOpen] = React.useState(false);
    const userSheetActions = React.useMemo(() => {
        const actions: Array<{ id: string; label: string; icon: React.ReactNode; disabled?: boolean; onSelect: () => void }> = [];
        if (canCopyMessage && hasCopyableText && onCopyMessage) {
            actions.push({
                id: 'copy',
                label: t('chat.messageBody.actions.copyMessage'),
                icon: <Icon name="file-copy" className="h-4 w-4" />,
                // The sheet closes on tap, so the button's own tick has nowhere
                // to land — say it with a toast instead.
                onSelect: () => {
                    void (async () => {
                        const copied = await onCopyMessage();
                        if (copied !== false) toast.success(t('chat.messageBody.toast.copied'));
                    })();
                },
            });
        }
        if (onToggleContextPin && hasCopyableText) {
            actions.push({
                id: 'pin-context',
                label: t(contextPinned ? 'chat.messageBody.actions.unpinContext' : 'chat.messageBody.actions.pinContext'),
                icon: <Icon name={contextPinned ? 'pushpin-2-fill' : 'pushpin-2'} className="h-4 w-4" />,
                disabled: contextPinPending,
                onSelect: () => { onToggleContextPin(); },
            });
        }
        if (effectiveOnFork) {
            actions.push({
                id: 'fork',
                label: t('chat.messageBody.actions.fork'),
                icon: <Icon name="git-branch" className="h-4 w-4" />,
                onSelect: () => { effectiveOnFork(); },
            });
        }
        if (onRevert) {
            actions.push({
                id: 'revert',
                label: t('chat.messageBody.actions.revert'),
                icon: <Icon name="arrow-go-back" className="h-4 w-4" />,
                onSelect: () => { onRevert(); },
            });
        }
        for (const extra of extraActions ?? []) {
            actions.push({ id: extra.id, label: extra.label, icon: extra.icon, onSelect: extra.onSelect });
        }
        return actions;
    }, [canCopyMessage, contextPinPending, contextPinned, effectiveOnFork, extraActions, hasCopyableText, onCopyMessage, onRevert, onToggleContextPin, t]);
    const timestamp = React.useMemo(() => {
        void locale;
        if (typeof messageCreatedAt !== 'number' || messageCreatedAt <= 0) return null;
        const formatted = formatTimestampForDisplay(messageCreatedAt, timeFormatPreference);
        return formatted.length > 0 ? formatted : null;
    }, [locale, messageCreatedAt, timeFormatPreference]);
    const hasExtraActions = Boolean(extraActions && extraActions.length > 0);
    const actionsBlock = chatSurfaceMode !== 'peek' && ((canCopyMessage && hasCopyableText) || onRevert || effectiveOnFork || onToggleContextPin || hasExtraActions) ? (
        <div className={cn(
            'group/user-actions flex items-start justify-end',
            // In a sticky turn header (TurnItem) the mobile row is shorter: it
            // stays on screen, and the reply below keeps its own top margin.
            isMobile ? 'h-11 pt-0 in-data-[turn-sticky-header]:h-9' : 'h-8 pt-2'
        )}>
            <div
                className={cn(
                    'flex items-center justify-end gap-1.5 [&_button]:!h-[26px] [&_button]:!w-[26px] [&_svg]:!size-3.5',
                    alwaysShowActions
                        ? 'pointer-events-auto opacity-100'
                        : 'pointer-events-none opacity-0 transition-opacity duration-150 group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-hover/user-actions:pointer-events-auto group-hover/user-actions:opacity-100 group-hover/user-shell:pointer-events-auto group-hover/user-shell:opacity-100'
                )}
            >
                {/* Touch reads the time in the actions sheet instead — see below. */}
                {timestamp && !alwaysShowActions ? (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span
                                className="me-1 flex items-center gap-1 text-sm tabular-nums text-muted-foreground/60"
                                aria-label={`Message time: ${timestamp}`}
                            >
                                <Icon name="time" className="h-3.5 w-3.5" />
                                <span>{timestamp}</span>
                            </span>
                        </TooltipTrigger>
                        <TooltipContent>{timestamp}</TooltipContent>
                    </Tooltip>
                ) : null}
                {/* Touch has no hover, so the row would stand open under every
                    message. One button and a labelled sheet instead — the same
                    shape the assistant footer uses. */}
                {alwaysShowActions ? (
                    <>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={t('chat.messageBody.actions.moreActions')}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                event.stopPropagation();
                                setUserActionSheetOpen(true);
                            }}
                        >
                            <Icon name="more" className="h-3.5 w-3.5" />
                        </Button>
                        <MobileOverlayPanel
                            open={userActionSheetOpen}
                            onClose={() => setUserActionSheetOpen(false)}
                            title={t('chat.messageBody.actions.moreActions')}
                        >
                            <div className="flex flex-col">
                                {timestamp ? (
                                    <div className="mb-1 flex items-center gap-3 border-b border-border/60 px-3 pb-2 text-muted-foreground">
                                        <Icon name="time" className="h-4 w-4" />
                                        <span className="typography-ui-label">{timestamp}</span>
                                    </div>
                                ) : null}
                                {userSheetActions.map((action) => (
                                    <button
                                        key={action.id}
                                        type="button"
                                        disabled={action.disabled}
                                        className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-start text-foreground transition-colors active:bg-interactive-active disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                                        onClick={() => {
                                            setUserActionSheetOpen(false);
                                            action.onSelect();
                                        }}
                                        style={{ touchAction: 'manipulation' }}
                                    >
                                        <span className="text-muted-foreground">{action.icon}</span>
                                        <span className="typography-ui-label">{action.label}</span>
                                    </button>
                                ))}
                            </div>
                        </MobileOverlayPanel>
                    </>
                ) : (
                    <>
                    {onRevert && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
                                    aria-label={t('chat.messageBody.actions.revertAria')}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onRevert();
                                    }}
                                >
                                    <Icon name="arrow-go-back" className="h-3 w-3" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.revert')}</TooltipContent>
                        </Tooltip>
                    )}
                    {effectiveOnFork && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
                                    aria-label={t('chat.messageBody.actions.forkAria')}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        effectiveOnFork();
                                    }}
                                >
                                    <Icon name="git-branch" className="h-3 w-3" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.fork')}</TooltipContent>
                        </Tooltip>
                    )}
                    {onToggleContextPin && hasCopyableText && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className={cn(
                                        'h-6 w-6 bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring',
                                        contextPinned ? 'text-[color:var(--status-info)]' : 'text-muted-foreground',
                                    )}
                                    disabled={contextPinPending}
                                    aria-pressed={contextPinned}
                                    aria-label={t(contextPinned ? 'chat.messageBody.actions.unpinContext' : 'chat.messageBody.actions.pinContext')}
                                    onPointerDown={(event) => event.stopPropagation()}
                                    onClick={(event) => { event.stopPropagation(); onToggleContextPin(); }}
                                >
                                    <Icon name={contextPinned ? 'pushpin-2-fill' : 'pushpin-2'} className="h-3 w-3" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent sideOffset={6}>{t(contextPinned ? 'chat.messageBody.actions.unpinContext' : 'chat.messageBody.actions.pinContext')}</TooltipContent>
                        </Tooltip>
                    )}
                    {canCopyMessage && hasCopyableText && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    data-visible={copyHintVisible || isMessageCopied ? 'true' : undefined}
                                    className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
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
                                        <Icon name="check" className="h-3 w-3 text-[color:var(--status-success)]" />
                                    ) : (
                                        <Icon name="file-copy" className="h-3 w-3" />
                                    )}
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.copyMessage')}</TooltipContent>
                        </Tooltip>
                    )}
                    <MessageExtraActionButtons actions={extraActions} />
                    </>
                )}

            </div>
        </div>
    ) : null;

    if (userMessagePart === 'actions') {
        return <>{actionsBlock}</>;
    }

    return (
        <div
            className="relative w-full group/message"
            style={CONTAIN_LAYOUT_STYLE}
            onTouchStart={isTouchContext && canCopyMessage && hasCopyableText ? revealCopyHint : undefined}
        >
            {/* Attachments lead the bubble, above the text. */}
            <MessageFilesDisplay
                files={parts}
                onShowPopup={onShowPopup}
                compact
                className={userContentParts.length > 0 ? 'mb-2' : 'mt-0'}
            />
            {/* A long prompt in a sticky turn header scrolls inside the bubble,
                so the header never covers more than 40% of the screen. Only
                there: `overflow-hidden` already makes the text a scroll
                container, and `overscroll-contain` on it stopped the wheel
                over any prompt from reaching the chat. */}
            <div className="leading-relaxed text-foreground/90 text-base overflow-hidden scrollbar-none in-data-[turn-sticky-header]:max-h-[40dvh] in-data-[turn-sticky-header]:overflow-y-auto in-data-[turn-sticky-header]:overscroll-contain">
                {/* Positional keys, not part ids: the server echo of a just-sent
                    message swaps the optimistic part id, and id-based keys would
                    remount the text subtree (blank frame + height jump). */}
                {userContentParts.map((part, index) => {
                    let mentionForPart: AgentMentionInfo | undefined;
                    if (agentMention && mentionToken && !mentionInjected) {
                        const candidateText = extractTextContent(part);
                        if (candidateText.includes(mentionToken)) {
                            mentionForPart = agentMention;
                            mentionInjected = true;
                        }
                    }
                    return (
                        <React.Fragment key={`user-text-${index}`}>
                            <UserTextPart
                                part={part}
                                messageId={messageId}
                                isMobile={isMobile}
                                agentMention={mentionForPart}
                                messageExpanded={messageExpanded}
                                onExpandMessage={expandMessage}
                                partIndex={index}
                                onTruncationChange={handlePartTruncationChange}
                                attachmentFilenames={attachmentFilenames}
                                attachmentFiles={attachmentFiles}
                                onShowPopup={onShowPopup}
                                sessionMentionChips={sessionMentionChips}
                            />
                        </React.Fragment>
                    );
                })}
            </div>
            {(showMessageExpandToggle || promptOrigin) && (
                <div className="mt-1 flex min-w-0 items-center justify-end gap-1.5 text-sm text-muted-foreground">
                    {promptOrigin ? <PromptOriginLink origin={promptOrigin} /> : null}
                    {promptOrigin && showMessageExpandToggle ? <span aria-hidden="true">·</span> : null}
                    {showMessageExpandToggle && (
                        // A quiet text link, not a button: the collapsed text itself is
                        // already the large tap target. Inline min sizes opt out of the
                        // mobile 36px button minimum, which turned this into a block.
                        <button
                            type="button"
                            onClick={toggleMessageExpanded}
                            className={cn('shrink-0', USER_BUBBLE_TEXT_LINK_CLASS)}
                            style={INLINE_TEXT_LINK_STYLE}
                            aria-expanded={messageExpanded}
                        >
                            {t(messageExpanded ? 'chat.message.userText.showLess' : 'chat.message.userText.showMore')}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
});

const USER_BUBBLE_TEXT_LINK_CLASS = 'py-0.5 underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:underline focus-visible:outline-none focus-visible:text-foreground';
const INLINE_TEXT_LINK_STYLE = { minHeight: 0, minWidth: 0 };
const TITLE_SLOT = '\u0000';
const selectSessionTitle = (session: Session | undefined): string | undefined => session?.title?.trim() || undefined;

/**
 * "From session <title>" at the foot of a prompt another session's agent
 * sent; the title opens that session. The live title wins over the one the
 * prompt recorded, which stands in while the session is not loaded here.
 */
const PromptOriginLink: React.FC<{ origin: PromptOrigin }> = ({ origin }) => {
    const { t } = useI18n();
    const liveTitle = useSessionSelector(origin.sessionID, undefined, selectSessionTitle);
    const title = liveTitle ?? origin.title;
    const open = (event: React.MouseEvent) => {
        event.stopPropagation();
        void openSessionLink(origin.sessionID, null);
    };
    if (!title) {
        return (
            <button type="button" onClick={open} className={cn('min-w-0 truncate', USER_BUBBLE_TEXT_LINK_CLASS)} style={INLINE_TEXT_LINK_STYLE}>
                {t('chat.message.userText.promptedByUnknown')}
            </button>
        );
    }
    // The title sits where each language puts it in the sentence.
    const [before, after = ''] = t('chat.message.userText.promptedBy', { title: TITLE_SLOT }).split(TITLE_SLOT);
    return (
        <span className="flex min-w-0 items-center whitespace-pre">
            {before ? <span className="shrink-0">{before}</span> : null}
            <button
                type="button"
                onClick={open}
                className={cn('min-w-0 truncate', USER_BUBBLE_TEXT_LINK_CLASS)}
                style={INLINE_TEXT_LINK_STYLE}
                title={title}
                dir="auto"
            >
                {title}
            </button>
            {after ? <span className="shrink-0">{after}</span> : null}
        </span>
    );
};

/** Copies an assistant answer; the icon turns into a tick for a moment once it lands. */
const AssistantCopyButton = React.memo(({
    hasCopyableText,
    isTouchContext,
    onCopyMessage,
}: {
    hasCopyableText: boolean;
    isTouchContext: boolean;
    onCopyMessage: () => void | boolean | Promise<void | boolean>;
}) => {
    const { t } = useI18n();
    const [copyHintVisible, setCopyHintVisible] = React.useState(false);
    const [isMessageCopied, setIsMessageCopied] = React.useState(false);
    const copyHintTimeoutRef = React.useRef<number | null>(null);
    const copiedResetTimeoutRef = React.useRef<number | null>(null);

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
        if (!hasCopyableText) {
            setCopyHintVisible(false);
            setIsMessageCopied(false);
            clearCopyHintTimeout();
            clearCopiedResetTimeout();
        }
    }, [clearCopiedResetTimeout, clearCopyHintTimeout, hasCopyableText]);

    const revealCopyHint = React.useCallback(() => {
        if (!isTouchContext || !hasCopyableText || typeof window === 'undefined') {
            return;
        }

        clearCopyHintTimeout();
        setCopyHintVisible(true);
        copyHintTimeoutRef.current = window.setTimeout(() => {
            setCopyHintVisible(false);
            copyHintTimeoutRef.current = null;
        }, 1800);
    }, [clearCopyHintTimeout, hasCopyableText, isTouchContext]);

    const handleCopyButtonClick = React.useCallback(
        async (event: React.MouseEvent<HTMLButtonElement>) => {
            if (!hasCopyableText) {
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

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    data-visible={copyHintVisible || isMessageCopied ? 'true' : undefined}
                    className={cn(
                        'h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring',
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
                        <Icon name="check" className="h-3 w-3 text-[color:var(--status-success)]" />
                    ) : (
                        <Icon name="file-copy" className="h-3 w-3" />
                    )}
                </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.copyAnswer')}</TooltipContent>
        </Tooltip>
    );
});

interface AssistantMessageActionButtonsProps {
    hasCopyableText: boolean;
    isTouchContext: boolean;
    onCopyMessage?: () => void | boolean | Promise<void | boolean>;
    onCopyLink?: () => void;
    reviewTransferAction?: {
        ariaLabel: string;
        tooltip: string;
        onClick: () => void | Promise<void>;
    };
    onShareImage: (sourceElement?: HTMLElement | null) => Promise<void>;
    ttsText: string;
    // Shared with the message's other reading controls; see useMessageTTS.
    ttsReadingKey?: string;
    extraActions?: MessageExtraAction[];
}

/** The full action row under an assistant text block when the split-actions setting is on. */
const AssistantMessageActionButtons = React.memo(({
    hasCopyableText,
    isTouchContext,
    onCopyMessage,
    onCopyLink,
    reviewTransferAction,
    onShareImage,
    ttsText,
    ttsReadingKey,
    extraActions,
}: AssistantMessageActionButtonsProps) => {
    const { t } = useI18n();
    const chatSurfaceMode = useChatSurfaceMode();
    const { isPlaying: isTTSPlaying, play: playTTS, stop: stopTTS } = useMessageTTS(ttsReadingKey);
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    const voiceProvider = useConfigStore((state) => state.voiceProvider);
    const [isSharing, setIsSharing] = React.useState(false);
    const [isTransferringReview, setIsTransferringReview] = React.useState(false);

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

    const handleReviewTransferClick = React.useCallback(
        async (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            event.preventDefault();
            if (!reviewTransferAction || isTransferringReview || !hasCopyableText) return;
            setIsTransferringReview(true);
            try {
                await reviewTransferAction.onClick();
            } finally {
                setIsTransferringReview(false);
            }
        },
        [hasCopyableText, isTransferringReview, reviewTransferAction]
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
            {onCopyLink && <CopyMessageLinkButton onCopyLink={onCopyLink} />}
            {onCopyMessage && (
                <AssistantCopyButton hasCopyableText={hasCopyableText} isTouchContext={isTouchContext} onCopyMessage={onCopyMessage} />
            )}
            {reviewTransferAction && chatSurfaceMode !== 'mini-chat' ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            disabled={isTransferringReview || !hasCopyableText}
                            className={cn(
                                'h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring',
                                (!hasCopyableText || isTransferringReview) && 'opacity-50'
                            )}
                            aria-label={reviewTransferAction.ariaLabel}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                void handleReviewTransferClick(event);
                            }}
                        >
                            {isTransferringReview ? (
                                <Icon name="loader-4" className="h-3 w-3 animate-spin" />
                            ) : (
                                <Icon name="arrow-left-right" className="h-3 w-3" />
                            )}
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{reviewTransferAction.tooltip}</TooltipContent>
                </Tooltip>
            ) : null}
            {chatSurfaceMode !== 'mini-chat' ? <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        disabled={isSharing || !hasCopyableText}
                        className={cn(
                            'h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring',
                            (!hasCopyableText || isSharing) && 'opacity-50'
                        )}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            void handleShareImageClick(event);
                        }}
                    >
                        {isSharing ? (
                            <Icon name="loader-4" className="h-3 w-3 animate-spin" />
                        ) : (
                            <Icon name="image-download" className="h-3 w-3" />
                        )}
                    </Button>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>{isSharing ? t('chat.messageBody.actions.savingImage') : t('chat.messageBody.actions.saveAsImage')}</TooltipContent>
            </Tooltip> : null}
            {chatSurfaceMode !== 'mini-chat' && showMessageTTSButtons && hasCopyableText && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={cn(
                                'h-6 w-6 bg-transparent hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring',
                                isTTSPlaying ? 'text-[var(--primary-text)]' : 'text-muted-foreground hover:text-foreground'
                            )}
                            aria-label={isTTSPlaying ? t('chat.messageBody.tts.stopSpeaking') : t('chat.messageBody.tts.readAloud')}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={handleTTSClick}
                        >
                            <Icon name="volume-up" className={cn('h-3 w-3', isTTSPlaying && 'text-[var(--primary-text)]')} />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{readAloudTooltip}</TooltipContent>
                </Tooltip>
            )}
            {chatSurfaceMode !== 'mini-chat' ? <MessageExtraActionButtons actions={extraActions} /> : null}
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

    isMobile,
    alwaysShowActions,
    hasTouchInput,
    expandedTools,
    onToggleTool,
    onShowPopup,
    streamPhase: _streamPhase,
    allowAnimation: _allowAnimation,
    hasTextContent = false,
    onCopyMessage,
    onCopyTurn,
    onCopyLink,
    showReasoningTraces = false,
    turnGroupingContext,
    errorMessage,
    errorResponseBody,
    reviewTransferDirection = null,
    contextPinned,
    contextPinPending,
    onToggleContextPin,
    footerProviderID,
    footerModelName,
    footerAgentName,
    footerVariant,
    isDarkTheme = false,
    extraActions,
}: Omit<MessageBodyProps, 'isUser'>) => {
    const { t, locale } = useI18n();
    const chatSurfaceMode = useChatSurfaceMode();
    const streamPhase = _streamPhase;
    void _allowAnimation;
    const messageContentRef = React.useRef<HTMLDivElement>(null);
    const messageTextContentRef = React.useRef<HTMLDivElement>(null);
    const toolRevealReadyRef = React.useRef(false);

    React.useEffect(() => {
        toolRevealReadyRef.current = true;
    }, []);

    const isTouchContext = Boolean(hasTouchInput ?? isMobile);
    const alwaysShowMessageActions = Boolean(alwaysShowActions ?? isMobile);
    const { src: footerLogoSrc, onError: handleFooterLogoError, hasLogo: footerHasLogo } = useProviderLogo(footerProviderID ?? null);
    const awaitingMessageCompletion = !isMessageCompleted;

    const visibleParts = React.useMemo(() => {
        return parts.filter((part) => !isEmptyTextPart(part));
    }, [parts]);

    const toolParts = React.useMemo(() => {
        return visibleParts.filter((part): part is ToolPartType => part.type === 'tool');
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

    const currentToolIds = React.useMemo(() => toolParts.map((toolPart) => toolPart.id), [toolParts]);
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

    const isVSCode = isVSCodeRuntime();
    const isMiniChatSurface = chatSurfaceMode === 'mini-chat';
    const canUseProjectPlanActions = !isVSCode && !isMiniChatSurface && !isMobile;
    const canShowMultiRunAction = !isVSCode && !isMiniChatSurface && !isMobile;

    const createSessionFromAssistantMessage = useSessionUIStore((state) => state.createSessionFromAssistantMessage);
    const currentSessionId = useChatSessionSelection().sessionId;
    const getDirectoryForSession = useSessionUIStore((state) => state.getDirectoryForSession);
    const projects = useProjectsStore((state) => state.projects);
    const effectiveDirectory = useEffectiveDirectory();
    const isReviewSessionView = reviewTransferDirection === 'review-to-original';
    const effectiveReviewTransferDirection = (!isMobile && !isVSCode) ? reviewTransferDirection : null;
    const reviewTransferAction = React.useMemo(() => {
        const transferText = assistantPlanText.trim();
        if (!sessionId || !effectiveDirectory || !transferText || !effectiveReviewTransferDirection) return undefined;
        if (effectiveReviewTransferDirection === 'review-to-original') {
            return {
                ariaLabel: t('chat.messageBody.actions.sendReviewFeedback'),
                tooltip: t('chat.messageBody.actions.sendReviewFeedback'),
                onClick: async () => {
                    try {
                        await sendReviewFeedbackToOriginal(sessionId, effectiveDirectory, transferText);
                    } catch (error) {
                        console.error('[review-flow] failed to send review feedback', error);
                    }
                },
            };
        }
        return {
            ariaLabel: t('chat.messageBody.actions.sendImplementationResponse'),
            tooltip: t('chat.messageBody.actions.sendImplementationResponse'),
            onClick: async () => {
                try {
                    await sendImplementationResponseToReviewer(sessionId, effectiveDirectory, transferText);
                } catch (error) {
                    console.error('[review-flow] failed to send implementation response', error);
                }
            },
        };
    }, [assistantPlanText, effectiveDirectory, effectiveReviewTransferDirection, sessionId, t]);
    const [isPlanDialogOpen, setIsPlanDialogOpen] = React.useState(false);
    // The plan dialog mounts on its first open and stays mounted so closing
    // still animates; until then a streaming message renders none of it.
    const [isPlanDialogMounted, setIsPlanDialogMounted] = React.useState(false);
    const suggestedPlanTitle = React.useMemo(
        () => (isPlanDialogMounted ? suggestPlanTitleFromText(assistantPlanText) : ''),
        [assistantPlanText, isPlanDialogMounted],
    );
    const [isSavingPlan, setIsSavingPlan] = React.useState(false);
    const [isForkDialogOpen, setIsForkDialogOpen] = React.useState(false);
    const [isForkSubmitting, setIsForkSubmitting] = React.useState(false);
    const collapsibleThinkingBlocks = useUIStore((state) => state.collapsibleThinkingBlocks);
    const showSplitAssistantMessageActions = useUIStore((state) => state.showSplitAssistantMessageActions);
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const vscodeApi = useRuntimeAPIs().vscode;
    const liveFinalActivity = React.useContext(LiveFinalActivityContext);
    const activityRowSkip = React.useContext(ActivityRowSkipContext);
    const hoistedPages = React.useContext(LiveTurnHoistedPagesContext);
    const isLastAssistantInTurn = turnGroupingContext?.isLastAssistantInTurn ?? false;
    const hasStopFinish = messageFinish === 'stop';
    const effectiveStreamPhase: StreamPhase = hasStopFinish ? 'completed' : streamPhase;

    const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
    const sessionProjectRef = React.useMemo(() => {
        const directory = effectiveDirectory
            ?? (currentSessionId ? getDirectoryForSession(currentSessionId) : null)
            ?? '';
        const resolved = resolveProjectForSessionDirectory(projects, availableWorktreesByProject, directory);
        return resolved ? { id: resolved.id, path: resolved.path } : null;
    }, [availableWorktreesByProject, currentSessionId, effectiveDirectory, getDirectoryForSession, projects]);
    const currentProjectRef = canUseProjectPlanActions ? sessionProjectRef : null;

    const hasCopyableText = Boolean(hasTextContent) && !awaitingMessageCompletion;

    const handleForkClick = React.useCallback(
        // Optional event: the footer's action sheet calls this without one.
        (event?: React.MouseEvent<HTMLButtonElement>) => {
            event?.stopPropagation();
            event?.preventDefault();
            if (!assistantPlanText.trim()) {
                return;
            }
            setIsForkDialogOpen(true);
        },
        [assistantPlanText]
    );

    const handleConfirmFork = React.useCallback(
        async (execution: ForkSessionExecution) => {
            setIsForkSubmitting(true);
            try {
                if (!sessionId) {
                    throw new Error('Source session is unavailable');
                }
                const sourceDirectory = effectiveDirectory ?? getDirectoryForSession(sessionId);
                if (!sourceDirectory) {
                    throw new Error('Source session directory is unavailable');
                }
                await createSessionFromAssistantMessage({
                    sessionId,
                    directory: sourceDirectory,
                    text: assistantPlanText,
                }, execution);
                setIsForkDialogOpen(false);
            } catch (error) {
                console.error('Failed to start a session from an assistant message:', error);
                if (error instanceof WorktreeRequiresGitRepositoryError) {
                    toast.error(t('rightSidebar.contextNotesTodo.toast.worktreeRequiresGitRepo'));
                    return;
                }

                const description = error instanceof Error ? error.message : undefined;
                toast.error(
                    t('rightSidebar.contextNotesTodo.toast.createSessionFailed'),
                    description ? { description } : undefined
                );
            } finally {
                setIsForkSubmitting(false);
            }
        },
        [assistantPlanText, createSessionFromAssistantMessage, effectiveDirectory, getDirectoryForSession, sessionId, t]
    );

    const handleForkFromHere = React.useCallback(() => {
        if (!sessionId) return;
        void useSessionUIStore.getState().forkAfterMessage(sessionId, messageId);
    }, [messageId, sessionId]);

    const handleForkMultiRun = React.useCallback(
        () => {
            if (!assistantPlanText.trim()) {
                return;
            }

            const prefilledPrompt = `${MULTIRUN_EXECUTION_FORK_PROMPT_META_TEXT}\n\n${assistantPlanText}`;
            openParallelComposer(prefilledPrompt);
        },
        [assistantPlanText]
    );

    const [askOtherModelsSession, setAskOtherModelsSession] = React.useState<Session | null>(null);
    const handleAskOtherModels = React.useCallback(() => {
        if (!sessionId) return;
        const session = useGlobalSessionsStore.getState().activeSessions.find((entry) => entry.id === sessionId);
        if (!session) return;
        // A lane is already part of a run: its overview is where more models join.
        const identity = getMultiRunIdentity(session);
        if (identity) {
            useUIStore.getState().setRunOverviewKey(identity.key);
            return;
        }
        setAskOtherModelsSession(session);
    }, [sessionId]);

    const handleSaveAsPlanClick = React.useCallback(
        // Optional event: the footer's action sheet calls this without one.
        (event?: React.MouseEvent<HTMLButtonElement>) => {
            event?.stopPropagation();
            event?.preventDefault();
            if (!assistantPlanText.trim()) {
                return;
            }
            setIsPlanDialogMounted(true);
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
                const created = await useProjectContextStore.getState().createPlan(currentProjectRef, {
                    title,
                    body: assistantPlanText,
                });
                if (!created) {
                    toast.error(t('chat.messageBody.toast.savePlanFailed'));
                    return;
                }
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
                // Load the exporter before attaching its temporary clone so a slow
                // chunk request cannot leave export-only content in the page layout.
                const { toPng } = await import('html-to-image');
                const originalElement = sourceElement;
                const computedStyle = window.getComputedStyle(originalElement);
                const rootStyle = window.getComputedStyle(document.documentElement);
                const resolvedBackgroundColor =
                    rootStyle.getPropertyValue('--surface-background').trim() ||
                    computedStyle.backgroundColor ||
                    window.getComputedStyle(document.body).backgroundColor;
                const paddingSize = 24;

                wrapper = document.createElement('div');
                wrapper.setAttribute('data-message-image-export', 'true');
                wrapper.style.cssText = `
                    padding: ${paddingSize}px;
                    background-color: ${resolvedBackgroundColor};
                    display: inline-block;
                `;

                const clone = cloneMessageImageExportSource(originalElement);
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
                    const payload = await vscodeApi?.saveImage?.({ fileName, dataUrl }) as { saved?: boolean; canceled?: boolean; error?: string } | undefined;
                    if (!payload) {
                        throw new Error('Failed to save image in VS Code');
                    }
                    if (payload.saved !== true) {
                        if (payload.canceled) {
                            return;
                        }
                        throw new Error(payload.error || 'Failed to save image in VS Code');
                    }
                } else if (isCapacitorMobileApp()) {
                    const blob = await fetch(dataUrl).then((response) => response.blob());
                    await shareFileFromNativeApp(new File([blob], fileName, { type: blob.type || 'image/png' }));
                } else {
                    // Desktop titles the save dialog with the download URL, so a data URL
                    // would put the whole image in the title.
                    const blob = await fetch(dataUrl).then((response) => response.blob());
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.download = fileName;
                    link.href = url;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    URL.revokeObjectURL(url);
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
        [messageId, t, vscodeApi]
    );

    // Re-render every part so folded text and settled highlighting are included.
    const earlierAssistantText = turnGroupingContext?.earlierAssistantText;
    const shareTurnAsImage = React.useCallback(
        async (requestedSourceElement?: HTMLElement | null) => {
            const segments = [...(earlierAssistantText ?? []), ...assistantTextSegments(assistantTextParts)];
            if (segments.length === 0) {
                await shareMessageAsImage(requestedSourceElement);
                return;
            }
            const syntaxStyle = messageContentRef.current?.querySelector('[data-markdown-content]')?.getAttribute('style') ?? null;
            let turnSource: HTMLElement;
            try {
                turnSource = await buildTurnImageExportSource(segments, syntaxStyle);
            } catch (error) {
                console.error('Failed to generate image:', error);
                toast.error(t('chat.messageBody.toast.generateImageFailed'));
                return;
            }
            await shareMessageAsImage(turnSource);
        },
        [assistantTextParts, earlierAssistantText, shareMessageAsImage, t]
    );

    const showErrorMessage = Boolean(errorMessage);
    const isPeekSurface = chatSurfaceMode === 'peek';
    const shouldShowMessageActions = hasCopyableText && !isPeekSurface;
    const shouldShowTurnFooter = isLastAssistantInTurn && hasTextContent && (hasStopFinish || Boolean(errorMessage)) && !isPeekSurface;
    const shouldShowStandaloneMessageActions = showSplitAssistantMessageActions && shouldShowMessageActions && !shouldShowTurnFooter;

    const messageActionButtons = React.useMemo(() => (
        <AssistantMessageActionButtons
            hasCopyableText={hasCopyableText}
            isTouchContext={isTouchContext}
            onCopyMessage={onCopyMessage}
            onCopyLink={onCopyLink}
            onShareImage={shareMessageAsImage}
            ttsText={assistantPlanText}
            ttsReadingKey={messageId}
            reviewTransferAction={reviewTransferAction}
            extraActions={extraActions}
        />
    ), [assistantPlanText, extraActions, hasCopyableText, isTouchContext, messageId, onCopyLink, onCopyMessage, reviewTransferAction, shareMessageAsImage]);

    // The turn footer copies the whole turn when the turn has more than this message.
    const onCopyFooter = onCopyTurn ?? onCopyMessage;

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
            lastIndex = index;
        }

        return lastIndex;
    }, [shouldShowStandaloneMessageActions, visibleParts]);

    const shouldRenderStandaloneActionsAfterContent = shouldShowStandaloneMessageActions && lastRenderableTextPartIndex < 0;

    const renderedParts = React.useMemo(() => {
        const answerRendered: React.ReactNode[] = [];
        const activityRendered: React.ReactNode[] = [];
        let rendered = answerRendered;
        const splitLiveActivity = liveFinalActivity?.messageId === messageId && hasStopFinish;
        let hasRenderedAnswerText = false;
        const isFinalLiveAnswer = isLastAssistantInTurn && hasStopFinish;
        const hasEarlierVisibleActivity = isFinalLiveAnswer && Boolean(turnGroupingContext?.activityParts?.some((activity) => {
            if (activity.messageId === messageId) {
                return false;
            }
            if (activity.part.type === 'tool') {
                return isToolRowShown(activity.part);
            }
            return showReasoningTraces && !isEmptyTextPart(activity.part);
        }));

        // Flat rendering: iterate parts in natural order.
        // Group consecutive static tools (read, grep, glob, etc.) into compact rows.
        // Expandable tools (bash, edit, task) get individual rows.
        // Text renders inline at its natural position.
        // A working turn with Activity collapsed shows only its latest rows;
        // the first rows of the message it cuts into are left out here.
        let rowsToSkip = activityRowSkip?.messageId === messageId ? activityRowSkip.rows : 0;
        let i = 0;
        while (i < visibleParts.length) {
            const part = visibleParts[i];
            if (rowsToSkip > 0 && isActivityRowPart(part)) {
                rowsToSkip -= 1;
                i += 1;
                continue;
            }
            rendered = splitLiveActivity && part.type !== 'text' ? activityRendered : answerRendered;

            if (part.type === 'text') {
                if (isFinalLiveAnswer && !hasRenderedAnswerText && (rendered.length > 0 || activityRendered.length > 0 || hasEarlierVisibleActivity || turnGroupingContext?.earlierAssistantText)) {
                    rendered.push(
                        <div
                            key={`final-answer-divider-${messageId}`}
                            aria-hidden="true"
                            className="mt-1.5 mb-3 h-px w-full bg-muted-foreground/20"
                        />
                    );
                }
                if (splitLiveActivity && !hasRenderedAnswerText) {
                    for (const pagePart of liveFinalActivity?.pages ?? []) {
                        rendered.push(<ShownToolCard key={`page-${pagePart.id}`} part={pagePart} />);
                    }
                }
                hasRenderedAnswerText = true;
                rendered.push(
                    <div key={`assistant-text-${messageId}-${i}`} ref={messageTextContentRef} data-message-text-export-source="true">
                        <AssistantTextPart
                            part={part}
                            sessionId={sessionId}
                            messageId={messageId}
                            streamPhase={effectiveStreamPhase}
                            onShowPopup={onShowPopup}
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
                // Empty reasoning draws nothing once it has ended, so it must
                // not count as content before the answer (no divider). While it
                // streams it stays mounted: ReasoningPart shows its busy header
                // before the first reasoning text arrives.
                const reasoningEnded = part.time?.end !== undefined
                    || (effectiveStreamPhase !== 'streaming' && effectiveStreamPhase !== 'cooldown');
                if (showReasoningTraces && !(reasoningEnded && isInvisibleText(part.text))) {
                    if (!collapsibleThinkingBlocks) {
                        // Non-collapsible mode: render thinking blocks as plain text inline.
                        rendered.push(
                            <AssistantTextPart
                                key={`reasoning-${messageId}-${i}`}
                                part={part}
                                sessionId={sessionId}
                                messageId={messageId}
                                streamPhase={effectiveStreamPhase}
                                onShowPopup={onShowPopup}
                            />
                        );
                    } else {
                        // Per-part mode: each reasoning block at its natural position.
                        rendered.push(
                            <ReasoningPart
                                key={`reasoning-${messageId}-${i}`}
                                part={part}
                                messageId={messageId}
                                streamPhase={effectiveStreamPhase}
                            />
                        );
                    }
                }
                i++;
                continue;
            }

            if (part.type === 'tool') {
                const toolPart = part as ToolPartType;
                const toolName = toolPart.tool?.toLowerCase() ?? '';

                // A session notice that landed during this step (see
                // `attachSyntheticContext`) draws as its own info row.
                const notice = readSessionNoticePart(toolPart);
                if (notice) {
                    rendered.push(
                        <FadeInOnReveal key={`notice-${toolPart.id}`}>
                            <SessionNoticeBlock notice={notice} blockId={toolPart.id} />
                        </FadeInOnReveal>
                    );
                    i++;
                    continue;
                }

                if (!isToolRowShown(toolPart)) {
                    i++;
                    continue;
                }

                // A page the agent showed, or a workflow it proposed, is drawn
                // in place of its row. With Activity collapsed, the final
                // answer draws it instead.
                if (isShownInPlace(toolPart.tool, toolPart.state)) {
                    if (!hoistedPages?.has(toolPart.id)) {
                        rendered.push(<ShownToolCard key={`page-${toolPart.id}`} part={toolPart} />);
                    }
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
                                    isMobile={isMobile}
                                    alwaysShowActions={alwaysShowMessageActions}
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

        if (splitLiveActivity && liveFinalActivity) {
            return [
                <LiveActivityCollapse key="final-message-activity" expanded={liveFinalActivity.expanded}
                    id={liveFinalActivity.contentId} animateOnMount={liveFinalActivity.animateCollapse}>
                    {activityRendered}
                </LiveActivityCollapse>,
                ...answerRendered,
            ];
        }
        return answerRendered;
    }, [
        activityRowSkip,
        alwaysShowMessageActions,
        hoistedPages,
        animatedToolIdsLookup,
        collapsibleThinkingBlocks,
        expandedTools,
        isMobile,
        liveFinalActivity,
        isLastAssistantInTurn,
        hasStopFinish,
        lastRenderableTextPartIndex,
        messageId,
        messageActionButtons,
        sessionId,
        onShowPopup,
        onToggleTool,
        shouldShowStandaloneMessageActions,
        effectiveStreamPhase,
        showReasoningTraces,
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
        void locale;
        const timestamp = typeof messageCompletedAt === 'number' && messageCompletedAt > 0
            ? messageCompletedAt
            : (typeof messageCreatedAt === 'number' && messageCreatedAt > 0 ? messageCreatedAt : null);
        if (timestamp === null) return null;

        const formatted = formatTimestampForDisplay(timestamp, timeFormatPreference);
        return formatted.length > 0 ? formatted : null;
    }, [messageCompletedAt, messageCreatedAt, timeFormatPreference, locale]);

    const footerTimestampClassName = 'text-sm text-muted-foreground/60 tabular-nums';

    // Touch surfaces have no hover, so the footer would have to show every
    // action at all times — four 36px targets that pushed the metadata onto its
    // own lines. Collapse them into one "more" button and a labelled sheet, the
    // same one the composer uses to pick a model. The buttons below stay the
    // pointer path; these rows call the same handlers, minus the transient
    // copied/sharing states that only make sense on a button that stays put.
    const [actionSheetOpen, setActionSheetOpen] = React.useState(false);
    const footerFactsRef = React.useRef<HTMLDivElement>(null);
    useFactsFit(footerFactsRef);
    const { isPlaying: isFooterTTSPlaying, play: playFooterTTS, stop: stopFooterTTS } = useMessageTTS(messageId);
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);

    // The pointer row shows copy, pin and the fork menu as buttons and keeps the
    // rest behind "more"; `onPointerRow` marks the ones the row already shows.
    const footerSheetActions = React.useMemo(() => {
        const actions: Array<{ id: string; label: string; icon: React.ReactNode; disabled?: boolean; onPointerRow?: true; onSelect: () => void }> = [];
        if (onCopyFooter) {
            actions.push({
                id: 'copy',
                onPointerRow: true,
                label: t('chat.messageBody.actions.copyAnswer'),
                icon: <Icon name="file-copy" className="h-4 w-4" />,
                disabled: !hasCopyableText,
                // The sheet closes on tap, so the button's own "copied" tick has
                // nowhere to land — say it with a toast instead.
                onSelect: () => {
                    void (async () => {
                        const copied = await onCopyFooter();
                        if (copied !== false) toast.success(t('chat.messageBody.toast.copied'));
                    })();
                },
            });
        }
        if (onCopyLink) {
            actions.push({
                id: 'copy-link',
                label: t('chat.messageBody.actions.copyLink'),
                icon: <Icon name="link" className="h-4 w-4" />,
                onSelect: onCopyLink,
            });
        }
        if (reviewTransferAction && !isMiniChatSurface) {
            actions.push({
                id: 'review-transfer',
                label: reviewTransferAction.tooltip,
                icon: <Icon name="arrow-left-right" className="h-3.5 w-3.5" />,
                disabled: !hasCopyableText,
                onSelect: () => { void reviewTransferAction.onClick(); },
            });
        }
        if (!isMiniChatSurface) {
            actions.push({
                id: 'share-image',
                label: t('chat.messageBody.actions.saveAsImage'),
                icon: <Icon name="image-download" className="h-3.5 w-3.5" />,
                disabled: !hasCopyableText,
                onSelect: () => { void shareTurnAsImage(); },
            });
        }
        if (!isMiniChatSurface && showMessageTTSButtons && hasCopyableText) {
            actions.push({
                id: 'tts',
                label: isFooterTTSPlaying ? t('chat.messageBody.tts.stopSpeaking') : t('chat.messageBody.tts.readAloud'),
                icon: <Icon name="volume-up" className={cn('h-4 w-4', isFooterTTSPlaying && 'text-[var(--primary-text)]')} />,
                onSelect: () => {
                    if (isFooterTTSPlaying) {
                        stopFooterTTS();
                        return;
                    }
                    if (assistantPlanText.trim()) void playFooterTTS(assistantPlanText);
                },
            });
        }
        if (canUseProjectPlanActions && !isReviewSessionView) {
            actions.push({
                id: 'save-as-plan',
                label: t('chat.messageBody.actions.saveAsPlan'),
                icon: <Icon name="booklet" className="h-3.5 w-3.5" />,
                disabled: !hasCopyableText || !currentProjectRef,
                onSelect: () => { handleSaveAsPlanClick(); },
            });
        }
        if (onToggleContextPin && hasCopyableText) {
            actions.push({
                id: 'pin-context',
                onPointerRow: true,
                label: t(contextPinned ? 'chat.messageBody.actions.unpinContext' : 'chat.messageBody.actions.pinContext'),
                icon: <Icon name={contextPinned ? 'pushpin-2-fill' : 'pushpin-2'} className="h-4 w-4" />,
                disabled: contextPinPending,
                onSelect: () => { onToggleContextPin(); },
            });
        }
        if (!isMiniChatSurface && !isReviewSessionView) {
            actions.push({
                id: 'fork-from-here',
                onPointerRow: true,
                label: t('chat.messageBody.actions.fork'),
                icon: <Icon name="git-branch" className="h-3.5 w-3.5" />,
                onSelect: handleForkFromHere,
            });
            actions.push({
                id: 'fork',
                onPointerRow: true,
                label: t('chat.messageBody.actions.startNewSession'),
                icon: <Icon name="chat-new" className="h-3.5 w-3.5" />,
                onSelect: () => { handleForkClick(); },
            });
        }
        if (!isMiniChatSurface) {
            for (const extra of extraActions ?? []) {
                actions.push({ id: extra.id, label: extra.label, icon: extra.icon, onSelect: extra.onSelect });
            }
        }
        return actions;
    }, [assistantPlanText, canUseProjectPlanActions, contextPinPending, contextPinned, currentProjectRef, extraActions, handleForkClick, handleForkFromHere, handleSaveAsPlanClick, hasCopyableText, isFooterTTSPlaying, isMiniChatSurface, isReviewSessionView, onCopyFooter, onCopyLink, onToggleContextPin, playFooterTTS, reviewTransferAction, shareTurnAsImage, showMessageTTSButtons, stopFooterTTS, t]);

    const footerMenuActions = footerSheetActions.filter((action) => !action.onPointerRow);

    const finalTurnActionButtons = (
        <>
            {onCopyFooter ? (
                <AssistantCopyButton hasCopyableText={hasCopyableText} isTouchContext={isTouchContext} onCopyMessage={onCopyFooter} />
            ) : null}
            {/* Reading starts from the "more" menu; stopping it should not mean
                hunting for it there again. */}
            {isFooterTTSPlaying ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-[var(--primary-text)] bg-transparent hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={t('chat.messageBody.tts.stopSpeaking')}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => { event.stopPropagation(); stopFooterTTS(); }}
                        >
                            <Icon name="volume-up" className="h-3 w-3 text-[var(--primary-text)]" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t('chat.messageBody.tts.stopSpeaking')}</TooltipContent>
                </Tooltip>
            ) : null}
            {!isMiniChatSurface && !isReviewSessionView ? (
                <DropdownMenu>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
                                    aria-label={t('chat.messageBody.actions.branchMenu')}
                                    onPointerDown={(event) => event.stopPropagation()}
                                >
                                    <Icon name="git-branch" className="h-3 w-3" />
                                </Button>
                            </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.branchMenu')}</TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="end" onPointerDown={(event) => event.stopPropagation()}>
                        <DropdownMenuItem className="typography-meta" onSelect={handleForkFromHere}>
                            <Icon name="git-branch" className="h-3.5 w-3.5" />
                            {t('chat.messageBody.actions.fork')}
                        </DropdownMenuItem>
                        <DropdownMenuItem className="typography-meta" onSelect={() => handleForkClick()}>
                            <Icon name="chat-new" className="h-3.5 w-3.5" />
                            {t('chat.messageBody.actions.startNewSession')}
                        </DropdownMenuItem>
                        {canShowMultiRunAction && turnGroupingContext?.turnId ? (
                            <DropdownMenuItem className="typography-meta" onSelect={handleAskOtherModels}>
                                <ArrowsMerge className="h-3.5 w-3.5" />
                                {t('chat.messageBody.actions.askOtherModels')}
                            </DropdownMenuItem>
                        ) : null}
                        {canShowMultiRunAction ? (
                            <DropdownMenuItem className="typography-meta" onSelect={handleForkMultiRun}>
                                <ArrowsMerge className="h-3.5 w-3.5" />
                                {t('chat.messageBody.actions.startNewMultiRun')}
                            </DropdownMenuItem>
                        ) : null}
                    </DropdownMenuContent>
                </DropdownMenu>
            ) : null}
            {onToggleContextPin && hasCopyableText ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={cn(
                                'h-6 w-6 bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring',
                                contextPinned ? 'text-[color:var(--status-info)]' : 'text-muted-foreground',
                            )}
                            disabled={contextPinPending}
                            aria-pressed={contextPinned}
                            aria-label={t(contextPinned ? 'chat.messageBody.actions.unpinContext' : 'chat.messageBody.actions.pinContext')}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => { event.stopPropagation(); onToggleContextPin(); }}
                        >
                            <Icon name={contextPinned ? 'pushpin-2-fill' : 'pushpin-2'} className="h-3 w-3" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t(contextPinned ? 'chat.messageBody.actions.unpinContext' : 'chat.messageBody.actions.pinContext')}</TooltipContent>
                </Tooltip>
            ) : null}
            {footerMenuActions.length > 0 ? (
                <DropdownMenu>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
                                    aria-label={t('chat.messageBody.actions.moreActions')}
                                    onPointerDown={(event) => event.stopPropagation()}
                                >
                                    <Icon name="more" className="h-3 w-3" />
                                </Button>
                            </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>{t('chat.messageBody.actions.moreActions')}</TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent align="end" onPointerDown={(event) => event.stopPropagation()}>
                        {footerMenuActions.map((action) => (
                            <DropdownMenuItem
                                key={action.id}
                                className="typography-meta"
                                disabled={action.disabled}
                                onSelect={() => action.onSelect()}
                            >
                                <span className="flex size-4 shrink-0 items-center justify-center">{action.icon}</span>
                                {action.label}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            ) : null}
            {askOtherModelsSession && turnGroupingContext?.turnId ? (
                <AskOtherModelsDialog
                    session={askOtherModelsSession}
                    turnUserMessageId={turnGroupingContext.turnId}
                    open
                    onOpenChange={(open) => { if (!open) setAskOtherModelsSession(null); }}
                />
            ) : null}
        </>
    );
 
      return (

         <div
              ref={messageContentRef}
              data-message-text-export-root="true"
              data-chat-quote-root="true"
              className={cn(
                 'relative w-full group/message'
             )}
              style={CONTAIN_LAYOUT_STYLE}
          >
              <TextSelectionMenu
                  containerRef={messageContentRef}
                  readingKey={messageId}
                  canReadAloud={!isMiniChatSurface && showMessageTTSButtons}
              />
             {canUseProjectPlanActions && isPlanDialogMounted ? (
                 <SaveProjectPlanDialog
                     open={isPlanDialogOpen}
                     onOpenChange={setIsPlanDialogOpen}
                     initialTitle={suggestedPlanTitle}
                     sourceText={assistantPlanText}
                     saving={isSavingPlan}
                     onSave={handleConfirmSaveAsPlan}
                 />
             ) : null}
             {isForkDialogOpen ? (
                 <ForkSessionDialog
                     open={isForkDialogOpen}
                     onOpenChange={setIsForkDialogOpen}
                     projectDirectory={effectiveDirectory ?? null}
                     sourceSessionId={sessionId ?? null}
                     worktreeProjectDirectory={sessionProjectRef?.path ?? null}
                     submitting={isForkSubmitting}
                     onConfirm={handleConfirmFork}
                 />
             ) : null}
              <div>
                 <div
                     className="message-content-text leading-relaxed overflow-hidden text-foreground/90 [&_p:last-child]:mb-0 [&_ul:last-child]:mb-0 [&_ol:last-child]:mb-0"
                 >
                    {renderedParts}
                    {showErrorMessage && (
                        <FadeInOnReveal key="assistant-error">
                            <div className="group/assistant-text relative mt-3 max-w-full break-words rounded-2xl bg-[var(--status-info-background)] px-4 py-3 text-base leading-relaxed">
                                <div className="flex items-center gap-3">
                                    <Icon name="information" className="size-4 shrink-0 text-[var(--status-info)]" />
                                    <div className="min-w-0 flex-1 break-words">
                                        <LongErrorText text={errorMessage ?? ''}>
                                            {(visibleText) => (
                                                <SimpleMarkdownRenderer
                                                    content={visibleText}
                                                    onShowPopup={onShowPopup}
                                                    className="[&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0"
                                                    enableFileReferences={false}
                                                />
                                            )}
                                        </LongErrorText>
                                    </div>
                                </div>
                                {errorResponseBody ? <ErrorResponseDetails body={errorResponseBody} className="mt-1 ps-7" /> : null}
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
                        className="mt-2 mb-1 flex flex-col gap-y-1.5"
                        style={MESSAGE_FOOTER_CONTAINER_STYLE}
                    >
                      <div className="flex items-center justify-between gap-2">
                        {/* One line, always. The facts are ordered by how much they
                            matter, and the CSS drops them from the tail as the row
                            narrows: first the time, then the agent, then the thinking
                            effort. Model and duration never leave — the model only
                            truncates once those two alone stop fitting. */}
                        <div ref={footerFactsRef} className="message-footer__facts whitespace-nowrap text-sm text-muted-foreground/60">
                            {footerModelName ? (
                                <span className="flex min-w-0 shrink items-center gap-1.5">
                                    {footerHasLogo && footerLogoSrc ? (
                                        <img
                                            src={footerLogoSrc}
                                            alt=""
                                            className="h-3.5 w-3.5 flex-shrink-0"
                                            style={{
                                                filter: isDarkTheme ? 'brightness(0.9) contrast(1.1) invert(1)' : 'brightness(0.9) contrast(1.1)',
                                            }}
                                            onError={handleFooterLogoError}
                                        />
                                    ) : (
                                        <AgentModelIcon agentName={footerAgentName} />
                                    )}
                                    <span data-fact-model className="truncate">{footerModelName}</span>
                                </span>
                            ) : null}
                            {footerVariant && !['default', 'none'].includes(footerVariant.toLowerCase()) ? (
                                <span data-fact-priority="3" className="message-footer__fact">
                                    <span className="opacity-60" aria-hidden>·</span>
                                    {footerVariant[0].toLowerCase() + footerVariant.slice(1)}
                                </span>
                            ) : null}
                            {footerAgentName ? (
                                <span data-fact-priority="2" className="message-footer__fact">
                                    <span className="opacity-60" aria-hidden>·</span>
                                    {footerAgentName}
                                </span>
                            ) : null}
                            {turnDurationText ? (
                                <span className="message-footer__fact tabular-nums">
                                    {footerModelName ? <span className="opacity-60" aria-hidden>·</span> : null}
                                    {turnDurationText}
                                </span>
                            ) : null}
                            {/* Pointer surfaces keep the timestamp inline (it is the first
                                fact the row gives up); touch reads it in the actions sheet,
                                where nothing can push it off the row. */}
                            {footerTimestamp && !(alwaysShowMessageActions || isTouchContext) ? (
                                <span
                                    data-fact-priority="1"
                                    className={cn(footerTimestampClassName, 'message-footer__fact')}
                                    aria-label={`Message time: ${footerTimestamp}`}
                                >
                                    <span className="opacity-60" aria-hidden>·</span>
                                    {footerTimestamp}
                                </span>
                            ) : null}
                        </div>
                        {alwaysShowMessageActions || isTouchContext ? (
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 shrink-0 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
                                aria-label={t('chat.messageBody.actions.moreActions')}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    setActionSheetOpen(true);
                                }}
                                data-message-action-group="true"
                            >
                                <Icon name="more" className="h-3.5 w-3.5" />
                            </Button>
                        ) : (
                            <div
                                className="flex shrink-0 items-center gap-1.5 pointer-events-none opacity-0 transition-opacity duration-150 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100 [&_button]:!h-[26px] [&_button]:!w-[26px] [&_svg]:!size-3.5"
                                data-message-action-group="true"
                            >
                                {finalTurnActionButtons}
                            </div>
                        )}
                      </div>
                        {/* Changed files keep their own line: they are a list that
                            grows, not a fact about the run. */}
                        {!isMiniChatSurface && isLastAssistantInTurn && hasStopFinish ? (
                            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                                <TurnChangedFilePills
                                    files={turnGroupingContext?.changedFiles}
                                    isInteractive={turnGroupingContext?.isLatestTurn === true}
                                />
                            </div>
                        ) : null}
                        <MobileOverlayPanel
                            open={actionSheetOpen}
                            onClose={() => setActionSheetOpen(false)}
                            title={t('chat.messageBody.actions.moreActions')}
                        >
                            <div className="flex flex-col">
                                {/* The row drops the timestamp first on a narrow screen,
                                    so the sheet is where it is always readable. */}
                                {footerTimestamp ? (
                                    <div className="mb-1 flex items-center gap-3 border-b border-border/60 px-3 pb-2 text-muted-foreground">
                                        <Icon name="time" className="h-4 w-4" />
                                        <span className="typography-ui-label">{footerTimestamp}</span>
                                    </div>
                                ) : null}
                                {footerSheetActions.map((action) => (
                                    <button
                                        key={action.id}
                                        type="button"
                                        disabled={action.disabled}
                                        className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-start text-foreground transition-colors active:bg-interactive-active disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                                        onClick={() => {
                                            setActionSheetOpen(false);
                                            action.onSelect();
                                        }}
                                        style={{ touchAction: 'manipulation' }}
                                    >
                                        <span className="text-muted-foreground">{action.icon}</span>
                                        <span className="typography-ui-label">{action.label}</span>
                                    </button>
                                ))}
                            </div>
                        </MobileOverlayPanel>
                    </div>
                )}

            </div>
        </div>
    );
});

function AgentModelIcon({ agentName }: { agentName: string | undefined }) {
    // Roster/color changes need to update this icon, not rerender the transcript body.
    const getAgentColor = useAgentColors();
    return <Icon name="brain-ai-3" className="h-3.5 w-3.5 flex-shrink-0" style={{ color: getAgentColor(agentName).color }} />;
}

const MessageBody = React.memo(({ isUser, ...props }: MessageBodyProps) => {

    if (isUser) {
        return (
            <UserMessageBody
                messageId={props.messageId}
                parts={props.parts}
                messageCreatedAt={props.messageCreatedAt}
                isMobile={props.isMobile}
                alwaysShowActions={props.alwaysShowActions}
                hasTouchInput={props.hasTouchInput}
                hasTextContent={props.hasTextContent}
                onCopyMessage={props.onCopyMessage}
                copiedMessage={props.copiedMessage}
                onShowPopup={props.onShowPopup}
                agentMention={props.agentMention}
                onRevert={props.onRevert}
                onFork={props.onFork}
                contextPinned={props.contextPinned}
                contextPinPending={props.contextPinPending}
                onToggleContextPin={props.onToggleContextPin}
                userMessagePart={props.userMessagePart}
                extraActions={props.extraActions}
                promptOrigin={props.promptOrigin}
            />
        );
    }

    return <AssistantMessageBody {...props} />;
});

export default MessageBody;

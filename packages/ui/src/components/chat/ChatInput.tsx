import React from 'react';
import { flushSync } from 'react-dom';
import { isCapacitorApp } from '@/lib/platform';
import { Textarea } from '@/components/ui/textarea';
import { ComposerDictation } from '@/components/dictation/ComposerDictation';
// sessionStore removed — currentSessionId comes from useSessionUIStore
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useInputStore } from '@/sync/input-store';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import * as sessionActions from '@/sync/session-actions';
import { useDirectorySync, useUserMessageHistory } from '@/sync/sync-context';
import { useInlineCommentDraftStore, type InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { appendInlineComments } from '@/lib/messages/inlineComments';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { startReviewFlow } from '@/lib/reviewFlow';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { ReviewFlowDialog, type ReviewFlowExecution } from '@/components/session/ReviewFlowDialog';
import { AttachedFilesList, AttachedVSCodeFileChips, ActiveEditorFileSuggestion } from './FileAttachment';
import ToolOutputDialog from './message/ToolOutputDialog';
import type { ToolPopupContent } from './message/types';
import { QueuedMessageChips } from './QueuedMessageChips';
import { AutoReviewBanner } from './AutoReviewBanner';
import { FileMentionAutocomplete, type FileMentionHandle } from './FileMentionAutocomplete';
import { CommandAutocomplete, type CommandAutocompleteHandle, type CommandInfo } from './CommandAutocomplete';
import { SkillAutocomplete, type SkillAutocompleteHandle } from './SkillAutocomplete';
import { SnippetAutocomplete, type SnippetAutocompleteHandle } from './SnippetAutocomplete';
import { cn, formatDirectoryName, isMacOS } from '@/lib/utils';
import { ModelControls } from './ModelControls';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { StatusRow } from './StatusRow';
import { PendingChangesBar } from './PendingChangesBar';
import { useChatSurfaceMode } from './useChatSurfaceMode';
import { MobileAgentButton } from './MobileAgentButton';
import { MobileModelButton } from './MobileModelButton';
import { MobileSessionStatusBar, MobileSessionPanelTrigger } from './MobileSessionStatusBar';
import { useCurrentSessionActivity } from '@/hooks/useSessionActivity';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
// useMessageStore removed — messages now come from sync system
import { isVSCodeRuntime } from '@/lib/desktop';
import { isIMECompositionEvent } from '@/lib/ime';
import { StopIcon } from '@/components/icons/StopIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getCycledPrimaryAgentName, type MobileControlsPanel } from './mobileControlsUtils';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { GitHubIssuePickerDialog } from '@/components/session/GitHubIssuePickerDialog';
import { GitHubPrPickerDialog } from '@/components/session/GitHubPrPickerDialog';
import { Icon } from "@/components/icon/Icon";
import { DraftPresetChips } from './DraftPresetChips';
import { useChatSearchDirectory } from '@/hooks/useChatSearchDirectory';
import { opencodeClient } from '@/lib/opencode/client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { useGitBranches, useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useCommandsStore } from '@/stores/useCommandsStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { createWorktreeDraft } from '@/lib/worktreeSessionCreator';
import { buildSessionTargetOptions } from '@/sync/session-worktree-contract';
import { usePermissionStore } from '@/stores/permissionStore';
import { extractGitChangedFiles } from './changedFiles';
import { useI18n } from '@/lib/i18n';
import { sessionEvents } from '@/lib/sessionEvents';
import { fetchResponseStyleInstruction } from '@/lib/responseStyle';
import { wrapSystemReminder } from '@/lib/systemReminder';
import { getSyncMessages } from '@/sync/sync-refs';
import { EMPTY_REVERTED_MESSAGE_DOCK_STATE, buildRevertedMessageDockState, type RevertedMessageDockState } from './revertedMessageDockState';
import { eventMatchesShortcut, getEffectiveShortcutCombo, normalizeCombo } from '@/lib/shortcuts';
import { isSyntheticPart } from '@/lib/messages/synthetic';
import {
    buildHighlightParts,
    mentionRangesToHighlightRanges,
    tokenizeMarkdown,
    type HighlightRange,
    type MentionRange,
} from './composerHighlight';
import { highlightFencedCode } from './composerCodeHighlight';
import {
    assignImageAttachmentFilenames,
    buildAttachmentCitationText,
    findAttachmentCitationRanges,
} from './attachmentCitations';
import { getFileMentionAutocompleteQuery, type FileMentionAutocompleteInputSource } from './fileMentionAutocompleteState';
import { SessionSuggestionChip } from '@/components/chat/SessionSuggestionChip';
import type { Part } from '@opencode-ai/sdk/v2/client';

const MAX_VISIBLE_TEXTAREA_LINES = 8;
const EMPTY_QUEUE: QueuedMessage[] = [];
const FILE_MENTION_TOKEN = /^@[^\s]+$/;
// Single-line URL pasted over a selection becomes a markdown link.
const PASTE_LINK_URL_PATTERN = /^(https?:\/\/|mailto:)\S+$/i;
const INLINE_SKILL_TOKEN_PATTERN = /(^|\s)\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)/g;
const CHAT_DRAFT_PERSIST_DEBOUNCE_MS = 500;
const COMPACT_CHAT_PLACEHOLDER_MAX_WIDTH = 560;
const VS_CODE_DROP_DATA_TYPES = [
    'CodeFiles',
    'codefiles',
    'application/vnd.code.tree',
    'application/vnd.code.tree.explorer',
    'text/uri-list',
    'text/plain',
];

const renameFileForAttachmentCitation = (file: File, filename: string): File => {
    if (file.name === filename) {
        return file;
    }

    return new File([file], filename, {
        type: file.type,
        lastModified: file.lastModified,
    });
};

const buildImagePasteInsertion = (pastedText: string, citationText: string): string => {
    const text = pastedText;
    if (!text) {
        return citationText;
    }
    return `${text}${/\s$/.test(text) ? '' : ' '}${citationText}`;
};

const getInsertedTextFromChange = (previousValue: string, nextValue: string): string => {
    if (previousValue === nextValue) {
        return '';
    }

    let prefixLength = 0;
    while (
        prefixLength < previousValue.length
        && prefixLength < nextValue.length
        && previousValue[prefixLength] === nextValue[prefixLength]
    ) {
        prefixLength += 1;
    }

    let previousSuffix = previousValue.length;
    let nextSuffix = nextValue.length;
    while (
        previousSuffix > prefixLength
        && nextSuffix > prefixLength
        && previousValue[previousSuffix - 1] === nextValue[nextSuffix - 1]
    ) {
        previousSuffix -= 1;
        nextSuffix -= 1;
    }

    return nextValue.slice(prefixLength, nextSuffix);
};

const getFileMentionInputSourceForInsertedText = (insertedText: string): FileMentionAutocompleteInputSource => (
    insertedText.includes('@') ? 'paste' : 'manual'
);

const withInlineInsertionBoundaries = (content: string, before: string, after: string): string => {
    if (!content) {
        return content;
    }

    const needsLeadingSpace = before.length > 0
        && !/\s$/.test(before)
        && !/^\s/.test(content)
        && !/[([{]$/.test(before);
    const needsTrailingSpace = after.length > 0
        && !/\s$/.test(content)
        && !/^\s/.test(after)
        && !/^[\])}.,;:!?]/.test(after);

    return `${needsLeadingSpace ? ' ' : ''}${content}${needsTrailingSpace ? ' ' : ''}`;
};

const collectInlineSkillMentions = (text: string, skillNames: Set<string>): string[] => {
    const mentions: string[] = [];
    INLINE_SKILL_TOKEN_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_SKILL_TOKEN_PATTERN.exec(text)) !== null) {
        const name = match[2] || '';
        if (!skillNames.has(name) || mentions.includes(name)) {
            continue;
        }
        mentions.push(name);
    }
    return mentions;
};

const buildSkillMentionInstruction = (skillNames: string[]): string | null => {
    if (skillNames.length === 0) return null;
    const formatted = skillNames.map((name) => `/${name}`).join(', ');
    return `The user explicitly mentioned these skills in their message: ${formatted}. Use the corresponding skill tool when it is relevant to accomplishing the user's request.`;
};

const hasUserMessages = (sessionId: string, directory?: string) => {
    return getSyncMessages(sessionId, directory).some((message) => message.role === 'user');
};

const getRevertedPreview = (parts: Part[], fallback: string): string => {
    const text = parts
        .filter((part) => part.type === 'text' && !isSyntheticPart(part))
        .map((part) => {
            const record = part as Record<string, unknown>;
            return typeof record.text === 'string'
                ? record.text
                : typeof record.content === 'string'
                    ? record.content
                    : '';
        })
        .join('\n')
        .replace(/\s+/g, ' ')
        .trim();

    if (text) return text;
    const filePart = parts.find((part) => part.type === 'file') as (Part & { filename?: string }) | undefined;
    return filePart?.filename ? `[${filePart.filename}]` : fallback;
};

const FILE_URI_PREFIX = 'file://';

const encodeFilePath = (filepath: string): string => {
    let normalized = filepath.replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(normalized)) {
        normalized = `/${normalized}`;
    }
    return normalized
        .split('/')
        .map((segment, index) => {
            if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment;
            return encodeURIComponent(segment);
        })
        .join('/');
};

const toServerFileUrl = (filepath: string): string => {
    const normalized = filepath.replace(/\\/g, '/').trim();
    if (normalized.toLowerCase().startsWith(FILE_URI_PREFIX)) {
        return normalized;
    }
    return `file://${encodeFilePath(normalized)}`;
};

const isLikelyAbsolutePath = (value: string): boolean => (
    value.startsWith('/')
    || value.startsWith('\\\\')
    || /^[A-Za-z]:[\\/]/.test(value)
);

const toLikelyFileDropReference = (value: string): string | null => {
    const trimmed = value.trim().replace(/^['"]+|['"]+$/g, '');
    if (!trimmed) {
        return null;
    }

    if (/[\r\n]/.test(trimmed)) {
        return null;
    }

    if (trimmed.toLowerCase().startsWith(FILE_URI_PREFIX)) {
        return trimmed;
    }

    if (isLikelyAbsolutePath(trimmed)) {
        return trimmed;
    }

    return null;
};

const collectStringLeaves = (input: unknown, output: Set<string>, depth = 0): void => {
    if (depth > 6 || input == null) {
        return;
    }

    if (typeof input === 'string') {
        output.add(input);
        return;
    }

    if (Array.isArray(input)) {
        for (const item of input) {
            collectStringLeaves(item, output, depth + 1);
        }
        return;
    }

    if (typeof input !== 'object') {
        return;
    }

    for (const value of Object.values(input)) {
        collectStringLeaves(value, output, depth + 1);
    }
};

const parseDroppedFileReferences = (rawPayload: string): string[] => {
    const extracted = new Set<string>();

    const addCandidatesFromText = (value: string): void => {
        const direct = toLikelyFileDropReference(value);
        if (direct) {
            extracted.add(direct);
            return;
        }

        for (const line of value.split(/\r?\n/)) {
            const candidate = toLikelyFileDropReference(line);
            if (candidate) {
                extracted.add(candidate);
            }
        }
    };

    addCandidatesFromText(rawPayload);

    try {
        const parsed = JSON.parse(rawPayload) as unknown;
        const leaves = new Set<string>();
        collectStringLeaves(parsed, leaves);
        for (const leaf of leaves) {
            addCandidatesFromText(leaf);
        }
    } catch {
        // Ignore non-JSON payloads.
    }

    return Array.from(extracted);
};

const normalizePath = (value?: string | null): string | null => {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const normalized = trimmed.replace(/\\/g, '/');
    if (normalized === '/') {
        return '/';
    }
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const getProjectDisplayLabel = (project: { label?: string; path: string }): string => {
    const label = project.label?.trim();
    if (label) {
        return label;
    }
    return formatDirectoryName(project.path);
};

const renderDraftTitle = (title: string, projectLabel: string | null): React.ReactNode => {
    if (!projectLabel) return title;
    const projectIndex = title.indexOf(projectLabel);
    if (projectIndex === -1) return title;

    return (
        <>
            {title.slice(0, projectIndex)}
            <span className="font-medium">{projectLabel}</span>
            {title.slice(projectIndex + projectLabel.length)}
        </>
    );
};

const getProjectIconColor = (projectColor?: string | null): string | undefined => {
    if (!projectColor) {
        return undefined;
    }
    return PROJECT_COLOR_MAP[projectColor] ?? undefined;
};

const MemoModelControls = React.memo(ModelControls);
const MemoComposerDictation = React.memo(ComposerDictation);
const MemoMobileAgentButton = React.memo(MobileAgentButton);
const MemoMobileModelButton = React.memo(MobileModelButton);
const MemoStatusRow = React.memo(StatusRow);

type RevertedMessageDockProps = {
    sessionId: string | null;
    directory?: string;
};

const RevertedMessageDock: React.FC<RevertedMessageDockProps> = React.memo(({ sessionId, directory }) => {
    const { t } = useI18n();
    const revertToMessage = useSessionUIStore((s) => s.revertToMessage);
    const forkFromMessage = useSessionUIStore((s) => s.forkFromMessage);
    const handleSlashRedo = useSessionUIStore((s) => s.handleSlashRedo);
    const [restoringId, setRestoringId] = React.useState<string | null>(null);
    const [forkingId, setForkingId] = React.useState<string | null>(null);
    const [collapsed, setCollapsed] = React.useState(true);
    const revertedStateRef = React.useRef<RevertedMessageDockState>(EMPTY_REVERTED_MESSAGE_DOCK_STATE);
    const revertedState = useDirectorySync(
        React.useCallback((state) => {
            const next = buildRevertedMessageDockState(state, sessionId, revertedStateRef.current);
            revertedStateRef.current = next;
            return next;
        }, [sessionId]),
        directory,
    );
    const revertMessageID = revertedState.revertMessageID;
    const userMessages = React.useMemo(
        () => revertedState.records.map((record) => record.message),
        [revertedState],
    );
    const noTextContent = t('chat.revertPopover.noTextContent');
    const items = React.useMemo(() => {
        if (!revertMessageID) return [];
        return revertedState.records.map((record) => ({
            id: record.message.id,
            text: getRevertedPreview(record.parts, noTextContent),
        }));
    }, [noTextContent, revertMessageID, revertedState]);
    const firstRevertedMessageId = items[0]?.id;

    React.useEffect(() => {
        setCollapsed(true);
    }, [revertMessageID, firstRevertedMessageId]);

    const handleRestore = React.useCallback(async (messageId: string) => {
        if (!sessionId || restoringId) return;
        setRestoringId(messageId);
        try {
            const nextMessage = userMessages.find((message) => message.id > messageId);
            if (nextMessage) {
                await revertToMessage(sessionId, nextMessage.id, { skipRedoPush: true });
            } else {
                await handleSlashRedo(sessionId, { fullUnrevert: true });
            }
        } finally {
            setRestoringId(null);
        }
    }, [handleSlashRedo, revertToMessage, restoringId, sessionId, userMessages]);

    const handleFork = React.useCallback(async (messageId: string) => {
        if (!sessionId || forkingId) return;
        setForkingId(messageId);
        try {
            await forkFromMessage(sessionId, messageId);
        } finally {
            setForkingId(null);
        }
    }, [forkFromMessage, forkingId, sessionId]);

    if (!sessionId || items.length === 0) return null;

    return (
        <div className="pb-2 w-full px-1">
            <div className="rounded-xl border border-border/60 bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)] shadow-sm overflow-hidden">
                <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--interactive-hover)] transition-colors"
                    onClick={() => setCollapsed((value) => !value)}
                    aria-expanded={!collapsed}
                >
                    <span className="typography-ui-label font-medium text-foreground flex-shrink-0">
                        {t('chat.revertPopover.title')} messages {items.length}
                    </span>
                    <Icon
                        name="arrow-down-s"
                        className={cn("ml-auto h-4 w-4 text-muted-foreground transition-transform", !collapsed && "rotate-180")}
                        aria-hidden="true"
                    />
                </button>
                {!collapsed && (
                    <div className="px-3 pb-3 flex flex-col gap-1.5 max-h-[10.5rem] overflow-y-auto">
                        {items.map((item) => (
                            <div key={item.id} className="flex min-w-0 items-center gap-2 py-1">
                                <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
                                    {item.text}
                                </span>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="xs"
                                    disabled={Boolean(restoringId || forkingId)}
                                    onClick={() => { void handleFork(item.id); }}
                                >
                                    {forkingId === item.id ? (
                                        <Icon name="loader-4" className="h-3 w-3 animate-spin" aria-hidden="true" />
                                    ) : (
                                        <Icon name="git-branch" className="h-3 w-3" aria-hidden="true" />
                                    )}
                                    {t('chat.revertPopover.fork')}
                                </Button>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="xs"
                                    disabled={Boolean(restoringId || forkingId)}
                                    onClick={() => { void handleRestore(item.id); }}
                                >
                                    {restoringId === item.id ? (
                                        <Icon name="loader-4" className="h-3 w-3 animate-spin" aria-hidden="true" />
                                    ) : (
                                        <Icon name="arrow-go-forward" className="h-3 w-3" aria-hidden="true" />
                                    )}
                                    {t('chat.revertPopover.restore')}
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
});

RevertedMessageDock.displayName = 'RevertedMessageDock';

type ComposerAttachmentControlsProps = {
    isVSCode: boolean;
    footerIconButtonClass: string;
    iconSizeClass: string;
    handlePickLocalFiles: () => void;
    openIssuePicker: () => void;
    openPrPicker: () => void;
    onOpenSettings?: () => void;
    onMenuOpenChange?: (open: boolean) => void;
    /** Mobile: open the attachment bottom sheet instead of the dropdown menu. */
    onOpenMobileSheet?: () => void;
};

const ComposerAttachmentControls = React.memo(function ComposerAttachmentControls(props: ComposerAttachmentControlsProps) {
    const { t } = useI18n();
    const {
        isVSCode,
        footerIconButtonClass,
        iconSizeClass,
        handlePickLocalFiles,
        openIssuePicker,
        openPrPicker,
        onOpenSettings,
    } = props;

    return (
        <div className="flex items-center gap-x-1.5">
            <div className="relative inline-flex">
                {props.onOpenMobileSheet ? (
                    <button
                        type="button"
                        className={footerIconButtonClass}
                        onClick={props.onOpenMobileSheet}
                        // Same guard as PermissionAutoAcceptButton: keep the tap
                        // from dismissing the keyboard. On Android's
                        // resizes-content viewport the keyboard-close relayout
                        // moves this button mid-tap and the click never lands.
                        onMouseDown={(event) => event.preventDefault()}
                        onPointerDownCapture={(event) => {
                            if (event.pointerType === 'touch') {
                                event.preventDefault();
                            }
                        }}
                        title={t('chat.chatInput.actions.addAttachment')}
                        aria-label={t('chat.chatInput.actions.addAttachment')}
                    >
                        <Icon name="add-circle" className={cn(iconSizeClass, 'text-current')} />
                    </button>
                ) : isVSCode ? (
                    <button
                        type="button"
                        className={footerIconButtonClass}
                        onClick={handlePickLocalFiles}
                        title={t('chat.chatInput.actions.attachFiles')}
                        aria-label={t('chat.chatInput.actions.attachFiles')}
                    >
                        <Icon name="attachment-2" className={cn(iconSizeClass, 'text-current')} />
                    </button>
                ) : (
                    <DropdownMenu onOpenChange={props.onMenuOpenChange}>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                className={footerIconButtonClass}
                                title={t('chat.chatInput.actions.addAttachment')}
                                aria-label={t('chat.chatInput.actions.addAttachment')}
                            >
                                <Icon name="add-circle" className={cn(iconSizeClass, 'text-current')} />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            <DropdownMenuItem
                                onSelect={() => {
                                    requestAnimationFrame(handlePickLocalFiles);
                                }}
                            >
                                <Icon name="attachment-2"/>
                                {t('chat.chatInput.actions.attachFiles')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onSelect={() => {
                                    requestAnimationFrame(openIssuePicker);
                                }}
                            >
                                <Icon name="github"/>
                                {t('chat.chatInput.actions.linkGithubIssue')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onSelect={() => {
                                    requestAnimationFrame(openPrPicker);
                                }}
                            >
                                <Icon name="git-pull-request"/>
                                {t('chat.chatInput.actions.linkGithubPr')}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>

            {onOpenSettings ? (
                <button
                    type="button"
                    onClick={onOpenSettings}
                    className={footerIconButtonClass}
                    title={t('chat.chatInput.actions.modelAgentSettings')}
                    aria-label={t('chat.chatInput.actions.modelAgentSettings')}
                >
                    <Icon name="ai-agent" className={cn(iconSizeClass, 'text-current')} />
                </button>
            ) : null}
        </div>
    );
}, (prev, next) => (
    prev.isVSCode === next.isVSCode
    && prev.footerIconButtonClass === next.footerIconButtonClass
    && prev.iconSizeClass === next.iconSizeClass
    && prev.onOpenSettings === next.onOpenSettings
    && prev.onMenuOpenChange === next.onMenuOpenChange
    && prev.onOpenMobileSheet === next.onOpenMobileSheet
));

type PermissionAutoAcceptButtonProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    permissionScopeSessionId: string | null;
    permissionAutoAcceptEnabled: boolean;
    handlePermissionAutoAcceptToggle: () => void;
    withTooltip?: boolean;
};

const PermissionAutoAcceptButton = React.memo(function PermissionAutoAcceptButton(props: PermissionAutoAcceptButtonProps) {
    const { t } = useI18n();
    const {
        footerIconButtonClass,
        iconSizeClass,
        permissionScopeSessionId,
        permissionAutoAcceptEnabled,
        handlePermissionAutoAcceptToggle,
        withTooltip = false,
    } = props;

    const ariaLabel = permissionAutoAcceptEnabled
        ? t('chat.chatInput.permissionAutoAccept.disable')
        : t('chat.chatInput.permissionAutoAccept.enable');
    const tooltipLabel = permissionAutoAcceptEnabled
        ? t('chat.chatInput.permissionAutoAccept.on')
        : t('chat.chatInput.permissionAutoAccept.off');

    const button = (
        <button
            type="button"
            onClick={handlePermissionAutoAcceptToggle}
            className={cn(
                footerIconButtonClass,
                'rounded-md hover:bg-transparent',
                !permissionScopeSessionId && 'opacity-30',
            )}
            onMouseDown={(event) => {
                event.preventDefault();
            }}
            onPointerDownCapture={(event) => {
                if (event.pointerType === 'touch') {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }}
            aria-pressed={permissionAutoAcceptEnabled}
            aria-label={ariaLabel}
            title={ariaLabel}
        >
            {permissionAutoAcceptEnabled ? (
                <Icon name="shield-check" className={cn(iconSizeClass)} style={{ color: 'var(--status-info)' }} />
            ) : (
                <Icon name="shield-user" className={cn(iconSizeClass)} />
            )}
        </button>
    );

    if (!withTooltip) {
        return button;
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                {button}
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
                {tooltipLabel}
            </TooltipContent>
        </Tooltip>
    );
});

type FocusModeButtonProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    isExpandedInput: boolean;
    onToggle: () => void;
};

const FocusModeButton = React.memo(function FocusModeButton(props: FocusModeButtonProps) {
    const { footerIconButtonClass, iconSizeClass, isExpandedInput, onToggle } = props;
    const { t } = useI18n();

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        footerIconButtonClass,
                        'rounded-md',
                        isExpandedInput
                            ? 'text-primary'
                            : 'text-foreground hover:bg-[var(--interactive-hover)]/40'
                    )}
                    onMouseDown={(event) => {
                        event.preventDefault();
                    }}
                    onClick={onToggle}
                    aria-label={t('chat.chatInput.focusMode.toggleAria')}
                    aria-pressed={isExpandedInput}
                >
                    <Icon name="fullscreen" className={cn(iconSizeClass)} />
                </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
                <div className="flex flex-col gap-0.5 text-center">
                    <span>{t('chat.chatInput.focusMode.label')}</span>
                    <span className="font-mono opacity-60">
                        {isMacOS() ? '⌘⇧E' : 'Ctrl+Shift+E'}
                    </span>
                </div>
            </TooltipContent>
        </Tooltip>
    );
});

type ComposerActionButtonsProps = {
    isMobile: boolean;
    footerIconButtonClass: string;
    sendIconSizeClass: string;
    stopIconSizeClass: string;
    canSend: boolean;
    canAbort: boolean;
    hasContent: boolean;
    currentSessionId: string | null;
    newSessionDraftOpen: boolean;
    onPrimaryAction: () => void;
    onQueueMessage: () => void;
    onAbort: () => void;
};

const ComposerActionButtons = React.memo(function ComposerActionButtons(props: ComposerActionButtonsProps) {
    const {
        isMobile,
        footerIconButtonClass,
        sendIconSizeClass,
        stopIconSizeClass,
        canSend,
        canAbort,
        hasContent,
        currentSessionId,
        newSessionDraftOpen,
        onPrimaryAction,
        onQueueMessage,
        onAbort,
    } = props;
    const { t } = useI18n();

    const sendButton = (
        <button
            type={isMobile ? 'button' : 'submit'}
            disabled={!canSend || (!currentSessionId && !newSessionDraftOpen)}
            onClick={(event) => {
                if (!isMobile) {
                    return;
                }

                event.preventDefault();
                onPrimaryAction();
            }}
            className={cn(
                footerIconButtonClass,
                canSend && (currentSessionId || newSessionDraftOpen)
                    ? 'text-primary hover:text-primary'
                    : 'opacity-30'
            )}
            aria-label={t('chat.chatInput.actions.sendMessageAria')}
        >
            <Icon name="send-plane-2" className={cn(sendIconSizeClass)} />
        </button>
    );

    if (!canAbort) {
        return sendButton;
    }

    return (
        <div className="relative">
            {hasContent ? (
                <button
                    type="button"
                    disabled={!currentSessionId}
                    onClick={(event) => {
                        if (isMobile) {
                            event.preventDefault();
                        }
                        onQueueMessage();
                    }}
                    className={cn(
                        footerIconButtonClass,
                        'absolute z-20 bottom-full left-1/2 -translate-x-1/2 mb-1',
                        currentSessionId ? 'text-primary hover:text-primary' : 'opacity-30'
                    )}
                    aria-label={t('chat.chatInput.actions.queueMessageAria')}
                >
                    <Icon name="send-plane-2" className={cn(sendIconSizeClass, '-rotate-90')} />
                </button>
            ) : null}
            <button
                type="button"
                onClick={onAbort}
                className={cn(
                    footerIconButtonClass,
                    'text-[var(--status-error)] hover:text-[var(--status-error)]'
                )}
                aria-label={t('chat.chatInput.actions.stopGeneratingAria')}
            >
                <StopIcon className={cn(stopIconSizeClass)} />
            </button>
        </div>
    );
}, (prev, next) => (
    prev.isMobile === next.isMobile
    && prev.footerIconButtonClass === next.footerIconButtonClass
    && prev.sendIconSizeClass === next.sendIconSizeClass
    && prev.stopIconSizeClass === next.stopIconSizeClass
    && prev.canSend === next.canSend
    && prev.canAbort === next.canAbort
    && prev.hasContent === next.hasContent
    && prev.currentSessionId === next.currentSessionId
    && prev.newSessionDraftOpen === next.newSessionDraftOpen
    && prev.onPrimaryAction === next.onPrimaryAction
    && prev.onQueueMessage === next.onQueueMessage
    && prev.onAbort === next.onAbort
));

const appendWithLineBreaks = (base: string, next: string): string => {
    const separator = !base
        ? ''
        : base.endsWith('\n\n')
            ? ''
            : base.endsWith('\n')
                ? '\n'
                : '\n\n';

    const nextWithTrailingBreaks = next.endsWith('\n\n')
        ? next
        : next.endsWith('\n')
            ? `${next}\n`
            : `${next}\n\n`;

    return `${base}${separator}${nextWithTrailingBreaks}`;
};

const appendInlineText = (base: string, next: string): string => {
    const nextTrimmed = next.trim();
    if (!nextTrimmed) {
        return base;
    }
    if (!base) {
        return `${nextTrimmed} `;
    }
    const separator = /[\s\n]$/.test(base) ? '' : ' ';
    return `${base}${separator}${nextTrimmed} `;
};

interface ChatInputProps {
    onOpenSettings?: () => void;
    scrollToBottom?: () => void;
}

type AutocompleteOverlayPosition = {
    top: number;
    left: number;
    place: 'above' | 'below';
    maxHeight: number;
};

// Per-session draft key — preserves in-progress messages across project switches
const getDraftKey = (sessionId: string | null): string =>
    `openchamber_chat_input_draft_${sessionId ?? 'new'}`;

// Helper to safely read from localStorage for a given session
const getStoredDraft = (sessionId: string | null): string => {
    try {
        return localStorage.getItem(getDraftKey(sessionId)) ?? '';
    } catch {
        return '';
    }
};

// Helper to safely write/clear a per-session draft
const saveStoredDraft = (sessionId: string | null, draft: string): void => {
    try {
        if (draft) {
            localStorage.setItem(getDraftKey(sessionId), draft);
        } else {
            localStorage.removeItem(getDraftKey(sessionId));
        }
    } catch {
        // Ignore localStorage errors
    }
};

// Per-session confirmed mentions key — tracks which @mentions are confirmed (blue) vs plain text
const getConfirmedMentionsKey = (sessionId: string | null): string =>
    `openchamber_chat_confirmed_mentions_${sessionId ?? 'new'}`;

const saveConfirmedMentions = (sessionId: string | null, mentions: Set<string>): void => {
    try {
        if (mentions.size > 0) {
            localStorage.setItem(getConfirmedMentionsKey(sessionId), JSON.stringify([...mentions]));
        } else {
            localStorage.removeItem(getConfirmedMentionsKey(sessionId));
        }
    } catch {
        // Ignore localStorage errors
    }
};

const loadConfirmedMentions = (sessionId: string | null): Set<string> => {
    try {
        const raw = localStorage.getItem(getConfirmedMentionsKey(sessionId));
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return new Set(parsed.filter((v): v is string => typeof v === 'string'));
            }
        }
    } catch {
        // Ignore localStorage errors
    }
    return new Set();
};

const ChatInputComponent: React.FC<ChatInputProps> = ({ onOpenSettings, scrollToBottom }) => {
    const { t } = useI18n();
    // Track if we restored a draft on mount (for text selection)
    const initialDraftRef = React.useRef<string | null>(null);
    // Track initial session ID (captured at mount time for draft restoration)
    const initialSessionIdRef = React.useRef<string | null>(null);
    const [message, setMessage] = React.useState(() => {
        // Read per-session draft at mount time using the current session from the store
        const sessionId = useSessionUIStore.getState().currentSessionId;
        initialSessionIdRef.current = sessionId;
        const draft = getStoredDraft(sessionId);
        if (draft) {
            initialDraftRef.current = draft;
        }
        return draft;
    });
    // Restore confirmed mentions from localStorage on mount
    const confirmedMentionsRef = React.useRef<Set<string>>(loadConfirmedMentions(initialSessionIdRef.current));
    // Helper: check if a mention path looks like a file/folder (has path separators, extension, or was explicitly confirmed)
    const isConfirmedFilePath = (text: string): boolean =>
        text.includes('/') || text.includes('\\') || text.includes('.') || confirmedMentionsRef.current.has(text);
    const [inputMode, setInputMode] = React.useState<'normal' | 'shell'>('normal');
    const [isDragging, setIsDragging] = React.useState(false);
    const [isInternalDrag, setIsInternalDrag] = React.useState(false);
    const [showFileMention, setShowFileMention] = React.useState(false);
    const [mentionQuery, setMentionQuery] = React.useState('');
    const [showCommandAutocomplete, setShowCommandAutocomplete] = React.useState(false);
    const [commandQuery, setCommandQuery] = React.useState('');
    const [showSkillAutocomplete, setShowSkillAutocomplete] = React.useState(false);
    const [skillQuery, setSkillQuery] = React.useState('');
    const [showSnippetAutocomplete, setShowSnippetAutocomplete] = React.useState(false);
    const [snippetQuery, setSnippetQuery] = React.useState('');
    const [textareaSize, setTextareaSize] = React.useState<{ height: number; maxHeight: number } | null>(null);
    const [mobileControlsPanel, setMobileControlsPanel] = React.useState<MobileControlsPanel>(null);
    // Mobile pill composer: when the keyboard is closed the composer collapses
    // into a narrow pill (+ / placeholder / mic) with a round new-session button
    // beside it. Any interaction expands back into the full composer. The swap
    // is deliberately INSTANT and synchronized with the keyboard choreography,
    // so the chat compensates keyboard + composer height in a single motion.
    const [mobileComposerExpanded, setMobileComposerExpanded] = React.useState(false);
    const [mobileTextareaFocused, setMobileTextareaFocused] = React.useState(false);
    // Mobile browser / installed PWA: tapping a composer control while the
    // keyboard is up blurs the textarea first, and the keyboard-resize reflow
    // moves the control out from under the finger BEFORE the browser
    // synthesizes the click — the tap dismisses the keyboard but the control's
    // onClick never fires. Defer the blur-driven state flip so the pinned
    // composer holds still through the tap; a refocus cancels it. Capacitor
    // keeps the immediate flip.
    const mobileBlurTimerRef = React.useRef<number | null>(null);
    React.useEffect(() => () => {
        if (mobileBlurTimerRef.current !== null) {
            window.clearTimeout(mobileBlurTimerRef.current);
        }
    }, []);
    const [mobileDictationActive, setMobileDictationActive] = React.useState(false);
    const [mobileAttachMenuOpen, setMobileAttachMenuOpen] = React.useState(false);
    const [mobileDraftPicker, setMobileDraftPicker] = React.useState<'project' | 'branch' | null>(null);
    const [mobileDraftPickerQuery, setMobileDraftPickerQuery] = React.useState('');
    // True while ANY MobileOverlayPanel is open (sessions sheet, model/agent
    // panels, pickers...). Opening one closes the keyboard, which must not
    // collapse the composer into the pill under the overlay.
    const [mobileOverlayHostBusy, setMobileOverlayHostBusy] = React.useState(false);
    // Set while an expansion is settling (focus/dictation not yet active) so the
    // collapse watcher doesn't immediately fold the composer back into the pill.
    const mobileExpandIntentRef = React.useRef<'focus' | null>(null);
    // Keyboard restore across overlays: opening an overlay closes the keyboard;
    // if it was open at that moment, reopen it when the overlay closes.
    const lastMobileBlurAtRef = React.useRef(0);
    const restoreKeyboardAfterOverlayRef = React.useRef(false);
    // Pill ↔ full composer morph: the wrapper FLIP-animates its height between
    // the two shapes while the swapped content fades in.
    const composerHandleTouchRef = React.useRef<{ startY: number; fired: boolean } | null>(null);
    // Message history navigation state (up/down arrow to recall previous messages)
    const [historyIndex, setHistoryIndex] = React.useState(-1); // -1 = not browsing, 0+ = index from most recent
    const [draftMessage, setDraftMessage] = React.useState(''); // Preserves input when entering history mode
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const cursorPosRef = React.useRef(0);
    const previousMessageLengthRef = React.useRef(message.length);
    const dropZoneRef = React.useRef<HTMLDivElement>(null);
    const dragEnterCountRef = React.useRef(0);
    const suppressNextFileDropTextInsertRef = React.useRef(false);
    const suppressNextFileDropTextInsertTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const suppressNextFileMentionPasteRef = React.useRef(false);
    const suppressNextFileMentionPasteTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingDroppedAbsolutePathsRef = React.useRef<string[]>([]);
    const canAcceptDropRef = React.useRef(false);
    const mentionRef = React.useRef<FileMentionHandle>(null);
    const commandRef = React.useRef<CommandAutocompleteHandle>(null);
    const skillRef = React.useRef<SkillAutocompleteHandle>(null);
    const snippetRef = React.useRef<SnippetAutocompleteHandle>(null);
    // Ref to track current message value without triggering re-renders in effects
    const messageRef = React.useRef(message);
    const draftPersistTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const skipNextDraftPersistRef = React.useRef(false);
    const lastPersistedDraftRef = React.useRef<Map<string, string>>(new Map());
    const currentSessionIdForDraftRef = React.useRef<string | null>(null);
    const pendingPastedAttachmentFilenamesRef = React.useRef<Set<string>>(new Set());

    // TODO: port sendMessage to session-actions (complex — creates sessions, handles attachments, etc.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendMessage = React.useRef((...args: any[]) =>
        Promise.resolve((useSessionUIStore.getState().sendMessage as (...a: unknown[]) => unknown)(...args)),
    ).current;
    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const fallbackDirectory = useDirectoryStore((s) => s.currentDirectory);
    const currentDirectory = useEffectiveDirectory() ?? fallbackDirectory;
    const currentSessionDirectoryForSync = useSessionUIStore(
        React.useCallback((s) => currentSessionId ? s.getDirectoryForSession(currentSessionId) : null, [currentSessionId]),
    );
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const newSessionDraftOpen = Boolean(newSessionDraft?.open);
    const setNewSessionDraftTarget = useSessionUIStore((s) => s.setNewSessionDraftTarget);
    const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
    const availableWorktreesByProject = useSessionUIStore((s) => s.availableWorktreesByProject);
    const abortPromptSessionId = useSessionUIStore((s) => s.abortPromptSessionId);
    const clearAbortPrompt = useSessionUIStore((s) => s.clearAbortPrompt);
    const attachedFiles = useInputStore((s) => s.attachedFiles);
    const addAttachedFile = useInputStore((s) => s.addAttachedFile);
    const clearAttachedFiles = useInputStore((s) => s.clearAttachedFiles);
    const saveSessionAgentSelection = useSelectionStore((s) => s.saveSessionAgentSelection);
    const consumePendingInputText = useInputStore((s) => s.consumePendingInputText);
    const pendingPresetSubmit = useInputStore((s) => s.pendingPresetSubmit);
    const setPendingInputText = useInputStore((s) => s.setPendingInputText);
    const pendingInputText = useInputStore((s) => s.pendingInputText);
    const consumePendingSyntheticParts = useInputStore((s) => s.consumePendingSyntheticParts);
    const acknowledgeSessionAbort = useSessionUIStore((s) => s.acknowledgeSessionAbort);
    const abortCurrentOperation = React.useCallback(
        (sessionIdOverride?: string) => sessionActions.abortCurrentOperation(sessionIdOverride ?? currentSessionId ?? ''),
        [currentSessionId],
    );
    const currentManagementSessionId = currentSessionId;
    const projects = useProjectsStore((state) => state.projects);
    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
    const [reviewDialogOpen, setReviewDialogOpen] = React.useState(false);
    const [reviewFlowSubmitting, setReviewFlowSubmitting] = React.useState(false);

    const currentProviderId = useConfigStore((state) => state.currentProviderId);
    const currentModelId = useConfigStore((state) => state.currentModelId);
    const currentVariant = useConfigStore((state) => state.currentVariant);
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const setAgent = useConfigStore((state) => state.setAgent);
    const getVisibleAgents = useConfigStore((state) => state.getVisibleAgents);
    const agents = getVisibleAgents();
    const isMobile = useUIStore((state) => state.isMobile);
    const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);
    const inputBarOffset = useUIStore((state) => state.inputBarOffset);
    const persistChatDraft = useUIStore((state) => state.persistChatDraft);
    const inputSpellcheckEnabled = useUIStore((state) => state.inputSpellcheckEnabled);
    const isExpandedInput = useUIStore((state) => state.isExpandedInput);
    const setExpandedInput = useUIStore((state) => state.setExpandedInput);
    const setTimelineDialogOpen = useUIStore((state) => state.setTimelineDialogOpen);
    const { git: runtimeGit, vscode: vscodeApi } = useRuntimeAPIs();
    const cycleAgentShortcutOverride = useUIStore((state) => state.shortcutOverrides.cycle_agent);
    const cycleAgentShortcut = React.useMemo(() => (
        getEffectiveShortcutCombo('cycle_agent', cycleAgentShortcutOverride ? { cycle_agent: cycleAgentShortcutOverride } : undefined)
    ), [cycleAgentShortcutOverride]);
    const { currentTheme } = useThemeSystem();
    const chatSearchDirectory = useChatSearchDirectory();
    const isGitRepo = useIsGitRepo(currentDirectory);
    const currentGitStatus = useGitStore((state) =>
        currentDirectory ? state.directories.get(currentDirectory)?.status ?? null : null,
    );
    const ensureGitStatus = useGitStore((state) => state.ensureStatus);
    const fetchGitStatus = useGitStore((state) => state.fetchStatus);
    const [showAbortStatus, setShowAbortStatus] = React.useState(false);
    const setSessionAutoAccept = usePermissionStore((state) => state.setSessionAutoAccept);
    const composerHighlightRef = React.useRef<HTMLDivElement | null>(null);
    const [isNarrowComposer, setIsNarrowComposer] = React.useState(false);
    const [attachmentPreview, setAttachmentPreview] = React.useState<ToolPopupContent>({
        open: false,
        title: '',
        content: '',
    });

    const handleShowAttachmentPreview = React.useCallback((content: ToolPopupContent) => {
        if (!content.image) return;
        setAttachmentPreview(content);
        setImagePreviewOpen(true);
    }, [setImagePreviewOpen]);

    const handleAttachmentPreviewOpenChange = React.useCallback((open: boolean) => {
        setAttachmentPreview((prev) => ({ ...prev, open }));
        setImagePreviewOpen(open);
    }, [setImagePreviewOpen]);

    React.useEffect(() => {
        if (!currentDirectory || !runtimeGit) return;
        void ensureGitStatus(currentDirectory, runtimeGit);
    }, [currentDirectory, runtimeGit, ensureGitStatus]);

    React.useEffect(() => {
        if (!currentDirectory || !runtimeGit) return;
        return sessionEvents.onGitRefreshHint((hint) => {
            if (normalizePath(hint.directory) !== normalizePath(currentDirectory)) return;
            void fetchGitStatus(currentDirectory, runtimeGit);
        });
    }, [currentDirectory, runtimeGit, fetchGitStatus]);

    const handleStartReviewFlow = React.useCallback(async (execution: ReviewFlowExecution) => {
        if (!currentSessionId) return;
        const directory = useSessionUIStore.getState().getDirectoryForSession(currentSessionId) || currentDirectory || '';
        if (!directory) {
            toast.error(t('diffView.reviewDialog.toast.noSessionDirectory'));
            return;
        }

        setReviewFlowSubmitting(true);
        try {
            await startReviewFlow({
                originalSessionID: currentSessionId,
                directory,
                providerID: execution.providerID,
                modelID: execution.modelID,
                agent: execution.agent || undefined,
                variant: execution.variant || undefined,
                generateHandoff: execution.generateHandoff,
                returnAfterHandoffRequest: execution.generateHandoff,
                autoReview: execution.autoReview,
            });
            setReviewDialogOpen(false);
        } catch (error) {
            console.error('[review-flow] failed to start review flow', error);
            toast.error(error instanceof Error ? error.message : t('diffView.reviewDialog.toast.startFailed'));
        } finally {
            setReviewFlowSubmitting(false);
        }
    }, [currentSessionId, currentDirectory, t]);

    const isDesktopExpanded = isExpandedInput && !isMobile;
    // Mobile fullscreen composer (entered via the drag handle's swipe-up).
    const isMobileExpanded = isExpandedInput && isMobile;
    const isComposerExpanded = isDesktopExpanded || isMobileExpanded;
    // Rounder composer on mobile (touch UI reads better with a softer corner).
    const chatInputRadius = isMobile ? '1.5rem' : 'var(--radius-xl)';
    const useCompactChatPlaceholder = isMobile || isNarrowComposer;

    React.useEffect(() => {
        const element = dropZoneRef.current;
        if (!element) return;

        const updateWidth = (width: number) => {
            const next = width > 0 && width < COMPACT_CHAT_PLACEHOLDER_MAX_WIDTH;
            setIsNarrowComposer((prev) => (prev === next ? prev : next));
        };

        updateWidth(element.clientWidth);

        if (typeof ResizeObserver === 'undefined') {
            const handleResize = () => updateWidth(element.clientWidth);
            window.addEventListener('resize', handleResize);
            return () => window.removeEventListener('resize', handleResize);
        }

        const observer = new ResizeObserver((entries) => {
            updateWidth(entries[0]?.contentRect.width ?? element.clientWidth);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const sendableAttachedFiles = attachedFiles;

    const knownAgentNames = React.useMemo(
        () => new Set(agents.map((agent) => agent.name.toLowerCase())),
        [agents]
    );
    const knownAgentNamesRef = React.useRef(knownAgentNames);
    knownAgentNamesRef.current = knownAgentNames;

    // Known slash-invocations (commands + skills + built-ins) used to highlight
    // matching /tokens in the composer, the same way confirmed @files are.
    const availableCommands = useCommandsStore((s) => s.commands);
    const availableSkills = useSkillsStore((s) => s.skills);
    const knownSlashNames = React.useMemo(() => {
        const names = new Set<string>([
            'init', 'review', 'undo', 'redo', 'timeline', 'compact', 'summary', 'workspace-review', 'plan-feature', 'catch-up', 'debug', 'weigh', 'explore',
        ]);
        if (!isMobile && !isVSCodeRuntime()) names.add('handoff-review');
        for (const command of availableCommands) names.add(command.name.toLowerCase());
        for (const skill of availableSkills) names.add(skill.name.toLowerCase());
        return names;
    }, [availableCommands, availableSkills, isMobile]);

    // /command and /skill spans (primary color). Only tokens that match a known
    // command/skill name are highlighted — partial/unknown tokens stay plain.
    const composerCommandRanges = React.useMemo<HighlightRange[]>(() => {
        if (!message || !message.includes('/') || inputMode === 'shell' || knownSlashNames.size === 0) {
            return [];
        }
        const ranges: HighlightRange[] = [];
        const slashRegex = /(^|\s)\/([A-Za-z0-9][A-Za-z0-9_-]*)/g;
        let match: RegExpExecArray | null;
        while ((match = slashRegex.exec(message)) !== null) {
            const name = match[2];
            if (!knownSlashNames.has(name.toLowerCase())) {
                continue;
            }
            const slashStart = match.index + match[1].length;
            ranges.push({ start: slashStart, end: slashStart + 1 + name.length, style: 'mentionCommand' });
        }
        return ranges;
    }, [inputMode, knownSlashNames, message]);

    // Snippet triggers (#name / #alias). Highlighted like commands once the
    // trigger matches a known snippet name or alias.
    const availableSnippets = useSnippetsStore((s) => s.snippets);
    const knownSnippetTriggers = React.useMemo(() => {
        const triggers = new Set<string>();
        for (const snippet of availableSnippets) {
            triggers.add(snippet.name.toLowerCase());
            for (const alias of snippet.aliases ?? []) triggers.add(alias.toLowerCase());
        }
        return triggers;
    }, [availableSnippets]);

    const composerSnippetRanges = React.useMemo<HighlightRange[]>(() => {
        if (!message || !message.includes('#') || inputMode === 'shell' || knownSnippetTriggers.size === 0) {
            return [];
        }
        const ranges: HighlightRange[] = [];
        const snippetRegex = /(^|\s)#([A-Za-z0-9][A-Za-z0-9_-]*)/g;
        let match: RegExpExecArray | null;
        while ((match = snippetRegex.exec(message)) !== null) {
            const trigger = match[2];
            if (!knownSnippetTriggers.has(trigger.toLowerCase())) {
                continue;
            }
            const hashStart = match.index + match[1].length;
            ranges.push({ start: hashStart, end: hashStart + 1 + trigger.length, style: 'mentionSnippet' });
        }
        return ranges;
    }, [inputMode, knownSnippetTriggers, message]);

    // @mention spans (file = blue, agent = green). Computed as character ranges
    // so they can be merged with markdown highlight ranges in a single overlay.
    const composerMentionRanges = React.useMemo<MentionRange[]>(() => {
        if (!message || !message.includes('@') || inputMode === 'shell') {
            return [];
        }
        const ranges: MentionRange[] = [];
        const mentionRegex = /@([^\s]+)/g;
        let match: RegExpExecArray | null;
        while ((match = mentionRegex.exec(message)) !== null) {
            const full = match[0];
            const mention = String(match[1] || '').trim().replace(/[),.;:!?`"'>]+$/g, '');
            const start = match.index;
            const end = start + full.length;
            const charBefore = start > 0 ? message[start - 1] : null;
            const isBoundary = !charBefore || /(\s|\(|\)|\[|\]|\{|\}|"|'|`|,|\.|;|:)/.test(charBefore);
            if (!isBoundary || mention.length === 0) {
                continue;
            }
            if (knownAgentNames.has(mention.toLowerCase())) {
                ranges.push({ start, end, kind: 'agent' });
            } else if (isConfirmedFilePath(mention)) {
                ranges.push({ start, end, kind: 'file' });
            }
        }
        return ranges;
    }, [inputMode, message, knownAgentNames]);

    const attachmentCitationRanges = React.useMemo<HighlightRange[]>(() => {
        if (!message || !message.includes('[') || inputMode === 'shell' || sendableAttachedFiles.length === 0) {
            return [];
        }

        return findAttachmentCitationRanges(
            message,
            sendableAttachedFiles.map((file) => file.filename),
        ).map((range) => ({
            ...range,
            style: 'mentionFile' as const,
        }));
    }, [inputMode, message, sendableAttachedFiles]);

    // Combined source-mode highlight: markdown syntax + @mentions. Returns null
    // when there's nothing to highlight so the overlay stays off for plain text.
    const highlightedComposerContent = React.useMemo(() => {
        if (!message || inputMode === 'shell') {
            return null;
        }
        const ranges = [
            ...tokenizeMarkdown(message),
            ...highlightFencedCode(message),
            ...mentionRangesToHighlightRanges(composerMentionRanges),
            ...composerCommandRanges,
            ...composerSnippetRanges,
            ...attachmentCitationRanges,
        ];
        return buildHighlightParts(message, ranges);
    }, [attachmentCitationRanges, composerCommandRanges, composerSnippetRanges, composerMentionRanges, inputMode, message]);

    const sanitizeAttachmentsForSend = React.useCallback(
        (files: AttachedFile[] | undefined): AttachedFile[] => (files ?? [])
            .map((file) => ({
                ...file,
                dataUrl: file.source === 'server' && file.serverPath
                    ? toServerFileUrl(file.serverPath)
                    : file.dataUrl,
            })),
        [],
    );

    const extractInlineFileMentions = React.useCallback((rawText: string): { sanitizedText: string; attachments: AttachedFile[] } => {
        if (!rawText || !rawText.includes('@')) {
            return { sanitizedText: rawText, attachments: [] };
        }

        const clientDirectory = opencodeClient.getDirectory() || '';
        const root = (chatSearchDirectory || clientDirectory).replace(/\\/g, '/').replace(/\/+$/, '');
        const seenPaths = new Set<string>();
        const attachments: AttachedFile[] = [];

        const mentionRegex = /@([^\s]+)/g;
        let match: RegExpExecArray | null;
        while ((match = mentionRegex.exec(rawText)) !== null) {
            const rawMentionPath = match[1];
            const offset = match.index;
            const original = rawText;
            const charBefore = offset > 0 ? original[offset - 1] : null;
            if (charBefore && !/(\s|\(|\)|\[|\]|\{|\}|"|'|`|,|\.|;|:)/.test(charBefore)) {
                continue;
            }

            const mentionPath = String(rawMentionPath || '')
                .trim()
                .replace(/^[`"'<(]+/, '')
                .replace(/[),.;:!?`"'>]+$/g, '');
            if (!mentionPath) {
                continue;
            }

            if (knownAgentNamesRef.current.has(mentionPath.toLowerCase())) {
                continue;
            }

            const looksLikeFilePath = isConfirmedFilePath(mentionPath);
            if (!looksLikeFilePath) {
                continue;
            }

            const normalizedMentionPath = mentionPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
            if (!normalizedMentionPath) {
                continue;
            }

            const serverPath = mentionPath.startsWith('/')
                ? mentionPath.replace(/\\/g, '/')
                : root
                    ? `${root}/${normalizedMentionPath}`
                    : null;

            if (!serverPath) {
                continue;
            }

            const normalizedServerPath = serverPath.replace(/\/+/g, '/');
            if (seenPaths.has(normalizedServerPath)) {
                continue;
            }
            seenPaths.add(normalizedServerPath);

            const filename = normalizedMentionPath.split('/').filter(Boolean).pop() || normalizedMentionPath;
            attachments.push({
                id: `inline-server-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                file: new File([], filename, { type: 'text/plain' }),
                filename,
                mimeType: 'text/plain',
                size: 0,
                dataUrl: toServerFileUrl(normalizedServerPath),
                source: 'server',
                serverPath: normalizedServerPath,
            });
        }

        return {
            sanitizedText: rawText,
            attachments,
        };
    }, [chatSearchDirectory]);
    const [autocompleteOverlayPosition, setAutocompleteOverlayPosition] = React.useState<AutocompleteOverlayPosition | null>(null);
    const abortTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const prevWasAbortedRef = React.useRef(false);

    // Issue linking state
    const [issuePickerOpen, setIssuePickerOpen] = React.useState(false);
    const [prPickerOpen, setPrPickerOpen] = React.useState(false);
    const [linkedIssue, setLinkedIssue] = React.useState<{ 
        number: number; 
        title: string; 
        url: string; 
        contextText: string;
        author?: { login: string; avatarUrl?: string };
    } | null>(null);
    const [linkedPr, setLinkedPr] = React.useState<{
        number: number;
        title: string;
        url: string;
        head: string;
        base: string;
        includeDiff: boolean;
        instructionsText: string;
        contextText: string;
        author?: { login: string; avatarUrl?: string };
    } | null>(null);

    // Message queue
    const followUpBehavior = useMessageQueueStore((state) => state.followUpBehavior);
    const queuedMessages = useMessageQueueStore(
        React.useCallback(
            (state) => {
                if (!currentSessionId) return EMPTY_QUEUE;
                return state.queuedMessages[currentSessionId] ?? EMPTY_QUEUE;
            },
            [currentSessionId]
        )
    );
    const addToQueue = useMessageQueueStore((state) => state.addToQueue);
    const clearQueue = useMessageQueueStore((state) => state.clearQueue);
    const removeFromQueue = useMessageQueueStore((state) => state.removeFromQueue);

    // Inline comment drafts
    const draftCount = useInlineCommentDraftStore(
        React.useCallback(
            (state) => {
                const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : '');
                if (!sessionKey) return 0;
                return (state.drafts[sessionKey] ?? []).length;
            },
            [currentSessionId, newSessionDraftOpen]
        )
    );
    const draftSourceKey = useInlineCommentDraftStore(
        React.useCallback(
            (state) => {
                const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : '');
                const drafts = sessionKey ? (state.drafts[sessionKey] ?? []) : [];
                let previewConsole = 0;
                let previewAnnotation = 0;
                let review = 0;
                for (const draft of drafts) {
                    if (draft.source === 'preview-console') previewConsole += 1;
                    else if (draft.source === 'preview-annotation') previewAnnotation += 1;
                    else review += 1;
                }
                return `${previewConsole}:${previewAnnotation}:${review}`;
            },
            [currentSessionId, newSessionDraftOpen]
        )
    );
    const consumeDrafts = useInlineCommentDraftStore((state) => state.consumeDrafts);
    const removeInlineCommentDraft = useInlineCommentDraftStore((state) => state.removeDraft);
    const hasDrafts = draftCount > 0;
    const [previewConsoleCount, previewAnnotationCount, reviewCount] = draftSourceKey.split(':').map((entry) => Number(entry) || 0);
    const removePreviewDrafts = React.useCallback((source: 'preview-console' | 'preview-annotation') => {
        const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : '');
        if (!sessionKey) return;
        const drafts = useInlineCommentDraftStore.getState().drafts[sessionKey] ?? [];
        for (const draft of drafts) {
            if (draft.source === source) {
                removeInlineCommentDraft(sessionKey, draft.id);
            }
        }
    }, [currentSessionId, newSessionDraftOpen, removeInlineCommentDraft]);
    // Review comments are the inline-comment drafts that aren't preview sources.
    const removeReviewDrafts = React.useCallback(() => {
        const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : '');
        if (!sessionKey) return;
        const drafts = useInlineCommentDraftStore.getState().drafts[sessionKey] ?? [];
        for (const draft of drafts) {
            if (draft.source !== 'preview-console' && draft.source !== 'preview-annotation') {
                removeInlineCommentDraft(sessionKey, draft.id);
            }
        }
    }, [currentSessionId, newSessionDraftOpen, removeInlineCommentDraft]);

    // User message history for up/down arrow navigation.
    // Keep this on a narrow hook instead of full session message records.
    const userMessageHistory = useUserMessageHistory(currentSessionId ?? "");

    // Keep messageRef in sync with message state
    React.useEffect(() => {
        messageRef.current = message;
    }, [message]);

    React.useEffect(() => {
        currentSessionIdForDraftRef.current = currentSessionId;
    }, [currentSessionId]);

    const persistDraftImmediately = React.useCallback((sessionId: string | null, draft: string) => {
        const key = getDraftKey(sessionId);
        const lastPersisted = lastPersistedDraftRef.current.get(key);
        if (lastPersisted === draft) {
            return;
        }

        saveStoredDraft(sessionId, draft);
        // Only persist confirmed mentions that are actually present in the draft text
        const activeMentions = new Set<string>();
        for (const mention of confirmedMentionsRef.current) {
            if (draft.includes(`@${mention}`)) {
                activeMentions.add(mention);
            }
        }
        confirmedMentionsRef.current = activeMentions;
        saveConfirmedMentions(sessionId, activeMentions);
        lastPersistedDraftRef.current.set(key, draft);
    }, []);

    const clearPendingDraftPersist = React.useCallback(() => {
        if (!draftPersistTimerRef.current) {
            return;
        }
        clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
    }, []);

    // Handle initial draft restoration and text selection
    const hasHandledInitialDraftRef = React.useRef(false);
    React.useEffect(() => {
        if (hasHandledInitialDraftRef.current) return;
        hasHandledInitialDraftRef.current = true;

        const draft = initialDraftRef.current;
        if (!draft) return;

        if (!persistChatDraft) {
            // Setting disabled - clear the restored draft
            setMessage('');
            try {
                localStorage.removeItem(getDraftKey(initialSessionIdRef.current));
            } catch {
                // Ignore
            }
        } else {
            // Setting enabled - select all text
            requestAnimationFrame(() => {
                textareaRef.current?.select();
            });
        }
    }, [persistChatDraft]);

    // Handle session switching: save draft for old session, restore draft for new session
    const prevSessionIdRef = React.useRef(currentSessionId);
    React.useEffect(() => {
        if (prevSessionIdRef.current !== currentSessionId) {
            const oldSessionId = prevSessionIdRef.current;
            prevSessionIdRef.current = currentSessionId;
            setInputMode('normal');
            clearPendingDraftPersist();
            skipNextDraftPersistRef.current = true;

            if (persistChatDraft) {
                // Save current draft for the session we're leaving
                persistDraftImmediately(oldSessionId, messageRef.current);
                // Restore draft for the session we're entering
                const newDraft = getStoredDraft(currentSessionId);
                setMessage(newDraft);
                confirmedMentionsRef.current = loadConfirmedMentions(currentSessionId);
                if (newDraft) {
                    requestAnimationFrame(() => {
                        textareaRef.current?.select();
                    });
                }
            } else {
                // Persist disabled: clear input without saving
                setMessage('');
                confirmedMentionsRef.current = new Set();
            }
        }
    }, [clearPendingDraftPersist, currentSessionId, persistChatDraft, persistDraftImmediately]);

    // Focus textarea when new session draft is opened
    const prevNewSessionDraftOpenRef = React.useRef(newSessionDraftOpen);
    React.useEffect(() => {
        if (!prevNewSessionDraftOpenRef.current && newSessionDraftOpen) {
            // New session draft just opened - focus the textarea
            requestAnimationFrame(() => {
                if (isMobile) {
                    // On mobile, use preventScroll to avoid viewport jumping
                    textareaRef.current?.focus({ preventScroll: true });
                } else {
                    textareaRef.current?.focus();
                }
            });
        }
        prevNewSessionDraftOpenRef.current = newSessionDraftOpen;
    }, [newSessionDraftOpen, isMobile]);

    // Persist chat input draft to localStorage per session (only if setting enabled)
    React.useEffect(() => {
        if (!persistChatDraft) {
            clearPendingDraftPersist();
            persistDraftImmediately(currentSessionId, '');
            return;
        }

        if (skipNextDraftPersistRef.current) {
            skipNextDraftPersistRef.current = false;
            return;
        }

        clearPendingDraftPersist();
        const draftSnapshot = message;
        const sessionSnapshot = currentSessionId;
        draftPersistTimerRef.current = setTimeout(() => {
            draftPersistTimerRef.current = null;
            persistDraftImmediately(sessionSnapshot, draftSnapshot);
        }, CHAT_DRAFT_PERSIST_DEBOUNCE_MS);

        return () => {
            clearPendingDraftPersist();
        };
    }, [clearPendingDraftPersist, currentSessionId, message, persistChatDraft, persistDraftImmediately]);

    React.useEffect(() => {
        return () => {
            clearPendingDraftPersist();
            if (persistChatDraft) {
                persistDraftImmediately(currentSessionIdForDraftRef.current, messageRef.current);
            }
        };
    }, [clearPendingDraftPersist, persistChatDraft, persistDraftImmediately]);

    // Session activity for queue availability and controls
    const { phase: sessionPhase } = useCurrentSessionActivity();
    const autoReviewRunning = useAutoReviewStore(React.useCallback((state) => {
        if (!currentSessionId) return false;
        const run = state.runsByOriginalSessionID[currentSessionId];
        return run?.status === 'running' && run.runtimeKey === getRuntimeKey();
    }, [currentSessionId]));

    const handleOpenMobilePanel = React.useCallback((panel: MobileControlsPanel) => {
        if (!isMobile) {
            return;
        }
        // Set the panel state BEFORE blurring: the collapse watcher and the
        // overlay-host observer must already see the overlay as open when the
        // keyboard-close lands, otherwise the composer folds into the pill
        // under the sheet.
        setMobileControlsPanel(panel);
        textareaRef.current?.blur();
    }, [isMobile]);

    // Consume pending input text (e.g., from revert action)
    React.useEffect(() => {
        if (pendingInputText !== null) {
            const pending = consumePendingInputText();
            if (pending?.text) {
                if (pending.mode === 'append') {
                    setMessage((prev) => {
                        const next = pending.text;
                        if (!next.trim()) return prev;
                        return appendWithLineBreaks(prev, next);
                    });
                } else if (pending.mode === 'append-inline') {
                    setMessage((prev) => appendInlineText(prev, pending.text));
                } else {
                    setMessage(pending.text);
                }
                // Focus textarea after setting message
                setTimeout(() => {
                    textareaRef.current?.focus();
                }, 0);
            }
        }
    }, [pendingInputText, consumePendingInputText]);

    const hasContent = message.trim().length > 0 || sendableAttachedFiles.length > 0 || hasDrafts;
    const hasQueuedMessages = queuedMessages.length > 0;
    const canSend = hasContent || hasQueuedMessages;

    const canAbort = sessionPhase !== 'idle';

    const getCurrentInputSnapshot = React.useCallback(() => {
        const currentMessage = textareaRef.current?.value ?? message;
        return {
            message: currentMessage,
            hasContent: currentMessage.trim().length > 0 || sendableAttachedFiles.length > 0 || hasDrafts,
        };
    }, [hasDrafts, message, sendableAttachedFiles.length]);

    // Keep a ref to handleSubmit so callbacks don't depend on it.
    type SubmitOptions = {
        queuedOnly?: boolean;
        queuedMessageId?: string;
        delivery?: 'steer';
        /** Submit this text instead of the composer input. Used by preset
            starter chips: on mobile the collapsed pill has no mounted textarea,
            so the DOM-first input snapshot would read empty content. */
        presetText?: string;
    };
    const handleSubmitRef = React.useRef<(options?: SubmitOptions) => Promise<void>>(async () => {});

    // Add message to queue instead of sending
    const handleQueueMessage = React.useCallback(() => {
        const inputSnapshot = getCurrentInputSnapshot();
        if (!inputSnapshot.hasContent || !currentSessionId) return;

        const drafts = consumeDrafts(currentSessionId);

        let messageToQueue = inputSnapshot.message.replace(/^\n+|\n+$/g, '');
        if (drafts.length > 0) {
            messageToQueue = appendInlineComments(messageToQueue, drafts);
        }
        const attachmentsToQueue = sanitizeAttachmentsForSend(sendableAttachedFiles);

        addToQueue(currentSessionId, {
            content: messageToQueue,
            attachments: attachmentsToQueue.length > 0 ? attachmentsToQueue : undefined,
            sendConfig: currentProviderId && currentModelId ? {
                providerID: currentProviderId,
                modelID: currentModelId,
                agent: currentAgentName ?? undefined,
                variant: currentVariant ?? undefined,
            } : undefined,
        });

        // Clear input and attachments
        // Note: confirmedMentionsRef is NOT cleared here because queued messages
        // are processed later in handleSubmit which reads the ref via extractInlineFileMentions.
        // The ref is cleared in handleSubmit after all queued messages are sent.
        setMessage('');
        if (attachmentsToQueue.length > 0) {
            clearAttachedFiles();
        }

        if (!isMobile) {
            textareaRef.current?.focus();
        }
    }, [getCurrentInputSnapshot, currentSessionId, sendableAttachedFiles, sanitizeAttachmentsForSend, addToQueue, clearAttachedFiles, isMobile, consumeDrafts, currentProviderId, currentModelId, currentAgentName, currentVariant]);

    const handleQueuedMessageEdit = React.useCallback((content: string) => {
        setMessage(content);
        setTimeout(() => {
            textareaRef.current?.focus();
        }, 0);
    }, []);

    const handleQueuedMessageSend = React.useCallback((messageId: string) => {
        // Force-sending from the queue during a busy session counts as steer
        void handleSubmitRef.current({ queuedOnly: true, queuedMessageId: messageId, delivery: 'steer' });
    }, []);

    const handleOpenAgentPanel = React.useCallback(() => {
        setMobileControlsPanel('agent');
    }, []);

    const handleToggleExpandedInput = React.useCallback(() => {
        setExpandedInput(!isExpandedInput);
    }, [isExpandedInput, setExpandedInput]);

    const openIssuePicker = React.useCallback(() => {
        setIssuePickerOpen(true);
    }, []);

    const openPrPicker = React.useCallback(() => {
        setPrPickerOpen(true);
    }, []);

    const handleSubmit = async (options?: SubmitOptions) => {
        const queuedOnly = options?.queuedOnly ?? false;
        const queuedMessageId = options?.queuedMessageId;
        const delivery = options?.delivery === 'steer' && sessionPhase !== 'idle' ? 'steer' : undefined;
        const inputSnapshot = options?.presetText != null
            ? {
                message: options.presetText,
                hasContent: options.presetText.trim().length > 0 || sendableAttachedFiles.length > 0 || hasDrafts,
            }
            : getCurrentInputSnapshot();
        const queuedMessagesToSend = queuedMessageId
            ? queuedMessages.filter((message) => message.id === queuedMessageId)
            : queuedMessages;

        if (queuedOnly && autoReviewRunning) {
            return;
        }

        if (queuedOnly) {
            if (queuedMessagesToSend.length === 0 || !currentSessionId) return;
        } else if ((!inputSnapshot.hasContent && !hasQueuedMessages) || (!currentSessionId && !newSessionDraftOpen)) {
            return;
        }

        const capturedSendConfig = queuedOnly ? queuedMessagesToSend[0]?.sendConfig : undefined;
        const providerIdToSend = capturedSendConfig?.providerID ?? currentProviderId;
        const modelIdToSend = capturedSendConfig?.modelID ?? currentModelId;
        const agentNameToSend = capturedSendConfig?.agent ?? currentAgentName;
        const variantToSend = capturedSendConfig?.variant ?? currentVariant;

        if (!providerIdToSend || !modelIdToSend) {
            console.warn('Cannot send message: provider or model not selected');
            return;
        }

        // Sending is authoritative: if a question prompt is open, dismiss it
        // so the prompt cannot linger or strand the session. The dismiss clears
        // the card instantly (optimistic) and formally rejects the question.
        // Rejecting unblocks the agent's tool but does NOT end its turn, so a
        // direct send would race with the still-active run and be silently
        // discarded by the OpenCode runner. Instead we queue the message; the
        // queued-message auto-send hook delivers it as the next turn once the
        // rejected turn winds down and the session returns to idle. This avoids
        // aborting the turn (which would surface an "aborted" notice).
        if (currentSessionId && !queuedOnly && autoReviewRunning) {
            handleQueueMessage();
            return;
        }

        if (currentSessionId && !queuedOnly) {
            const dismissedQuestions = await sessionActions.dismissOpenQuestionsForSession(currentSessionId);
            if (dismissedQuestions) {
                handleQueueMessage();
                return;
            }
        }

        const sendMessageOptions = delivery ? { delivery } : undefined;

        // Build the primary message (first part) and additional parts
        let primaryText = '';
        let primaryAttachments: AttachedFile[] = [];
        let agentMentionName: string | undefined;
        const additionalParts: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }> = [];
        const availableSkillNames = new Set(useSkillsStore.getState().skills.map((skill) => skill.name));
        const mentionedSkillNames: string[] = [];
        const addMentionedSkills = (text: string) => {
            for (const name of collectInlineSkillMentions(text, availableSkillNames)) {
                if (!mentionedSkillNames.includes(name)) mentionedSkillNames.push(name);
            }
        };

        // Consume any pending synthetic parts (from conflict resolution, etc.)
        const syntheticParts = consumePendingSyntheticParts();

        // Process queued messages first
        for (let i = 0; i < queuedMessagesToSend.length; i++) {
            const queuedMsg = queuedMessagesToSend[i];
            const { sanitizedText, mention } = parseAgentMentions(queuedMsg.content, agents);
            const { sanitizedText: queuedText, attachments: mentionAttachments } = extractInlineFileMentions(sanitizedText);
            addMentionedSkills(queuedText);

            // Use agent mention from first message that has one
            if (!agentMentionName && mention?.name) {
                agentMentionName = mention.name;
            }

            if (i === 0) {
                // First queued message becomes primary
                primaryText = queuedText;
                primaryAttachments = [
                    ...sanitizeAttachmentsForSend(queuedMsg.attachments),
                    ...mentionAttachments,
                ];
            } else {
                // Subsequent queued messages become additional parts
                const queuedAttachments = sanitizeAttachmentsForSend(queuedMsg.attachments);
                additionalParts.push({
                    text: queuedText,
                    attachments: [...queuedAttachments, ...mentionAttachments],
                });
            }
        }

        // Add current input (skip for queued-only auto-send)
        if (!queuedOnly && inputSnapshot.hasContent) {
            const messageToSend = inputSnapshot.message.replace(/^\n+|\n+$/g, '');
            const { sanitizedText, mention } = parseAgentMentions(messageToSend, agents);
            const { sanitizedText: messageText, attachments: mentionAttachments } = extractInlineFileMentions(sanitizedText);
            const attachmentsToSend = sanitizeAttachmentsForSend(sendableAttachedFiles);
            addMentionedSkills(messageText);

            if (!agentMentionName && mention?.name) {
                agentMentionName = mention.name;
            }

            if (queuedMessagesToSend.length === 0) {
                // No queue - current input is primary
                primaryText = messageText;
                primaryAttachments = [...attachmentsToSend, ...mentionAttachments];
            } else {
                // Has queue - current input is additional part
                additionalParts.push({
                    text: messageText,
                    attachments: [...attachmentsToSend, ...mentionAttachments],
                });
            }
        }

        const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
        let drafts: InlineCommentDraft[] = [];
        if (!queuedOnly && sessionKey) {
            drafts = consumeDrafts(sessionKey);
        }

        if (drafts.length > 0) {
            if (queuedMessagesToSend.length === 0) {
                primaryText = appendInlineComments(primaryText, drafts);
            } else if (additionalParts.length > 0) {
                const lastPart = additionalParts[additionalParts.length - 1];
                lastPart.text = appendInlineComments(lastPart.text, drafts);
            } else {
                primaryText = appendInlineComments(primaryText, drafts);
            }
        }

        // Add synthetic parts (from conflict resolution, etc.)
        if (syntheticParts && syntheticParts.length > 0) {
            for (const part of syntheticParts) {
                additionalParts.push({
                    text: part.text,
                    synthetic: true,
                });
            }
        }

        // Add linked issue as synthetic part (only the parts with synthetic: true)
        // The text part (synthetic: false) is completely dropped per requirements
        if (linkedIssue) {
            additionalParts.push({
                text: linkedIssue.contextText,
                synthetic: true,
            });
        }

        if (linkedPr) {
            additionalParts.push({
                text: linkedPr.instructionsText,
                synthetic: true,
            });
            additionalParts.push({
                text: linkedPr.contextText,
                synthetic: true,
            });
        }

        const skillMentionInstruction = buildSkillMentionInstruction(mentionedSkillNames);
        if (skillMentionInstruction) {
            additionalParts.push({
                text: skillMentionInstruction,
                synthetic: true,
            });
        }

        if (!primaryText && primaryAttachments.length === 0 && additionalParts.length === 0) return;

        // Clear queue and input
        if (currentSessionId && queuedMessageId) {
            removeFromQueue(currentSessionId, queuedMessageId);
        } else if (currentSessionId && hasQueuedMessages) {
            clearQueue(currentSessionId);
        }
        if (!queuedOnly) {
            setMessage('');
            confirmedMentionsRef.current.clear();
            // Clear per-session draft on submit
            saveStoredDraft(currentSessionId, '');
            saveConfirmedMentions(currentSessionId, confirmedMentionsRef.current);
            // Reset message history navigation state
            setHistoryIndex(-1);
            setDraftMessage('');
            if (attachedFiles.length > 0) {
                clearAttachedFiles();
            }
            // Close expanded input overlay when submitting
            setExpandedInput(false);
        }

        if (isMobile) {
            textareaRef.current?.blur();
        }

        // Handle local slash commands only in normal mode
        const normalizedCommand = primaryText.trimStart();
        if (inputMode === 'normal' && normalizedCommand.startsWith('/')) {
            const commandName = normalizedCommand
                .slice(1)
                .trim()
                .split(/\s+/)[0]
                ?.toLowerCase();

            if (commandName === 'undo' && currentSessionId) {
                await useSessionUIStore.getState().handleSlashUndo(currentSessionId);
                scrollToBottom?.();
                return;
            }
            else if (commandName === 'redo' && currentSessionId) {
                await useSessionUIStore.getState().handleSlashRedo(currentSessionId);
                scrollToBottom?.();
                return;
            }
            else if (commandName === 'timeline' && currentSessionId) {
                setTimelineDialogOpen(true);
                return;
            }
            else if (commandName === 'compact' && currentSessionId) {
                try {
                    const compactDirectory = useSessionUIStore.getState().getDirectoryForSession(currentSessionId) || currentDirectory || undefined;
                    await sessionActions.compactSession({
                        sessionId: currentSessionId,
                        providerID: currentProviderId,
                        modelID: currentModelId,
                        directory: compactDirectory,
                    });
                } catch (error) {
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.compactFailed'));
                }
                return;
            }
            else if (commandName === 'summary' && currentSessionId) {
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    // Everything after `/summary ` is an optional topic hint
                    // the user wants the summary focused on.
                    const topic = normalizedCommand.replace(/^\/summary\b/i, '').trim();
                    const topicLine = topic ? ` focused on: ${topic}` : '';
                    const topicBlock = topic
                        ? `The user asked you to focus this summary on: ${topic}. Prioritize that topic; mention unrelated threads only in passing.`
                        : '';
                    const visibleText = await renderMagicPrompt('session.summary.visible', { topic_line: topicLine });
                    const instructionsText = await renderMagicPrompt('session.summary.instructions', { topic_block: topicBlock });
                    await sendMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        [],
                        agentMentionName,
                        [{ text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    scrollToBottom?.();
                } catch (error) {
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.summaryFailed'));
                }
                return;
            }
            else if (commandName === 'workspace-review' && (currentSessionId || newSessionDraftOpen)) {
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const visibleText = await renderMagicPrompt('session.review.visible');
                    const instructionsText = await renderMagicPrompt('session.review.instructions');
                    await sendMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        [],
                        agentMentionName,
                        [{ text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    scrollToBottom?.();
                } catch (error) {
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.reviewFailed'));
                }
                return;
            }
            else if (commandName === 'handoff-review' && currentSessionId && !isMobile && !isVSCodeRuntime()) {
                setReviewDialogOpen(true);
                return;
            }
            else if (commandName === 'plan-feature' && (currentSessionId || newSessionDraftOpen)) {
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const visibleText = await renderMagicPrompt('session.plan.visible');
                    const instructionsText = await renderMagicPrompt('session.plan.instructions');
                    await sendMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        [],
                        agentMentionName,
                        [{ text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    scrollToBottom?.();
                } catch (error) {
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.planFeatureFailed'));
                }
                return;
            }
            else if (commandName === 'catch-up' && (currentSessionId || newSessionDraftOpen)) {
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const visibleText = await renderMagicPrompt('session.catchup.visible');
                    const instructionsText = await renderMagicPrompt('session.catchup.instructions');
                    await sendMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        [],
                        agentMentionName,
                        [{ text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    scrollToBottom?.();
                } catch (error) {
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.catchUpFailed'));
                }
                return;
            }
            else if (commandName === 'debug' && (currentSessionId || newSessionDraftOpen)) {
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const visibleText = await renderMagicPrompt('session.debug.visible');
                    const instructionsText = await renderMagicPrompt('session.debug.instructions');
                    await sendMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        [],
                        agentMentionName,
                        [{ text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    scrollToBottom?.();
                } catch (error) {
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.debugFailed'));
                }
                return;
            }
            else if (commandName === 'weigh' && (currentSessionId || newSessionDraftOpen)) {
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const visibleText = await renderMagicPrompt('session.weigh.visible');
                    const instructionsText = await renderMagicPrompt('session.weigh.instructions');
                    await sendMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        [],
                        agentMentionName,
                        [{ text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    scrollToBottom?.();
                } catch (error) {
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.weighFailed'));
                }
                return;
            }
            else if (commandName === 'explore' && (currentSessionId || newSessionDraftOpen)) {
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const visibleText = await renderMagicPrompt('session.explore.visible');
                    const instructionsText = await renderMagicPrompt('session.explore.instructions');
                    await sendMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        [],
                        agentMentionName,
                        [{ text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    scrollToBottom?.();
                } catch (error) {
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.exploreFailed'));
                }
                return;
            }
        }

        const currentSessionDirectory = currentSessionId
            ? useSessionUIStore.getState().getDirectoryForSession(currentSessionId) || currentDirectory
            : currentDirectory;
        const shouldAddResponseStyle = newSessionDraftOpen || (currentSessionId ? !hasUserMessages(currentSessionId, currentSessionDirectory) : false);
        if (shouldAddResponseStyle) {
            const responseStyleInstruction = await fetchResponseStyleInstruction().catch(() => null);
            if (responseStyleInstruction) {
                additionalParts.push({
                    text: wrapSystemReminder(responseStyleInstruction),
                    synthetic: true,
                });
            }
        }

        try {
            const expandText = useSnippetsStore.getState().expandText;
            primaryText = await expandText(primaryText);
            for (const part of additionalParts) {
                if (!part.synthetic) part.text = await expandText(part.text);
            }
        } catch (error) {
            console.warn('[ChatInput] Failed to expand snippets, sending original text:', error);
        }

        // Collect all attachments for error recovery
        const allAttachments = [
            ...primaryAttachments,
            ...additionalParts.flatMap(p => p.attachments ?? []),
        ];

        const sendPromise = sendMessage(
            primaryText,
            providerIdToSend,
            modelIdToSend,
            agentNameToSend,
            primaryAttachments,
            agentMentionName,
            additionalParts.length > 0 ? additionalParts : undefined,
            variantToSend,
            inputMode,
            sendMessageOptions,
        );

        if (typeof window === 'undefined') {
            scrollToBottom?.();
        } else {
            window.requestAnimationFrame(() => {
                scrollToBottom?.();
            });
        }

        void sendPromise.then(() => {
            // Clear linked issue after successful message send
            if (linkedIssue) {
                setLinkedIssue(null);
            }
            if (linkedPr) {
                setLinkedPr(null);
            }
        }).catch((error: unknown) => {
            const rawMessage =
                error instanceof Error
                    ? error.message
                    : typeof error === 'string'
                        ? error
                        : String(error ?? '');
            const normalized = rawMessage.toLowerCase();

            console.error('Message send failed:', rawMessage || error);

            const isSoftNetworkError =
                normalized.includes('timeout') ||
                normalized.includes('timed out') ||
                normalized.includes('may still be processing') ||
                normalized.includes('being processed') ||
                normalized.includes('failed to fetch') ||
                normalized.includes('networkerror') ||
                normalized.includes('network error') ||
                normalized.includes('gateway timeout') ||
                normalized === 'failed to send message';

            if (normalized.includes('payload too large') || normalized.includes('413') || normalized.includes('entity too large')) {
                toast.error(t('chat.chatInput.toast.attachmentsTooLarge'));
                if (allAttachments.length > 0) {
                    useInputStore.getState().setAttachedFiles(allAttachments);
                }
                return;
            }

            if (isSoftNetworkError) {
                if (allAttachments.length > 0) {
                    useInputStore.getState().setAttachedFiles(allAttachments);
                    toast.error(t('chat.chatInput.toast.sendAttachmentsFailed'));
                }
                return;
            }

            if (allAttachments.length > 0) {
                useInputStore.getState().setAttachedFiles(allAttachments);
            }
            toast.error(rawMessage || t('chat.chatInput.toast.messageSendFailed'));
        });

        if (!isMobile) {
            textareaRef.current?.focus();
        }
    };

    // Update ref with latest handleSubmit on every render
    handleSubmitRef.current = handleSubmit;

    // Primary action for send/queue button — respects selected follow-up behavior
    const handlePrimaryAction = React.useCallback(() => {
        const inputSnapshot = getCurrentInputSnapshot();
        const canQueue = inputMode === 'normal' && inputSnapshot.hasContent && currentSessionId && (sessionPhase !== 'idle' || autoReviewRunning);
        if (followUpBehavior === 'queue' && canQueue) {
            handleQueueMessage();
        } else if (followUpBehavior === 'steer' && canQueue) {
            void handleSubmitRef.current({ delivery: 'steer' });
        } else {
            void handleSubmitRef.current();
        }
    }, [inputMode, getCurrentInputSnapshot, currentSessionId, sessionPhase, autoReviewRunning, followUpBehavior, handleQueueMessage]);

    // Draft welcome presets: submit immediately.
    const submitPresetPrompt = React.useCallback((text: string) => {
        // The text goes straight into the submit (see SubmitOptions.presetText)
        // instead of through the composer input — the collapsed mobile pill has
        // no mounted textarea to stage it in.
        void handleSubmitRef.current({ presetText: text });
    }, []);

    // Dictation: insert the transcript inline; optionally submit immediately.
    // getCurrentInputSnapshot reads textareaRef.current.value first, so setting
    // it synchronously lets handleSubmit pick up the text in the same tick.
    const handleDictationInsert = React.useCallback((text: string) => {
        setMessage((prev) => {
            const next = appendInlineText(prev, text);
            const textarea = textareaRef.current;
            if (textarea) {
                textarea.value = next;
            }
            return next;
        });
        setTimeout(() => {
            textareaRef.current?.focus();
        }, 0);
    }, []);

    const handleDictationInsertAndSend = React.useCallback((text: string) => {
        // Same as preset chips: the composed text goes into the submit as an
        // explicit override instead of being staged in the textarea, which may
        // not be mounted (collapsed mobile pill).
        const next = appendInlineText(textareaRef.current?.value ?? messageRef.current, text);
        void handleSubmitRef.current({ presetText: next });
    }, []);

    // Preset chips rendered outside this component (e.g. under the welcome
    // message on narrow surfaces) request a submit via the input store; consume
    // it here so it routes through the same command-aware submit path.
    React.useEffect(() => {
        if (pendingPresetSubmit == null) return;
        const text = useInputStore.getState().consumePendingPresetSubmit();
        if (text) submitPresetPrompt(text);
    }, [pendingPresetSubmit, submitPresetPrompt]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Early return during IME composition to prevent interference with autocomplete.
        // Uses keyCode === 229 fallback for WebKit where compositionend fires before keydown.
        if (isIMECompositionEvent(e)) return;

        if (inputMode === 'shell' && e.key === 'Escape') {
            e.preventDefault();
            setInputMode('normal');
            return;
        }

        if (inputMode === 'shell' && e.key === 'Backspace' && message.length === 0) {
            e.preventDefault();
            setInputMode('normal');
            return;
        }

        if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const textarea = textareaRef.current;
            const selectionStart = textarea?.selectionStart ?? message.length;
            const selectionEnd = textarea?.selectionEnd ?? message.length;
            const hasCollapsedSelection = selectionStart === selectionEnd;

            if (hasCollapsedSelection) {
                const probeIndex = e.key === 'Backspace' ? selectionStart - 1 : selectionStart;
                if (probeIndex >= 0 && probeIndex < message.length) {
                    let tokenStart = probeIndex;
                    while (tokenStart > 0 && !/\s/.test(message[tokenStart - 1])) {
                        tokenStart -= 1;
                    }

                    let tokenEnd = probeIndex + 1;
                    while (tokenEnd < message.length && !/\s/.test(message[tokenEnd])) {
                        tokenEnd += 1;
                    }

                    const token = message.slice(tokenStart, tokenEnd);
                    const mentionContent = token.slice(1);
                    const looksLikeFileMention = FILE_MENTION_TOKEN.test(token)
                        && !knownAgentNamesRef.current.has(mentionContent.toLowerCase())
                        && isConfirmedFilePath(mentionContent);

                    if (looksLikeFileMention) {
                        confirmedMentionsRef.current.delete(mentionContent);
                        const removeUntil = message[tokenEnd] === ' ' ? tokenEnd + 1 : tokenEnd;
                        const nextMessage = `${message.slice(0, tokenStart)}${message.slice(removeUntil)}`;
                        e.preventDefault();
                        setMessage(nextMessage);
                        requestAnimationFrame(() => {
                            if (textareaRef.current) {
                                textareaRef.current.selectionStart = tokenStart;
                                textareaRef.current.selectionEnd = tokenStart;
                            }
                            adjustTextareaHeight();
                        });
                        updateAutocompleteState(nextMessage, tokenStart);
                        return;
                    }
                }
            }
        }

        if (showCommandAutocomplete && commandRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                commandRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (showSkillAutocomplete && skillRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                skillRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (showSnippetAutocomplete && snippetRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                snippetRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (showFileMention && mentionRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                mentionRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (isDesktopExpanded && e.key === 'Escape') {
            e.preventDefault();
            setExpandedInput(false);
            return;
        }

        const cycleAgentBackwardShortcut = cycleAgentShortcut && !cycleAgentShortcut.includes('shift')
            ? normalizeCombo(`shift+${cycleAgentShortcut}`)
            : '';
        const cycleAgentDirection = cycleAgentBackwardShortcut && eventMatchesShortcut(e, cycleAgentBackwardShortcut)
            ? -1
            : eventMatchesShortcut(e, cycleAgentShortcut)
                ? 1
                : 0;

        if (cycleAgentDirection !== 0 && !showCommandAutocomplete && !showSkillAutocomplete && !showSnippetAutocomplete && !showFileMention) {
            e.preventDefault();
            e.stopPropagation();
            handleCycleAgent(cycleAgentDirection);
            return;
        }

        // Handle ArrowUp/ArrowDown for message history navigation
        // ArrowUp: only when cursor at start (position 0) or input is empty
        // ArrowDown: also works when cursor at end (to cycle forward through history)
        const isAnyAutocompleteOpen = showCommandAutocomplete || showSkillAutocomplete || showSnippetAutocomplete || showFileMention;
        const cursorAtStart = textareaRef.current?.selectionStart === 0 && textareaRef.current?.selectionEnd === 0;
        const cursorAtEnd = textareaRef.current?.selectionStart === message.length && textareaRef.current?.selectionEnd === message.length;
        const canNavigateHistoryUp = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtStart);
        const canNavigateHistoryDown = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtEnd);

        // Markdown-aware auto-pairing (source mode), normal input only.
        if (inputMode === 'normal' && !isAnyAutocompleteOpen && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const ta = textareaRef.current;
            const selStart = ta?.selectionStart ?? -1;
            const selEnd = ta?.selectionEnd ?? -1;

            if (ta && selStart >= 0) {
                const applyEdit = (next: string, caretStart: number, caretEnd: number) => {
                    e.preventDefault();
                    setMessage(next);
                    requestAnimationFrame(() => {
                        const current = textareaRef.current;
                        if (current) {
                            current.selectionStart = caretStart;
                            current.selectionEnd = caretEnd;
                        }
                        adjustTextareaHeight();
                    });
                    updateAutocompleteState(next, caretEnd);
                };

                // Wrap the current selection: select text, press ` * _ ~ ( [ { " '
                const WRAP_PAIRS: Record<string, [string, string]> = {
                    '`': ['`', '`'], '*': ['*', '*'], '_': ['_', '_'], '~': ['~', '~'],
                    '(': ['(', ')'], '[': ['[', ']'], '{': ['{', '}'],
                    '"': ['"', '"'], "'": ["'", "'"],
                };
                if (selEnd > selStart && WRAP_PAIRS[e.key]) {
                    const [open, close] = WRAP_PAIRS[e.key];
                    const selected = message.slice(selStart, selEnd);
                    const next = `${message.slice(0, selStart)}${open}${selected}${close}${message.slice(selEnd)}`;
                    applyEdit(next, selStart + open.length, selEnd + open.length);
                    return;
                }

                // Typing the third backtick at line start expands into a fenced
                // code block with the caret on the empty middle line (Slack-like).
                if (e.key === '`' && selStart === selEnd) {
                    const before = message.slice(0, selStart);
                    if (/(^|\n)``$/.test(before)) {
                        const after = message.slice(selEnd);
                        const next = `${before}\`\n\n\`\`\`${after}`;
                        const caret = before.length + 2; // after the completed ``` and first newline
                        applyEdit(next, caret, caret);
                        return;
                    }
                }
            }
        }

        if (e.key === 'ArrowUp' && canNavigateHistoryUp && userMessageHistory.length > 0) {
            e.preventDefault();
            if (historyIndex === -1) {
                // Entering history mode - save current input as draft
                setDraftMessage(message);
                setHistoryIndex(0);
                setMessage(userMessageHistory[0]);
            } else if (historyIndex < userMessageHistory.length - 1) {
                // Navigate to older message
                const newIndex = historyIndex + 1;
                setHistoryIndex(newIndex);
                setMessage(userMessageHistory[newIndex]);
            }
            // Move cursor to start after history navigation
            requestAnimationFrame(() => {
                textareaRef.current?.setSelectionRange(0, 0);
            });
            // If at oldest message, do nothing
            return;
        }

        if (e.key === 'ArrowDown' && canNavigateHistoryDown && historyIndex >= 0) {
            e.preventDefault();
            if (historyIndex === 0) {
                // Exit history mode - restore draft
                setHistoryIndex(-1);
                setMessage(draftMessage);
                setDraftMessage('');
            } else {
                // Navigate to newer message
                const newIndex = historyIndex - 1;
                setHistoryIndex(newIndex);
                setMessage(userMessageHistory[newIndex]);
            }
            return;
        }

        // Handle Enter/Ctrl+Enter based on selected follow-up behavior.
        if (e.key === 'Enter' && !e.shiftKey && (!isMobile || e.ctrlKey || e.metaKey)) {
            e.preventDefault();

            const isCtrlEnter = e.ctrlKey || e.metaKey;

            // Queueing / steering only works when there's an existing busy
            // session (or an active auto-review run).
            const canQueue = inputMode === 'normal' && hasContent && currentSessionId && (sessionPhase !== 'idle' || autoReviewRunning);

            if (followUpBehavior === 'queue') {
                if (isCtrlEnter || !canQueue) {
                    handleSubmit();
                } else {
                    handleQueueMessage();
                }
            } else {
                // steer: Enter steers into the running turn, Ctrl+Enter sends now.
                if (isCtrlEnter || !canQueue) {
                    handleSubmit();
                } else {
                    handleSubmit({ delivery: 'steer' });
                }
            }
        }
    };

    const measureCaretInTextarea = React.useCallback((textarea: HTMLTextAreaElement, cursorPosition: number) => {
        const doc = textarea.ownerDocument;
        const win = doc.defaultView;
        if (!win) return null;

        const style = win.getComputedStyle(textarea);
        const mirror = doc.createElement('div');
        const mirrorStyle = mirror.style;

        mirrorStyle.position = 'absolute';
        mirrorStyle.visibility = 'hidden';
        mirrorStyle.pointerEvents = 'none';
        mirrorStyle.whiteSpace = 'pre-wrap';
        mirrorStyle.wordWrap = 'break-word';
        mirrorStyle.overflow = 'hidden';
        mirrorStyle.left = '-9999px';
        mirrorStyle.top = '0';

        mirrorStyle.width = `${textarea.clientWidth}px`;
        mirrorStyle.font = style.font;
        mirrorStyle.fontSize = style.fontSize;
        mirrorStyle.fontFamily = style.fontFamily;
        mirrorStyle.fontWeight = style.fontWeight;
        mirrorStyle.fontStyle = style.fontStyle;
        mirrorStyle.fontVariant = style.fontVariant;
        mirrorStyle.letterSpacing = style.letterSpacing;
        mirrorStyle.textTransform = style.textTransform;
        mirrorStyle.textIndent = style.textIndent;
        mirrorStyle.padding = style.padding;
        mirrorStyle.border = style.border;
        mirrorStyle.boxSizing = style.boxSizing;
        mirrorStyle.lineHeight = style.lineHeight;
        mirrorStyle.tabSize = style.tabSize;

        mirror.textContent = textarea.value.slice(0, cursorPosition);
        const marker = doc.createElement('span');
        marker.textContent = textarea.value.slice(cursorPosition, cursorPosition + 1) || ' ';
        mirror.appendChild(marker);

        doc.body.appendChild(mirror);
        const top = marker.offsetTop;
        const left = marker.offsetLeft;
        doc.body.removeChild(mirror);

        return { top, left };
    }, []);

    const updateAutocompleteOverlayPosition = React.useCallback(() => {
        if (!isDesktopExpanded) {
            setAutocompleteOverlayPosition(null);
            return;
        }

        if (!showCommandAutocomplete && !showSkillAutocomplete && !showSnippetAutocomplete && !showFileMention) {
            setAutocompleteOverlayPosition(null);
            return;
        }

        const textarea = textareaRef.current;
        const container = dropZoneRef.current;
        if (!textarea || !container) return;

        const cursor = textarea.selectionStart ?? message.length;
        const caret = measureCaretInTextarea(textarea, cursor);
        if (!caret) return;

        const textareaRect = textarea.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        const caretY = textareaRect.top - containerRect.top + (caret.top - textarea.scrollTop);
        const caretX = textareaRect.left - containerRect.left + (caret.left - textarea.scrollLeft);

        const popupMargin = 8;
        const estimatedPopupHeight = 260;
        const spaceAbove = caretY - popupMargin;
        const spaceBelow = containerRect.height - caretY - popupMargin;
        const place: 'above' | 'below' = spaceBelow >= estimatedPopupHeight || spaceBelow >= spaceAbove ? 'below' : 'above';

        const desiredWidth = showFileMention ? 520 : showCommandAutocomplete || showSnippetAutocomplete ? 450 : 360;
        const clampedLeft = Math.max(
            popupMargin,
            Math.min(caretX - 24, containerRect.width - desiredWidth - popupMargin)
        );

        const maxHeight = Math.max(120, Math.min(estimatedPopupHeight, place === 'below' ? spaceBelow : spaceAbove));

        setAutocompleteOverlayPosition({
            top: place === 'below' ? caretY + 22 : caretY - 6,
            left: clampedLeft,
            place,
            maxHeight,
        });
    }, [
        isDesktopExpanded,
        measureCaretInTextarea,
        message.length,
        showCommandAutocomplete,
        showFileMention,
        showSnippetAutocomplete,
        showSkillAutocomplete,
    ]);

    React.useLayoutEffect(() => {
        updateAutocompleteOverlayPosition();
    }, [
        updateAutocompleteOverlayPosition,
        message,
        showCommandAutocomplete,
        showSkillAutocomplete,
        showSnippetAutocomplete,
        showFileMention,
        isDesktopExpanded,
    ]);

    React.useEffect(() => {
        if (!isDesktopExpanded) return;
        const onResize = () => updateAutocompleteOverlayPosition();
        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
        };
    }, [isDesktopExpanded, updateAutocompleteOverlayPosition]);

    const startAbortIndicator = React.useCallback(() => {
        if (abortTimeoutRef.current) {
            clearTimeout(abortTimeoutRef.current);
            abortTimeoutRef.current = null;
        }

        setShowAbortStatus(true);

        abortTimeoutRef.current = setTimeout(() => {
            setShowAbortStatus(false);
            abortTimeoutRef.current = null;
        }, 1800);
    }, []);

    const handleAbort = React.useCallback(() => {
        clearAbortPrompt();
        startAbortIndicator();

        void abortCurrentOperation(currentSessionId || undefined);
    }, [abortCurrentOperation, clearAbortPrompt, currentSessionId, startAbortIndicator]);

    const handleCycleAgent = React.useCallback((direction: 1 | -1 = 1) => {
        const nextAgentName = getCycledPrimaryAgentName(agents, currentAgentName, direction);
        if (!nextAgentName) return;

        setAgent(nextAgentName);

        if (currentSessionId) {
            saveSessionAgentSelection(currentSessionId, nextAgentName);
        }
    }, [agents, currentAgentName, currentSessionId, setAgent, saveSessionAgentSelection]);

    // Height the dictation transcript needs (null when idle): the overlay sits
    // absolutely over the composer, so the underlying textarea must grow for
    // the composer to grow — feed this into the autosize below.
    const dictationContentHeightRef = React.useRef<number | null>(null);
    const [dictationContentHeight, setDictationContentHeight] = React.useState<number | null>(null);
    const handleDictationContentHeightChange = React.useCallback((height: number | null) => {
        setDictationContentHeight((prev) => (prev === height ? prev : height));
    }, []);

    const adjustTextareaHeight = React.useCallback((options?: { allowShrink?: boolean }) => {
        const textarea = textareaRef.current;
        if (!textarea) {
            return;
        }

        const previousScrollTop = textarea.scrollTop;

        if (isComposerExpanded) {
            textarea.style.height = '100%';
            textarea.style.maxHeight = 'none';
            setTextareaSize(null);
            if (textarea.scrollTop !== previousScrollTop) {
                textarea.scrollTop = previousScrollTop;
            }
            return;
        }

        if (options?.allowShrink ?? true) {
            textarea.style.height = 'auto';
        }

        const view = textarea.ownerDocument?.defaultView;
        const computedStyle = view ? view.getComputedStyle(textarea) : null;
        const lineHeight = computedStyle ? parseFloat(computedStyle.lineHeight) : NaN;
        const paddingTop = computedStyle ? parseFloat(computedStyle.paddingTop) : NaN;
        const paddingBottom = computedStyle ? parseFloat(computedStyle.paddingBottom) : NaN;
        const fallbackLineHeight = 22;
        const fallbackPadding = 16;
        const paddingTotal = Number.isNaN(paddingTop) || Number.isNaN(paddingBottom)
            ? fallbackPadding
            : paddingTop + paddingBottom;
        const targetLineHeight = Number.isNaN(lineHeight) ? fallbackLineHeight : lineHeight;
        const maxHeight = targetLineHeight * MAX_VISIBLE_TEXTAREA_LINES + paddingTotal;
        const scrollHeight = textarea.scrollHeight || textarea.offsetHeight;
        const dictationHeight = dictationContentHeightRef.current ?? 0;
        const nextHeight = Math.min(Math.max(scrollHeight, dictationHeight), maxHeight);

        textarea.style.height = `${nextHeight}px`;
        textarea.style.maxHeight = `${maxHeight}px`;
        if (textarea.scrollTop !== previousScrollTop) {
            textarea.scrollTop = previousScrollTop;
        }

        setTextareaSize((prev) => {
            if (prev && prev.height === nextHeight && prev.maxHeight === maxHeight) {
                return prev;
            }
            return { height: nextHeight, maxHeight };
        });
    }, [isComposerExpanded]);

    React.useLayoutEffect(() => {
        const allowShrink = message.length < previousMessageLengthRef.current;
        previousMessageLengthRef.current = message.length;
        adjustTextareaHeight({ allowShrink });
    }, [adjustTextareaHeight, message, isMobile]);

    React.useLayoutEffect(() => {
        dictationContentHeightRef.current = dictationContentHeight;
        // Growing transcript never shrinks mid-recording (matches typing);
        // dictation ending (null) releases the height back to the message.
        adjustTextareaHeight({ allowShrink: dictationContentHeight === null });
    }, [adjustTextareaHeight, dictationContentHeight]);

    const updateAutocompleteState = React.useCallback((
        value: string,
        cursorPosition: number,
        inputSource: FileMentionAutocompleteInputSource = 'manual',
        insertedText?: string,
    ) => {
        if (inputMode === 'shell') {
            setShowCommandAutocomplete(false);
            setShowFileMention(false);
            setShowSkillAutocomplete(false);
            setShowSnippetAutocomplete(false);
            return;
        }

        if (value.startsWith('/')) {
            const firstSpace = value.indexOf(' ');
            const firstNewline = value.indexOf('\n');
            const commandEnd = Math.min(
                firstSpace === -1 ? value.length : firstSpace,
                firstNewline === -1 ? value.length : firstNewline
            );

            if (cursorPosition <= commandEnd && firstSpace === -1) {
                const commandText = value.substring(1, commandEnd);
                setCommandQuery(commandText);
                setShowCommandAutocomplete(true);
                setShowFileMention(false);
                setShowSkillAutocomplete(false);
                setShowSnippetAutocomplete(false);
                return;
            }
        }

        setShowCommandAutocomplete(false);

        const textBeforeCursor = value.substring(0, cursorPosition);

        const lastSlashSymbol = textBeforeCursor.lastIndexOf('/');
        if (lastSlashSymbol !== -1) {
            const charBefore = lastSlashSymbol > 0 ? textBeforeCursor[lastSlashSymbol - 1] : null;
            const textAfterSlash = textBeforeCursor.substring(lastSlashSymbol + 1);
            const hasSeparator = textAfterSlash.includes(' ') || textAfterSlash.includes('\n');
            const isWordBoundary = !charBefore || /\s/.test(charBefore);

            if (isWordBoundary && !hasSeparator) {
                setSkillQuery(textAfterSlash);
                setShowSkillAutocomplete(true);
                setShowFileMention(false);
                return;
            }
        }

        setShowSkillAutocomplete(false);
        setSkillQuery('');

        const lastHashSymbol = textBeforeCursor.lastIndexOf('#');
        if (lastHashSymbol !== -1) {
            const charBefore = lastHashSymbol > 0 ? textBeforeCursor[lastHashSymbol - 1] : null;
            const textAfterHash = textBeforeCursor.substring(lastHashSymbol + 1);
            const isWordBoundary = !charBefore || /\s/.test(charBefore);
            if (isWordBoundary && !textAfterHash.includes(' ') && !textAfterHash.includes('\n')) {
                setSnippetQuery(textAfterHash);
                setShowSnippetAutocomplete(true);
                setShowFileMention(false);
                return;
            }
        }

        setShowSnippetAutocomplete(false);

        const nextMentionQuery = getFileMentionAutocompleteQuery({ value, cursorPosition, inputSource, insertedText });
        if (nextMentionQuery === null) {
            setShowFileMention(false);
        } else {
            setMentionQuery(nextMentionQuery);
            setShowFileMention(true);
        }
    }, [
        inputMode,
        setCommandQuery,
        setMentionQuery,
        setShowCommandAutocomplete,
        setShowFileMention,
        setShowSkillAutocomplete,
        setShowSnippetAutocomplete,
        setSkillQuery,
        setSnippetQuery,
    ]);

    const insertTextAtSelection = React.useCallback((
        text: string,
        inputSource: FileMentionAutocompleteInputSource = 'manual',
    ) => {
        if (!text) {
            return;
        }

        const textarea = textareaRef.current;
        if (!textarea) {
            const nextValue = message + text;
            setMessage(nextValue);
            updateAutocompleteState(nextValue, nextValue.length, inputSource, text);
            requestAnimationFrame(() => adjustTextareaHeight());
            return;
        }

        const start = textarea.selectionStart ?? message.length;
        const end = textarea.selectionEnd ?? message.length;
        const nextValue = `${message.substring(0, start)}${text}${message.substring(end)}`;
        setMessage(nextValue);
        const cursorPosition = start + text.length;

        requestAnimationFrame(() => {
            const currentTextarea = textareaRef.current;
            if (currentTextarea) {
                currentTextarea.selectionStart = cursorPosition;
                currentTextarea.selectionEnd = cursorPosition;
            }
            adjustTextareaHeight();
        });

        updateAutocompleteState(nextValue, cursorPosition, inputSource, text);
    }, [adjustTextareaHeight, message, updateAutocompleteState]);

    const clearDropTextSuppression = React.useCallback(() => {
        suppressNextFileDropTextInsertRef.current = false;
        pendingDroppedAbsolutePathsRef.current = [];
        if (suppressNextFileDropTextInsertTimeoutRef.current) {
            clearTimeout(suppressNextFileDropTextInsertTimeoutRef.current);
            suppressNextFileDropTextInsertTimeoutRef.current = null;
        }
    }, []);

    const scheduleDropTextSuppressionExpiry = React.useCallback(() => {
        if (suppressNextFileDropTextInsertTimeoutRef.current) {
            clearTimeout(suppressNextFileDropTextInsertTimeoutRef.current);
        }
        suppressNextFileDropTextInsertTimeoutRef.current = setTimeout(() => {
            clearDropTextSuppression();
        }, 700);
    }, [clearDropTextSuppression]);

    const clearFileMentionPasteSuppression = React.useCallback(() => {
        suppressNextFileMentionPasteRef.current = false;
        if (suppressNextFileMentionPasteTimeoutRef.current) {
            clearTimeout(suppressNextFileMentionPasteTimeoutRef.current);
            suppressNextFileMentionPasteTimeoutRef.current = null;
        }
    }, []);

    const markFileMentionPasteSuppression = React.useCallback(() => {
        suppressNextFileMentionPasteRef.current = true;
        if (suppressNextFileMentionPasteTimeoutRef.current) {
            clearTimeout(suppressNextFileMentionPasteTimeoutRef.current);
        }
        suppressNextFileMentionPasteTimeoutRef.current = setTimeout(() => {
            suppressNextFileMentionPasteRef.current = false;
            suppressNextFileMentionPasteTimeoutRef.current = null;
        }, 700);
    }, []);

    const handleBeforeInput = React.useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
        if (!isVSCodeRuntime() || !suppressNextFileDropTextInsertRef.current) {
            return;
        }

        const nativeInputEvent = e.nativeEvent as InputEvent | undefined;
        if (nativeInputEvent?.inputType === 'insertFromDrop') {
            e.preventDefault();
            clearDropTextSuppression();
        }
    }, [clearDropTextSuppression]);

    const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const nativeInputEvent = e.nativeEvent as InputEvent | undefined;
        if (isVSCodeRuntime() && suppressNextFileDropTextInsertRef.current) {
            const candidateAbsolutePaths = pendingDroppedAbsolutePathsRef.current;
            const isLikelyDropTextInsertion = nativeInputEvent?.inputType === 'insertFromDrop'
                || candidateAbsolutePaths.some((path) => path.length > 0 && e.target.value.includes(path));

            if (isLikelyDropTextInsertion) {
                clearDropTextSuppression();
                return;
            }
        }

        const value = e.target.value;
        const cursorPosition = e.target.selectionStart ?? value.length;
        const pastedInsertedText = nativeInputEvent?.inputType?.startsWith('insertFromPaste')
            ? getInsertedTextFromChange(messageRef.current, value)
            : '';
        const isPasteInput = pastedInsertedText.includes('@') || suppressNextFileMentionPasteRef.current;
        if (suppressNextFileMentionPasteRef.current) {
            clearFileMentionPasteSuppression();
        }
        const inputSource: FileMentionAutocompleteInputSource = isPasteInput
            ? 'paste'
            : 'manual';

        if (inputMode === 'normal' && value.startsWith('!')) {
            const shellCommand = value.slice(1);
            const nextCursor = Math.max(0, cursorPosition - 1);
            setInputMode('shell');
            setMessage(shellCommand);
            adjustTextareaHeight();
            setShowCommandAutocomplete(false);
            setShowSkillAutocomplete(false);
            setShowFileMention(false);
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = nextCursor;
                    textareaRef.current.selectionEnd = nextCursor;
                }
            });
            return;
        }

        setMessage(value);
        adjustTextareaHeight();
        updateAutocompleteState(value, cursorPosition, inputSource, pastedInsertedText);
    };

    React.useEffect(() => {
        return () => {
            clearDropTextSuppression();
            clearFileMentionPasteSuppression();
        };
    }, [clearDropTextSuppression, clearFileMentionPasteSuppression]);

    const handlePaste = React.useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        // Pasting a URL over a selection wraps it as a markdown link:
        // [selected text](pasted url).
        if (inputMode === 'normal' && (currentSessionId || newSessionDraftOpen)) {
            const ta = textareaRef.current;
            const selStart = ta?.selectionStart ?? -1;
            const selEnd = ta?.selectionEnd ?? -1;
            if (ta && selEnd > selStart) {
                const clipboardText = e.clipboardData.getData('text');
                const url = clipboardText.trim();
                const selected = message.slice(selStart, selEnd);
                if (
                    PASTE_LINK_URL_PATTERN.test(url)
                    && !/\s/.test(url)
                    && selected.trim().length > 0
                    && !selected.includes('](')
                ) {
                    e.preventDefault();
                    const next = `${message.slice(0, selStart)}[${selected}](${url})${message.slice(selEnd)}`;
                    const caret = selStart + 1 + selected.length + 2 + url.length + 1;
                    setMessage(next);
                    requestAnimationFrame(() => {
                        const current = textareaRef.current;
                        if (current) {
                            current.selectionStart = caret;
                            current.selectionEnd = caret;
                        }
                        adjustTextareaHeight();
                    });
                    updateAutocompleteState(next, caret, getFileMentionInputSourceForInsertedText(url), url);
                    return;
                }
            }
        }

        const fileMap = new Map<string, File>();

        Array.from(e.clipboardData.files || []).forEach(file => {
            if (file.type.startsWith('image/')) {
                fileMap.set(`${file.name}-${file.size}`, file);
            }
        });

        Array.from(e.clipboardData.items || []).forEach(item => {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) {
                    fileMap.set(`${file.name}-${file.size}`, file);
                }
            }
        });

        const imageFiles = Array.from(fileMap.values());
        const pastedText = e.clipboardData.getData('text');
        if (imageFiles.length === 0) {
            if (pastedText.includes('@')) {
                markFileMentionPasteSuppression();
            }
            return;
        }

        if (!currentSessionId && !newSessionDraftOpen) {
            if (pastedText.includes('@')) {
                markFileMentionPasteSuppression();
            }
            return;
        }

        e.preventDefault();

        const assignedFilenames = assignImageAttachmentFilenames(
            imageFiles,
            [
                ...attachedFiles.map((file) => file.filename),
                ...pendingPastedAttachmentFilenamesRef.current,
            ],
        );
        const citationText = buildAttachmentCitationText(assignedFilenames);
        const textarea = textareaRef.current;
        const selectionStart = textarea?.selectionStart ?? message.length;
        const selectionEnd = textarea?.selectionEnd ?? message.length;
        const insertionText = withInlineInsertionBoundaries(
            buildImagePasteInsertion(pastedText, citationText),
            message.slice(0, selectionStart),
            message.slice(selectionEnd),
        );

        insertTextAtSelection(insertionText, getFileMentionInputSourceForInsertedText(insertionText));

        for (let index = 0; index < imageFiles.length; index += 1) {
            const filename = assignedFilenames[index];
            const file = renameFileForAttachmentCitation(imageFiles[index], filename);
            pendingPastedAttachmentFilenamesRef.current.add(filename);
            try {
                await addAttachedFile(file);
            } catch (error) {
                console.error('Clipboard image attach failed', error);
                toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.clipboardAttachFailed'));
            } finally {
                pendingPastedAttachmentFilenamesRef.current.delete(filename);
            }
        }
    }, [addAttachedFile, attachedFiles, adjustTextareaHeight, currentSessionId, inputMode, markFileMentionPasteSuppression, message, newSessionDraftOpen, insertTextAtSelection, setMessage, t, updateAutocompleteState]);

    const handleFileSelect = (file: { name: string; path: string; relativePath?: string }) => {

        const cursorPosition = textareaRef.current?.selectionStart || 0;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

        const mentionPath = (file.relativePath && file.relativePath.trim().length > 0)
            ? file.relativePath.trim()
            : (toProjectRelativeMentionPath(file.path) || file.name);

        confirmedMentionsRef.current.add(mentionPath);

        if (lastAtSymbol !== -1) {
            const newMessage =
                message.substring(0, lastAtSymbol) +
                `@${mentionPath} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);
            const nextCursor = lastAtSymbol + mentionPath.length + 2;
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = nextCursor;
                    textareaRef.current.selectionEnd = nextCursor;
                }
                adjustTextareaHeight();
                updateAutocompleteState(newMessage, nextCursor);
            });
        } else if (textareaRef.current) {
            const newMessage =
                message.substring(0, cursorPosition) +
                `@${mentionPath} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);
            const nextCursor = cursorPosition + mentionPath.length + 2;
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = nextCursor;
                    textareaRef.current.selectionEnd = nextCursor;
                }
                adjustTextareaHeight();
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        setShowFileMention(false);
        setMentionQuery('');

        textareaRef.current?.focus();
    };

    const handleAgentSelect = (agentName: string) => {
        const textarea = textareaRef.current;
        const cursorPosition = textarea?.selectionStart ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

        if (lastAtSymbol !== -1) {
            const newMessage =
                message.substring(0, lastAtSymbol) +
                `@${agentName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = lastAtSymbol + agentName.length + 2;
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = nextCursor;
                    textareaRef.current.selectionEnd = nextCursor;
                }
                adjustTextareaHeight();
                updateAutocompleteState(newMessage, nextCursor);
            });
        } else if (textareaRef.current) {
            const newMessage =
                message.substring(0, cursorPosition) +
                `@${agentName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = cursorPosition + agentName.length + 2;
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = nextCursor;
                    textareaRef.current.selectionEnd = nextCursor;
                }
                adjustTextareaHeight();
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        setShowFileMention(false);
        setMentionQuery('');

        textareaRef.current?.focus();
    };

    const handleSkillSelect = (skillName: string) => {
        const textarea = textareaRef.current;
        const cursorPosition = textarea?.selectionStart ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastSlashSymbol = textBeforeCursor.lastIndexOf('/');

        if (lastSlashSymbol !== -1) {
            const newMessage =
                message.substring(0, lastSlashSymbol) +
                `/${skillName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = lastSlashSymbol + skillName.length + 2;
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = nextCursor;
                    textareaRef.current.selectionEnd = nextCursor;
                }
                adjustTextareaHeight();
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        setShowSkillAutocomplete(false);
        setSkillQuery('');

        textareaRef.current?.focus();
    };

    const handleSnippetSelect = (_snippet: unknown, trigger: string) => {
        const textarea = textareaRef.current;
        const cursorPosition = textarea?.selectionStart ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastHashSymbol = textBeforeCursor.lastIndexOf('#');
        const startIndex = lastHashSymbol !== -1 ? lastHashSymbol : cursorPosition;
        const newMessage = `${message.substring(0, startIndex)}#${trigger} ${message.substring(cursorPosition)}`;
        setMessage(newMessage);
        const nextCursor = startIndex + trigger.length + 2;
        requestAnimationFrame(() => {
            if (textareaRef.current) {
                textareaRef.current.selectionStart = nextCursor;
                textareaRef.current.selectionEnd = nextCursor;
            }
            adjustTextareaHeight();
            updateAutocompleteState(newMessage, nextCursor);
        });
        setShowSnippetAutocomplete(false);
        setSnippetQuery('');
        textareaRef.current?.focus();
    };

    const handleCommandSelect = (command: CommandInfo) => {

        setMessage(`/${command.name} `);

        const textareaElement = textareaRef.current as HTMLTextAreaElement & { _commandMetadata?: typeof command };
        if (textareaElement) {
            textareaElement._commandMetadata = command;
        }

        setShowCommandAutocomplete(false);
        setCommandQuery('');

        const refocus = () => {
            if (textareaRef.current) {
                try {
                    textareaRef.current.focus({ preventScroll: true });
                } catch {
                    textareaRef.current.focus();
                }
                textareaRef.current.setSelectionRange(textareaRef.current.value.length, textareaRef.current.value.length);
            }
        };

        requestAnimationFrame(() => {
            refocus();
            requestAnimationFrame(refocus);
        });
        setTimeout(refocus, 60);
    };

    React.useEffect(() => {

        if (currentSessionId && textareaRef.current && !isMobile) {
            textareaRef.current.focus();
        }
    }, [currentSessionId, isMobile]);

    React.useEffect(() => {
        if (!isMobile) {
            setMobileControlsPanel(null);
        }
    }, [isMobile]);

    React.useEffect(() => {
        if (abortPromptSessionId && abortPromptSessionId !== currentSessionId) {
            clearAbortPrompt();
        }
    }, [abortPromptSessionId, currentSessionId, clearAbortPrompt]);

    React.useEffect(() => {
        canAcceptDropRef.current = Boolean(currentSessionId || newSessionDraftOpen);
    }, [currentSessionId, newSessionDraftOpen]);

    const hasDraggedFiles = React.useCallback((dataTransfer: DataTransfer | null | undefined): boolean => {
        if (!dataTransfer) return false;
        if (dataTransfer.files && dataTransfer.files.length > 0) return true;
        if (dataTransfer.types) {
            const types = Array.from(dataTransfer.types);
            const lowerTypes = types.map((type) => type.toLowerCase());
            if (lowerTypes.includes('files')) return true;
            if (lowerTypes.includes('text/uri-list')) return true;
            if (lowerTypes.includes('codefiles')) return true;
            if (lowerTypes.includes('application/x-openchamber-file-path')) return true;
            if (lowerTypes.some((type) => type.includes('vnd.code.tree'))) return true;
        }

        for (const dataType of VS_CODE_DROP_DATA_TYPES) {
            let payload = '';
            try {
                payload = dataTransfer.getData(dataType);
            } catch {
                continue;
            }
            if (payload && parseDroppedFileReferences(payload).length > 0) {
                return true;
            }
        }

        return false;
    }, []);

    const collectDroppedFiles = React.useCallback((dataTransfer: DataTransfer | null | undefined): File[] => {
        if (!dataTransfer) return [];

        const directFiles = Array.from(dataTransfer.files || []);
        if (directFiles.length > 0) {
            return directFiles;
        }

        const fromItems = Array.from(dataTransfer.items || [])
            .filter((item) => item.kind === 'file')
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));

        return fromItems;
    }, []);

    const collectDroppedFileUris = React.useCallback((dataTransfer: DataTransfer | null | undefined): string[] => {
        if (!dataTransfer || typeof dataTransfer.getData !== 'function') return [];

        const extracted = new Set<string>();

        for (const dataType of VS_CODE_DROP_DATA_TYPES) {
            let rawPayload = '';
            try {
                rawPayload = dataTransfer.getData(dataType);
            } catch {
                continue;
            }
            if (!rawPayload) {
                continue;
            }

            for (const candidate of parseDroppedFileReferences(rawPayload)) {
                extracted.add(candidate);
            }
        }

        return Array.from(extracted);
    }, []);

    const normalizeDroppedPath = React.useCallback((rawPath: string): string => {
        const input = rawPath.trim();
        if (!input.toLowerCase().startsWith('file://')) {
            return input;
        }

        try {
            let pathname = decodeURIComponent(new URL(input).pathname || '');
            if (/^\/[A-Za-z]:\//.test(pathname)) {
                pathname = pathname.slice(1);
            }
            return pathname || input;
        } catch {
            const stripped = input.replace(/^file:\/\//i, '');
            try {
                return decodeURIComponent(stripped);
            } catch {
                return stripped;
            }
        }
    }, []);

    const toProjectRelativeMentionPath = React.useCallback((absolutePath: string): string => {
        const normalizedAbsolutePath = absolutePath.replace(/\\/g, '/').trim();
        const normalizedRoot = (chatSearchDirectory || '').replace(/\\/g, '/').replace(/\/+$/, '');
        if (!normalizedRoot) {
            return normalizedAbsolutePath;
        }
        if (normalizedAbsolutePath === normalizedRoot) {
            return normalizedAbsolutePath;
        }
        const rootWithSlash = `${normalizedRoot}/`;
        if (normalizedAbsolutePath.startsWith(rootWithSlash)) {
            return normalizedAbsolutePath.slice(rootWithSlash.length);
        }
        return normalizedAbsolutePath;
    }, [chatSearchDirectory]);

    const addVSCodeDroppedUrisAsMentions = React.useCallback((uris: string[]) => {
        if (uris.length === 0) return;

        const paths = uris
            .map((entry) => normalizeDroppedPath(entry))
            .map((entry) => toProjectRelativeMentionPath(entry))
            .map((entry) => entry.trim().replace(/^\.\//, ''))
            .filter((entry) => entry.length > 0);

        for (const p of paths) {
            confirmedMentionsRef.current.add(p);
        }

        const mentions = Array.from(new Set(paths.map((entry) => `@${entry}`)));

        if (mentions.length === 0) {
            return;
        }

        setPendingInputText(mentions.join(' '), 'append-inline');
        toast.success(t('chat.chatInput.toast.addedFileMentions', { count: mentions.length }));
    }, [normalizeDroppedPath, setPendingInputText, t, toProjectRelativeMentionPath]);

    const handleDragEnter = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        dragEnterCountRef.current++;
        const isInternal = e.dataTransfer.types?.includes('application/x-openchamber-file-path') ?? false;
        if (isInternal !== isInternalDrag) {
            setIsInternalDrag(isInternal);
        }
        if ((currentSessionId || newSessionDraftOpen) && !isDragging) {
            setIsDragging(true);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        if ((currentSessionId || newSessionDraftOpen) && !isDragging) {
            setIsDragging(true);
        }
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragEnterCountRef.current--;
        if (dragEnterCountRef.current <= 0) {
            dragEnterCountRef.current = 0;
            setIsDragging(false);
            setIsInternalDrag(false);
            clearDropTextSuppression();
        }
    };

    const handleDragEnd = () => {
        dragEnterCountRef.current = 0;
        setIsDragging(false);
        setIsInternalDrag(false);
        clearDropTextSuppression();
    };

    const handleDrop = async (e: React.DragEvent) => {
        dragEnterCountRef.current = 0;
        const draggedFiles = hasDraggedFiles(e.dataTransfer);
        if (!draggedFiles) {
            clearDropTextSuppression();
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);

        if (!currentSessionId && !newSessionDraftOpen) return;

        // Internal drag: file tree → chat input (relative path as @mention)
        const internalPath = e.dataTransfer.getData('application/x-openchamber-file-path');
        if (internalPath && internalPath !== '.') {
            confirmedMentionsRef.current.add(internalPath);
            const mention = `@${internalPath}`;
            const textarea = textareaRef.current;
            const currentMessage = messageRef.current;
            if (textarea) {
                const pos = textarea.selectionStart ?? cursorPosRef.current;
                const end = textarea.selectionEnd ?? pos;
                const before = currentMessage.slice(0, pos);
                const after = currentMessage.slice(end);
                const needSpaceBefore = before.length > 0 && !/\s$/.test(before);
                const needSpaceAfter = after.length > 0 && !/^\s/.test(after);
                const insert = `${needSpaceBefore ? ' ' : ''}${mention}${needSpaceAfter ? ' ' : ''}`;
                const nextMessage = `${before}${insert}${after}`;
                setMessage(nextMessage);
                requestAnimationFrame(() => {
                    const cursorPos = pos + insert.length;
                    textarea.selectionStart = cursorPos;
                    textarea.selectionEnd = cursorPos;
                    cursorPosRef.current = cursorPos;
                    textarea.focus();
                });
            } else {
                setMessage((prev) => appendInlineText(prev, mention));
            }
            clearDropTextSuppression();
            return;
        }

        const files = collectDroppedFiles(e.dataTransfer);

        if (files.length === 0 && isVSCodeRuntime()) {
            const droppedUris = collectDroppedFileUris(e.dataTransfer);
            if (droppedUris.length > 0) {
                pendingDroppedAbsolutePathsRef.current = droppedUris
                    .map((entry) => normalizeDroppedPath(entry))
                    .map((entry) => entry.trim())
                    .filter((entry) => entry.length > 0);
                addVSCodeDroppedUrisAsMentions(droppedUris);
            } else {
                clearDropTextSuppression();
            }
            return;
        }

        if (files.length > 0) {
            for (const file of files) {
                try {
                    await addAttachedFile(file);
                } catch (error) {
                    console.error('File attach failed', error);
                    toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.attachFileFailed'));
                }
            }
        }
        clearDropTextSuppression();
    };

    const handleDropCapture = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        // Prevent native textarea drop text insertion for all runtimes
        e.preventDefault();
        if (isVSCodeRuntime()) {
            suppressNextFileDropTextInsertRef.current = true;
            scheduleDropTextSuppressionExpiry();
        }
    };

    const fileInputRef = React.useRef<HTMLInputElement>(null);

    const attachFiles = React.useCallback(async (files: FileList | File[]) => {
        const list = Array.isArray(files) ? files : Array.from(files);

        for (const file of list) {
            try {
                await addAttachedFile(file);
            } catch (error) {
                console.error('File attach failed', error);
                toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.attachFileFailed'));
            }
        }
    }, [addAttachedFile, t]);

    const handleVSCodePickFiles = React.useCallback(async () => {
        try {
            const data = (await vscodeApi?.pickFiles?.()) as {
                files?: Array<{ name: string; mimeType?: string; dataUrl?: string }>;
                skipped?: Array<{ name?: string; reason?: string }>;
            } | undefined;
            const picked = Array.isArray(data?.files) ? data.files : [];
            const skipped = Array.isArray(data?.skipped) ? data.skipped : [];

            if (skipped.length > 0) {
                const summary = skipped
                    .map((s: { name?: string; reason?: string }) => `${s?.name || 'file'}: ${s?.reason || 'skipped'}`)
                    .join('\n');
                toast.error(t('chat.chatInput.toast.someFilesSkipped', { summary }));
            }

            const asFiles = picked
                .map((file: { name: string; mimeType?: string; dataUrl?: string }) => {
                    if (!file?.dataUrl) return null;
                    try {
                        const [meta, base64] = file.dataUrl.split(',');
                        const mime = file.mimeType || (meta?.match(/data:(.*);base64/)?.[1] || 'application/octet-stream');
                        if (!base64) return null;
                        const binary = atob(base64);
                        const bytes = new Uint8Array(binary.length);
                        for (let i = 0; i < binary.length; i++) {
                            bytes[i] = binary.charCodeAt(i);
                        }
                        const blob = new Blob([bytes], { type: mime });
                        return new File([blob], file.name || 'file', { type: mime });
                    } catch (err) {
                        console.error('Failed to decode VS Code picked file', err);
                        return null;
                    }
                })
                .filter(Boolean) as File[];

            if (asFiles.length > 0) {
                await attachFiles(asFiles);
            }
        } catch (error) {
            console.error('VS Code file pick failed', error);
            toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.vscodePickFailed'));
        }
    }, [attachFiles, t, vscodeApi]);

    const handlePickLocalFiles = React.useCallback(() => {
        if (isVSCodeRuntime()) {
            void handleVSCodePickFiles();
            return;
        }
        fileInputRef.current?.click();
    }, [handleVSCodePickFiles]);

    const handleLocalFileSelect = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files) return;
        await attachFiles(files);
        event.target.value = '';
    }, [attachFiles]);

    const footerGapClass = 'gap-x-1.5 gap-y-0';
    const isVSCode = isVSCodeRuntime();
    const showDraftTargetSelectors = newSessionDraftOpen && !isVSCode;

    const selectedDraftProject = React.useMemo(() => {
        const explicit = newSessionDraft?.selectedProjectId
            ? projects.find((project) => project.id === newSessionDraft.selectedProjectId) ?? null
            : null;
        if (explicit) {
            return explicit;
        }

        const active = activeProjectId
            ? projects.find((project) => project.id === activeProjectId) ?? null
            : null;
        if (active) {
            return active;
        }

        return projects[0] ?? null;
    }, [activeProjectId, newSessionDraft?.selectedProjectId, projects]);

    const selectedDraftProjectPath = React.useMemo(
        () => normalizePath(selectedDraftProject?.path ?? null),
        [selectedDraftProject?.path],
    );
    const draftProjectLabel = selectedDraftProject ? getProjectDisplayLabel(selectedDraftProject) : null;

    const selectedDraftProjectBranches = useGitBranches(selectedDraftProjectPath);
    const selectedDraftProjectBranchesFetchedAt = useGitStore(
        (s) => (selectedDraftProjectPath ? s.directories.get(selectedDraftProjectPath)?.lastBranchesFetch ?? 0 : 0),
    );
    const selectedDraftProjectIsGitRepo = useIsGitRepo(selectedDraftProjectPath);
    const hasDraftBranchList = Boolean(selectedDraftProjectBranches?.all);
    const fetchBranches = useGitStore((state) => state.fetchBranches);
    const [isDiscoveringDraftBranches, setIsDiscoveringDraftBranches] = React.useState(false);

    React.useEffect(() => {
        if (!showDraftTargetSelectors || !selectedDraftProjectPath || !runtimeGit || selectedDraftProjectIsGitRepo !== null) {
            return;
        }

        void fetchGitStatus(selectedDraftProjectPath, runtimeGit, { silent: true });
    }, [fetchGitStatus, runtimeGit, selectedDraftProjectIsGitRepo, selectedDraftProjectPath, showDraftTargetSelectors]);

    React.useEffect(() => {
        if (!showDraftTargetSelectors || !selectedDraftProjectPath || !selectedDraftProject || !runtimeGit || selectedDraftProjectIsGitRepo !== true) {
            setIsDiscoveringDraftBranches(false);
            return;
        }

        // Stale-while-revalidate: branches seeded from the persisted cache show
        // instantly. Refresh based on staleness (not mere presence) so a cached
        // list can't go stale, while only showing the discovering spinner when
        // there is nothing to display yet.
        const DRAFT_BRANCHES_SWR_TTL_MS = 30_000;
        const isStale =
            !selectedDraftProjectBranchesFetchedAt ||
            Date.now() - selectedDraftProjectBranchesFetchedAt > DRAFT_BRANCHES_SWR_TTL_MS;

        if (hasDraftBranchList && !isStale) {
            setIsDiscoveringDraftBranches(false);
            return;
        }

        let cancelled = false;
        setIsDiscoveringDraftBranches(!hasDraftBranchList);

        void fetchBranches(selectedDraftProjectPath, runtimeGit)
            .finally(() => {
                if (!cancelled) {
                    setIsDiscoveringDraftBranches(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [fetchBranches, runtimeGit, selectedDraftProject, selectedDraftProjectBranchesFetchedAt, hasDraftBranchList, selectedDraftProjectIsGitRepo, selectedDraftProjectPath, showDraftTargetSelectors]);

    const selectedDraftProjectCurrentBranch = selectedDraftProjectBranches?.current?.trim() ?? '';

    const projectRootBranchOption = React.useMemo(() => {
        if (!selectedDraftProject) {
            return null;
        }
        const value = normalizePath(selectedDraftProject.path);
        if (!value) {
            return null;
        }
        if (!selectedDraftProjectCurrentBranch) {
            return null;
        }
        return {
            value,
            label: selectedDraftProjectCurrentBranch,
        };
    }, [selectedDraftProject, selectedDraftProjectCurrentBranch]);

    const worktreeBranchOptions = React.useMemo(() => {
        if (!selectedDraftProject) {
            return [];
        }

        const worktrees = (() => {
            if (!selectedDraftProjectPath) {
                return [];
            }
            return availableWorktreesByProject.get(selectedDraftProjectPath)
                ?? availableWorktreesByProject.get(selectedDraftProject.path)
                ?? [];
        })();

        return buildSessionTargetOptions({
            projectRoot: normalizePath(selectedDraftProject.path) ?? '',
            rootBranch: selectedDraftProjectCurrentBranch,
            worktrees,
            pendingBootstrapDirectory: newSessionDraft?.bootstrapPendingDirectory ?? null,
        }).filter((option) => option.kind === 'worktree');
    }, [availableWorktreesByProject, newSessionDraft?.bootstrapPendingDirectory, selectedDraftProject, selectedDraftProjectCurrentBranch, selectedDraftProjectPath]);

    const selectedDraftDirectory = React.useMemo(
        () => normalizePath(newSessionDraft?.bootstrapPendingDirectory ?? null)
            ?? normalizePath(newSessionDraft?.directoryOverride ?? null)
            ?? selectedDraftProjectPath,
        [newSessionDraft?.bootstrapPendingDirectory, newSessionDraft?.directoryOverride, selectedDraftProjectPath],
    );

    const shouldKeepMissingSelectedDraftDirectory = React.useMemo(() => {
        const pendingDirectory = normalizePath(newSessionDraft?.bootstrapPendingDirectory ?? null);
        return Boolean(
            newSessionDraft?.preserveDirectoryOverride
            ||
            newSessionDraft?.pendingWorktreeRequestId
            || (pendingDirectory && pendingDirectory === selectedDraftDirectory)
        );
    }, [newSessionDraft?.bootstrapPendingDirectory, newSessionDraft?.pendingWorktreeRequestId, newSessionDraft?.preserveDirectoryOverride, selectedDraftDirectory]);

    const draftBranchItems = React.useMemo(() => {
        const baseItems: Array<{ value: string; label: string }> = [];
        if (projectRootBranchOption) {
            baseItems.push(projectRootBranchOption);
        }
        baseItems.push(...worktreeBranchOptions);

        if (!selectedDraftDirectory) {
            return baseItems;
        }
        if (baseItems.some((option) => option.value === selectedDraftDirectory)) {
            return baseItems;
        }
        if (!shouldKeepMissingSelectedDraftDirectory) {
            return baseItems;
        }
        return [
            ...baseItems,
            { value: selectedDraftDirectory, label: formatDirectoryName(selectedDraftDirectory) },
        ];
    }, [projectRootBranchOption, selectedDraftDirectory, shouldKeepMissingSelectedDraftDirectory, worktreeBranchOptions]);

    const selectedDraftBranchLabel = React.useMemo(() => {
        const selectedValue = selectedDraftDirectory ?? draftBranchItems[0]?.value ?? null;
        if (!selectedValue) {
            return null;
        }
        return draftBranchItems.find((item) => item.value === selectedValue)?.label ?? formatDirectoryName(selectedValue);
    }, [draftBranchItems, selectedDraftDirectory]);

    const chatSurfaceMode = useChatSurfaceMode();
    const isMiniChatSurface = chatSurfaceMode === 'mini-chat';

    const hasPendingChanges = React.useMemo(() => {
        if (isMiniChatSurface) {
            return false;
        }
        if (isGitRepo !== true || !currentGitStatus || currentGitStatus.isClean) {
            return false;
        }
        return extractGitChangedFiles(currentGitStatus.files, currentGitStatus.diffStats, currentDirectory).length > 0;
    }, [currentDirectory, currentGitStatus, isGitRepo, isMiniChatSurface]);

    const selectedDraftBranchIsKnown = React.useMemo(() => {
        if (!selectedDraftDirectory) {
            return true;
        }
        if (projectRootBranchOption?.value === selectedDraftDirectory) {
            return true;
        }
        return worktreeBranchOptions.some((option) => option.value === selectedDraftDirectory);
    }, [projectRootBranchOption?.value, selectedDraftDirectory, worktreeBranchOptions]);

    React.useEffect(() => {
        if (!newSessionDraft?.open || !newSessionDraft?.preserveDirectoryOverride) {
            return;
        }
        if (!selectedDraftDirectory || !selectedDraftBranchIsKnown) {
            return;
        }
        useSessionUIStore.getState().setDraftPreserveDirectoryOverride(false);
    }, [newSessionDraft?.open, newSessionDraft?.preserveDirectoryOverride, selectedDraftBranchIsKnown, selectedDraftDirectory]);

    const shouldShowDraftBranchSelector = React.useMemo(() => {
        if (selectedDraftProjectIsGitRepo !== true) {
            return false;
        }
        if (isDiscoveringDraftBranches) {
            return false;
        }
        if (projectRootBranchOption) {
            return true;
        }
        return worktreeBranchOptions.length > 0;
    }, [isDiscoveringDraftBranches, projectRootBranchOption, selectedDraftProjectIsGitRepo, worktreeBranchOptions.length]);

    const handleDraftProjectChange = React.useCallback((projectId: string) => {
        const draft = useSessionUIStore.getState().newSessionDraft;
        if (draft?.pendingWorktreeRequestId || draft?.bootstrapPendingDirectory || draft?.preserveDirectoryOverride) {
            return;
        }
        const project = projects.find((entry) => entry.id === projectId);
        if (!project) {
            return;
        }
        if (activeProjectId !== projectId) {
            setActiveProjectIdOnly(projectId);
        }
        setNewSessionDraftTarget({
            projectId,
            directoryOverride: project.path,
        }, { force: true });
    }, [activeProjectId, projects, setActiveProjectIdOnly, setNewSessionDraftTarget]);

    const handleDraftDirectoryChange = React.useCallback((directory: string) => {
        const draft = useSessionUIStore.getState().newSessionDraft;
        if (draft?.pendingWorktreeRequestId || draft?.bootstrapPendingDirectory || draft?.preserveDirectoryOverride) {
            return;
        }
        if (!selectedDraftProject) {
            return;
        }
        setNewSessionDraftTarget({
            projectId: selectedDraftProject.id,
            directoryOverride: directory,
        }, { force: true });
    }, [selectedDraftProject, setNewSessionDraftTarget]);

    const renderProjectLabelWithIcon = React.useCallback((project: {
        id: string;
        path: string;
        label?: string;
        icon?: string | null;
        color?: string | null;
        iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
        iconBackground?: string | null;
    }) => {
        const projectIconName = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
        const iconColor = getProjectIconColor(project.color);
        const fallbackIcon = projectIconName ? (
            <Icon name={projectIconName} className="h-3.5 w-3.5 shrink-0" style={iconColor ? { color: iconColor } : undefined} />
        ) : (
            <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80"  style={iconColor ? { color: iconColor } : undefined}/>
        );

        return (
            <span className="inline-flex min-w-0 items-center gap-1.5">
                {project.iconImage ? (
                    <span
                        className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center overflow-hidden rounded-[3px]"
                        style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
                    >
                        <ProjectIconImage
                            project={{ id: project.id, iconImage: project.iconImage ?? null }}
                            options={{
                                themeVariant: currentTheme.metadata.variant,
                                iconColor: currentTheme.colors.surface.foreground,
                            }}
                            className="h-full w-full object-contain"
                            fallback={fallbackIcon}
                        />
                    </span>
                ) : fallbackIcon}
                <span className="truncate">{getProjectDisplayLabel(project)}</span>
            </span>
        );
    }, [currentTheme.colors.surface.foreground, currentTheme.metadata.variant]);

    React.useEffect(() => {
        if (!showDraftTargetSelectors || !selectedDraftProject || !selectedDraftDirectory) {
            return;
        }
        if (newSessionDraft?.pendingWorktreeRequestId || newSessionDraft?.bootstrapPendingDirectory || newSessionDraft?.preserveDirectoryOverride) {
            return;
        }
        const valid = draftBranchItems.some((option) => option.value === selectedDraftDirectory);
        if (valid) {
            return;
        }
        setNewSessionDraftTarget({
            projectId: selectedDraftProject.id,
            directoryOverride: selectedDraftProject.path,
        });
    }, [draftBranchItems, newSessionDraft?.bootstrapPendingDirectory, newSessionDraft?.pendingWorktreeRequestId, newSessionDraft?.preserveDirectoryOverride, selectedDraftDirectory, selectedDraftProject, setNewSessionDraftTarget, showDraftTargetSelectors]);

    // ── Mobile pill composer state machine ─────────────────────────────────
    const expandMobileComposer = React.useCallback((intent: 'focus') => {
        mobileExpandIntentRef.current = intent;
        // flushSync so the textarea exists NOW and focus() still runs inside
        // the user gesture's call stack: mobile browsers only open the soft
        // keyboard for focus calls made synchronously from the tap (an rAF
        // here worked in the Capacitor WebView but not in Safari/Chrome).
        flushSync(() => {
            setMobileComposerExpanded(true);
        });
        // Capacitor: our keyboard choreography positions everything, so the
        // browser's own scroll-into-view must stay off. Mobile BROWSERS have no
        // choreography — the native reveal (viewport pan that lifts the focused
        // field above the keyboard) is the only thing that moves the composer.
        textareaRef.current?.focus({ preventScroll: isCapacitorApp() });
    }, []);

    const applyAssistSuggestion = React.useCallback((text: string) => {
        setMessage(text);
        if (isMobile && !mobileComposerExpanded) {
            expandMobileComposer('focus');
        } else {
            requestAnimationFrame(() => textareaRef.current?.focus());
        }
    }, [expandMobileComposer, isMobile, mobileComposerExpanded]);


    const handleMobileNewSession = React.useCallback(() => {
        if (newSessionDraftOpen) return;
        openNewSessionDraft(currentDirectory ? { directoryOverride: currentDirectory } : undefined);
    }, [newSessionDraftOpen, openNewSessionDraft, currentDirectory]);

    const openMobileAttachSheet = React.useCallback(() => {
        // Same order as handleOpenMobilePanel: mark the sheet open BEFORE the
        // blur so the collapse watcher sees an overlay when the keyboard-close
        // lands. The trigger button blocks the tap's own focus transfer, so
        // the keyboard must be dismissed explicitly here.
        setMobileAttachMenuOpen(true);
        textareaRef.current?.blur();
    }, []);

    const mobileComposerExpandedRef = React.useRef(mobileComposerExpanded);
    React.useEffect(() => {
        mobileComposerExpandedRef.current = mobileComposerExpanded;
    });

    const handleMobileDictationActiveChange = React.useCallback((active: boolean) => {
        setMobileDictationActive(active);
        if (active) {
            mobileExpandIntentRef.current = null;
            // Dictation engine went live (possibly started from the pill):
            // switch straight into the voice variant of the full composer.
            if (!mobileComposerExpandedRef.current) {
                setMobileComposerExpanded(true);
            }
            return;
        }
        // Dictation ended. The insert flow hands focus back to the textarea a
        // tick later — if that happened, stay expanded; otherwise (cancel,
        // discard, insert-and-send) collapse straight back to the pill without
        // parking on the normal composer for the usual grace period.
        window.setTimeout(() => {
            if (!mobileComposerExpandedRef.current) return;
            if (document.activeElement === textareaRef.current) return;
            setMobileComposerExpanded(false);
            setExpandedInput(false);
        }, 30);
    }, [setExpandedInput]);

    // Watch the shared overlay portal root: any mounted MobileOverlayPanel
    // (sessions sheet, model/agent panels, draft pickers, ...) counts as busy.
    // Observing the host catches overlays whose open-state lives in other
    // components without threading their state here.
    React.useEffect(() => {
        if (!isMobile || typeof document === 'undefined') return;
        let host = document.getElementById('mobile-overlay-root');
        if (!host) {
            // Same lazy-create contract as MobileOverlayPanel's ensureOverlayRoot.
            host = document.createElement('div');
            host.id = 'mobile-overlay-root';
            document.body.appendChild(host);
        }
        const hostEl = host;
        const update = () => setMobileOverlayHostBusy(hostEl.childElementCount > 0);
        update();
        const observer = new MutationObserver(update);
        observer.observe(hostEl, { childList: true });
        return () => observer.disconnect();
    }, [isMobile]);

    // If the keyboard was open (or closed just moments ago by the overlay's own
    // blur) when an overlay appeared, bring it back once every overlay is gone.
    // The attach dropdown and the GitHub issue/PR pickers join the same chain,
    // so menu → picker → close restores the keyboard at the end of the flow.
    const mobileOverlayOpen = mobileOverlayHostBusy
        || Boolean(mobileControlsPanel)
        || mobileAttachMenuOpen
        || issuePickerOpen
        || prPickerOpen;
    // Installed PWA (standalone): a focus() from a bare timeout is outside the
    // user gesture and iOS refuses to raise the keyboard for it (Safari
    // in-browser is lenient). MobileOverlayPanel dispatches
    // 'oc:mobile-overlay-closed' synchronously from the same React flush as
    // the click that closed it — refocus right there, while the gesture is
    // still live. Chained flows (attach menu → GitHub picker) set the skip ref
    // so the keyboard doesn't flash open under the next overlay.
    const mobilePickerDialogsOpenRef = React.useRef(false);
    mobilePickerDialogsOpenRef.current = issuePickerOpen || prPickerOpen;
    const skipNextOverlayCloseRestoreRef = React.useRef(false);
    const openSheetCountRef = React.useRef(0);
    const holdComposerFocusUntilRef = React.useRef(0);
    React.useEffect(() => {
        if (!isMobile || isCapacitorApp() || typeof window === 'undefined') return;
        if (!window.matchMedia?.('(display-mode: standalone)')?.matches) return;
        const handleOverlayOpened = () => {
            openSheetCountRef.current += 1;
        };
        const handleOverlayClosed = () => {
            // Counter instead of a DOM check: the close event fires from a
            // layout-effect cleanup, when the closing sheet's portal nodes may
            // still be attached — the DOM can't tell "this sheet going away"
            // from "another sheet still up".
            openSheetCountRef.current = Math.max(0, openSheetCountRef.current - 1);
            if (skipNextOverlayCloseRestoreRef.current) {
                skipNextOverlayCloseRestoreRef.current = false;
                return;
            }
            if (!restoreKeyboardAfterOverlayRef.current) return;
            if (mobilePickerDialogsOpenRef.current) return;
            if (openSheetCountRef.current > 0) return;
            restoreKeyboardAfterOverlayRef.current = false;
            // iOS can still dismiss the freshly-raised keyboard when the tap
            // that closed the overlay finishes over non-input content — hold
            // focus through that window (see the onBlur guard).
            holdComposerFocusUntilRef.current = Date.now() + 600;
            textareaRef.current?.focus();
            // The native focus lands mid-commit; React's delegated onFocus may
            // not make it into this flush, leaving mobileComposerBusy false for
            // a beat — enough for the pill-collapse timer to unmount the
            // focused textarea and kill the rising keyboard. Set the state
            // explicitly instead of relying on the synthetic event.
            if (document.activeElement === textareaRef.current) {
                setMobileTextareaFocused(true);
            }
            // iOS reveals a field above the keyboard only for user-initiated
            // focus; a programmatic one leaves the composer parked behind it
            // (the chat screen has no viewport pin of its own — the draft
            // screen's pinned form ignores these no-op scrolls). Reveal once
            // the keyboard has mostly risen, and again after it settles.
            const reveal = () => {
                const ta = textareaRef.current;
                if (!ta || document.activeElement !== ta) return;
                // Align the BOTTOM of the whole composer form with the visible
                // bottom: 'nearest' on the textarea alone leaves the footer
                // icon row parked behind the keyboard accessory bar.
                (composerFormRef.current ?? ta).scrollIntoView({ block: 'end' });
            };
            window.setTimeout(reveal, 300);
            window.setTimeout(reveal, 650);
        };
        window.addEventListener('oc:mobile-overlay-opened', handleOverlayOpened);
        window.addEventListener('oc:mobile-overlay-closed', handleOverlayClosed);
        return () => {
            window.removeEventListener('oc:mobile-overlay-opened', handleOverlayOpened);
            window.removeEventListener('oc:mobile-overlay-closed', handleOverlayClosed);
        };
    }, [isMobile]);
    React.useEffect(() => {
        if (!isMobile) return;
        if (mobileOverlayOpen) {
            if (mobileTextareaFocused || Date.now() - lastMobileBlurAtRef.current < 800) {
                restoreKeyboardAfterOverlayRef.current = true;
            }
            return;
        }
        if (!restoreKeyboardAfterOverlayRef.current) return;
        // Debounced: overlay chains hand off with a frame of "nothing open"
        // between steps (attach sheet closes → issue/PR picker opens a frame
        // later). Restoring instantly in that gap would pop the keyboard open
        // inside the next overlay — wait out the gap and cancel if another
        // overlay appears.
        const timer = window.setTimeout(() => {
            restoreKeyboardAfterOverlayRef.current = false;
            // Browsers need their native scroll-into-view (see expandMobileComposer).
            textareaRef.current?.focus({ preventScroll: isCapacitorApp() });
        }, 180);
        return () => window.clearTimeout(timer);
    }, [isMobile, mobileOverlayOpen, mobileTextareaFocused]);

    // Fold the full composer back into the pill once nothing keeps it open:
    // keyboard closed (textarea blurred), no dictation, no sheet/menu/dialog.
    // The short delay bridges focus moving between composer controls.
    const mobileComposerBusy = mobileTextareaFocused
        || mobileOverlayHostBusy
        || mobileDictationActive
        || Boolean(mobileControlsPanel)
        || mobileAttachMenuOpen
        || mobileDraftPicker !== null
        || issuePickerOpen
        || prPickerOpen
        || isDragging;
    React.useEffect(() => {
        if (!isMobile || !mobileComposerExpanded || mobileComposerBusy) return;
        const timer = window.setTimeout(() => {
            // Authoritative DOM check: the React focus state can lag a
            // programmatic refocus (overlay-close keyboard restore). Collapsing
            // would unmount the focused textarea and kill the keyboard.
            if (document.activeElement === textareaRef.current) return;
            mobileExpandIntentRef.current = null;
            setMobileComposerExpanded(false);
            setExpandedInput(false);
        }, 250);
        return () => window.clearTimeout(timer);
    }, [isMobile, mobileComposerExpanded, mobileComposerBusy, setExpandedInput]);

    const mobileComposerBusyRef = React.useRef(false);
    mobileComposerBusyRef.current = mobileComposerBusy;

    // Browser counterpart of Capacitor's oc-keyboard-open root class (which is
    // driven by native keyboard events): the focused composer textarea is the
    // best keyboard proxy a browser has. CSS keyed on it hides the draft
    // starters while typing, mirroring the native app.
    React.useEffect(() => {
        if (!isMobile || isCapacitorApp() || typeof document === 'undefined') return;
        const root = document.documentElement;
        if (mobileTextareaFocused) {
            root.classList.add('oc-browser-keyboard-open');
        } else {
            root.classList.remove('oc-browser-keyboard-open');
            // Installed PWA (standalone): after the keyboard dismisses, WebKit
            // can leave the layout viewport stuck smaller / panned (content
            // shifted up with a dead strip at the bottom) until something
            // forces it to recompute. A zero scroll after the keyboard's exit
            // animation settles snaps it back; harmless when nothing is stuck.
            if (window.matchMedia?.('(display-mode: standalone)')?.matches) {
                window.setTimeout(() => {
                    if (root.classList.contains('oc-browser-keyboard-open')) return;
                    window.scrollTo(0, 0);
                    document.body.scrollTop = 0;
                    root.scrollTop = 0;
                }, 350);
            }
        }
        return () => root.classList.remove('oc-browser-keyboard-open');
    }, [isMobile, mobileTextareaFocused]);

    // Capacitor: collapse in the SAME frame the keyboard starts hiding. The
    // hide choreography dispatches oc:keyboard-intent BEFORE restoring the
    // shell layout and measuring the chat compensation; flushSync commits the
    // pill swap first, so keyboard land + composer shrink are measured (and
    // compensated) as ONE motion instead of a two-step staircase. The delayed
    // effect above stays as the fallback for non-Capacitor and for overlays
    // closing without a keyboard transition.
    React.useEffect(() => {
        if (!isMobile || typeof window === 'undefined') return;
        const handleIntent = (event: Event) => {
            const detail = (event as CustomEvent<{ open?: boolean }>).detail;
            if (!detail || detail.open !== false) return;
            if (!mobileComposerExpandedRef.current) return;
            // Something still holds the composer open (dictation, an overlay
            // that closed the keyboard, drag) — the fallback path handles it.
            if (mobileComposerBusyRef.current) return;
            mobileExpandIntentRef.current = null;
            flushSync(() => {
                setMobileComposerExpanded(false);
                setExpandedInput(false);
            });
        };
        window.addEventListener('oc:keyboard-intent', handleIntent);
        return () => window.removeEventListener('oc:keyboard-intent', handleIntent);
    }, [isMobile, setExpandedInput]);

    // Reset the picker search whenever a draft picker sheet opens/closes.
    React.useEffect(() => {
        setMobileDraftPickerQuery('');
    }, [mobileDraftPicker]);


    // ── Composer drag handle (mobile): swipe up = fullscreen, swipe down =
    // leave fullscreen or dismiss the keyboard. ────────────────────────────
    const handleComposerHandleTouchStart = React.useCallback((event: React.TouchEvent) => {
        const touch = event.touches.item(0);
        composerHandleTouchRef.current = touch ? { startY: touch.clientY, fired: false } : null;
    }, []);
    const handleComposerHandleTouchMove = React.useCallback((event: React.TouchEvent) => {
        const state = composerHandleTouchRef.current;
        if (!state || state.fired) return;
        const touch = event.touches.item(0);
        if (!touch) return;
        const dy = touch.clientY - state.startY;
        if (dy <= -28) {
            state.fired = true;
            if (!isExpandedInput) setExpandedInput(true);
        } else if (dy >= 28) {
            state.fired = true;
            if (isExpandedInput) {
                setExpandedInput(false);
            } else {
                textareaRef.current?.blur();
            }
        }
    }, [isExpandedInput, setExpandedInput]);
    const handleComposerHandleTouchEnd = React.useCallback(() => {
        composerHandleTouchRef.current = null;
    }, []);

    // Fullscreen composer in a mobile BROWSER: the page layout doesn't shrink
    // for the keyboard there — Safari pans/scrolls instead, so any flow-based
    // sizing ends up partly off-screen or under the keyboard (the chat page is
    // usually already panned when fullscreen is entered). Pin the form to the
    // VISUAL viewport directly: fixed at its offset with its height, updated
    // as the browser pans. Capacitor is excluded — its shell already resizes
    // via the keyboard choreography.
    const composerFormRef = React.useRef<HTMLFormElement | null>(null);
    React.useLayoutEffect(() => {
        if (!isMobile || !isMobileExpanded || isCapacitorApp()) return;
        const vv = window.visualViewport;
        const form = composerFormRef.current;
        const textarea = textareaRef.current;
        if (!vv || !form) return;
        // The form is trapped inside lower stacking contexts (the composer
        // wrapper's z-10), so it cannot out-stack the app header with z-index
        // alone — hide the header for the duration via a root class instead.
        document.documentElement.classList.add('oc-browser-kb-fullscreen');
        const apply = () => {
            const top = Math.max(0, Math.floor(vv.offsetTop));
            // Same stale-visualViewport guard as the draft pin below: when the
            // layout viewport is keyboard-resized (interactive-widget), its
            // clientHeight is the authoritative above-keyboard height.
            const layoutHeight = document.documentElement.clientHeight;
            form.style.position = 'fixed';
            form.style.left = '0';
            form.style.right = '0';
            form.style.top = `${top}px`;
            form.style.height = `${Math.floor(Math.min(vv.height, layoutHeight - top))}px`;
            form.style.zIndex = '40';
            form.style.background = 'var(--background)';
        };
        apply();
        vv.addEventListener('resize', apply);
        vv.addEventListener('scroll', apply);
        window.addEventListener('resize', apply);
        window.addEventListener('scroll', apply, true);
        return () => {
            vv.removeEventListener('resize', apply);
            vv.removeEventListener('scroll', apply);
            window.removeEventListener('resize', apply);
            window.removeEventListener('scroll', apply, true);
            document.documentElement.classList.remove('oc-browser-kb-fullscreen');
            form.style.position = '';
            form.style.left = '';
            form.style.right = '';
            form.style.top = '';
            form.style.height = '';
            form.style.zIndex = '';
            form.style.background = '';
            // Back in flow: the browser panned/scrolled for the fullscreen
            // session and won't re-reveal the (still focused) field on its own,
            // which left the composer parked behind the keyboard.
            requestAnimationFrame(() => {
                if (textarea && document.activeElement === textarea) {
                    textarea.scrollIntoView({ block: 'nearest' });
                }
            });
        };
    }, [isMobile, isMobileExpanded]);

    // Draft screen in a mobile BROWSER with the keyboard open: Safari's own
    // focused-field reveal is unreliable there (leaving the composer behind
    // the keyboard, e.g. after collapsing from fullscreen), so the NORMAL
    // composer is pinned to the visual viewport too — anchored to its visible
    // bottom at its natural height. The chat screen doesn't need this (its
    // reveal works) and Capacitor has the keyboard choreography.
    React.useLayoutEffect(() => {
        if (!isMobile || isCapacitorApp()) return;
        if (!newSessionDraftOpen || isMobileExpanded || !mobileTextareaFocused) return;
        const vv = window.visualViewport;
        const form = composerFormRef.current;
        if (!vv || !form) return;
        // Keep the in-flow horizontal geometry (page paddings) while fixed.
        const rect = form.getBoundingClientRect();
        form.style.position = 'fixed';
        form.style.left = `${Math.floor(rect.left)}px`;
        form.style.width = `${Math.floor(rect.width)}px`;
        form.style.zIndex = '40';
        form.style.background = 'var(--background)';
        // Safari's visualViewport events are unreliable mid keyboard pan (they
        // can simply not fire), so track the pan with a rAF loop instead —
        // cheap math per frame, a style write only when the value changes.
        let lastTop = Number.NaN;
        let frame = 0;
        const track = () => {
            // iOS standalone (PWA) can serve stale visualViewport metrics after
            // the keyboard rises (full pre-keyboard height, intermittently),
            // parking the form behind the keyboard. When interactive-widget
            // resizes the layout viewport, documentElement.clientHeight is the
            // true above-keyboard bottom — anchor to whichever is smaller. In
            // pan-mode browsers clientHeight stays full height, so the min
            // keeps the visual-viewport anchor there.
            const layoutBottom = document.documentElement.clientHeight;
            const vvBottom = vv.offsetTop + vv.height;
            const top = Math.max(0, Math.floor(Math.min(vvBottom, layoutBottom) - form.offsetHeight));
            if (top !== lastTop) {
                lastTop = top;
                form.style.top = `${top}px`;
            }
            frame = requestAnimationFrame(track);
        };
        track();
        return () => {
            cancelAnimationFrame(frame);
            form.style.position = '';
            form.style.left = '';
            form.style.width = '';
            form.style.top = '';
            form.style.zIndex = '';
            form.style.background = '';
        };
    }, [isMobile, isMobileExpanded, newSessionDraftOpen, mobileTextareaFocused]);

    // Shared drag handle: rendered at the top of the full composer AND inside
    // the dictation overlay, so swipe-expand/collapse works in Listening mode.
    // Memoized so the always-mounted dictation instance's memo stays effective.
    const mobileComposerHandle = React.useMemo(() => isMobile ? (
        <div
            // Generous hit area (~28px tall, full width); the visible bar stays
            // slim inside it.
            className="relative z-10 flex touch-none items-center justify-center py-2"
            onTouchStart={handleComposerHandleTouchStart}
            onTouchMove={handleComposerHandleTouchMove}
            onTouchEnd={handleComposerHandleTouchEnd}
            onTouchCancel={handleComposerHandleTouchEnd}
            aria-hidden="true"
        >
            <div
                className="h-1.5 w-12 rounded-full"
                style={{ backgroundColor: currentTheme.colors.interactive.border }}
            />
        </div>
    ) : null, [
        isMobile,
        handleComposerHandleTouchStart,
        handleComposerHandleTouchMove,
        handleComposerHandleTouchEnd,
        currentTheme.colors.interactive.border,
    ]);

    const footerPaddingClass = isMobile ? 'px-1.5 py-1.5' : (isVSCode ? 'px-1.5 py-1' : 'px-2.5 py-1.5');
    const buttonSizeClass = isMobile ? 'h-8 w-8' : (isVSCode ? 'h-5 w-5' : 'h-6 w-6');
    const sendIconSizeClass = isMobile ? 'h-4 w-4' : (isVSCode ? 'h-3.5 w-3.5' : 'h-4 w-4');
    const stopIconSizeClass = isMobile ? 'h-6 w-6' : (isVSCode ? 'h-4 w-4' : 'h-5 w-5');
    const iconSizeClass = isMobile ? 'h-[18px] w-[18px]' : (isVSCode ? 'h-4 w-4' : 'h-[18px] w-[18px]');

    const iconButtonBaseClass = 'flex cursor-pointer items-center justify-center text-foreground transition-none outline-none focus:outline-none flex-shrink-0 disabled:cursor-not-allowed';
    const footerIconButtonClass = cn(iconButtonBaseClass, buttonSizeClass);
    const permissionScopeSessionId = currentSessionId ?? currentManagementSessionId;
    const permissionAutoAcceptEnabled = usePermissionStore((state) => {
        if (!permissionScopeSessionId) {
            return false;
        }
        return state.isSessionAutoAccepting(permissionScopeSessionId);
    });

    const handlePermissionAutoAcceptToggle = React.useCallback(() => {
        if (!permissionScopeSessionId) {
            toast.error(t('chat.chatInput.toast.openSessionFirst'));
            return;
        }

        const nextEnabled = !permissionAutoAcceptEnabled;
        setSessionAutoAccept(permissionScopeSessionId, nextEnabled).catch(() => {
            toast.error(t('chat.chatInput.toast.togglePermissionAutoAcceptFailed'));
        });
    }, [permissionAutoAcceptEnabled, permissionScopeSessionId, setSessionAutoAccept, t]);

    React.useEffect(() => {
        const pendingAbortBanner = Boolean(abortPromptSessionId) && abortPromptSessionId === currentSessionId;
        if (!prevWasAbortedRef.current && pendingAbortBanner && !showAbortStatus) {
            startAbortIndicator();
            if (currentSessionId) {
                acknowledgeSessionAbort(currentSessionId);
            }
        }
        prevWasAbortedRef.current = pendingAbortBanner;
    }, [
        abortPromptSessionId,
        acknowledgeSessionAbort,
        currentSessionId,
        showAbortStatus,
        startAbortIndicator,
    ]);

    React.useEffect(() => {
        return () => {
            if (abortTimeoutRef.current) {
                clearTimeout(abortTimeoutRef.current);
                abortTimeoutRef.current = null;
            }
        };
    }, []);

    return (
        <>
        <form
            ref={composerFormRef}
            onSubmit={(e) => { e.preventDefault(); handlePrimaryAction(); }}
            className={cn(
                "relative w-full pt-0 pb-4",
                isDesktopExpanded && 'flex h-full min-h-0 flex-col pt-4',
                isMobileExpanded && 'flex h-full min-h-0 flex-col pt-2',
                isMobile && 'bottom-safe-area oc-mobile-composer'
            )}
            style={isMobile && inputBarOffset > 0 ? { marginBottom: `${inputBarOffset}px` } : undefined}
        >
            {newSessionDraftOpen && !isDesktopExpanded && !isMobile && !isVSCode && !isMiniChatSurface ? (
                <div className="chat-input-column mb-7 text-center">
                    <h1 className="text-balance text-2xl font-normal tracking-tight text-foreground md:text-3xl">
                        {renderDraftTitle(
                            draftProjectLabel
                                ? t('chat.emptyState.draftTitleWithProject', { project: draftProjectLabel })
                                : t('chat.emptyState.draftTitle'),
                            draftProjectLabel,
                        )}
                    </h1>
                </div>
            ) : null}
            <div className={cn('chat-input-column relative overflow-visible', isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}>
                <AttachedFilesList onShowPopup={handleShowAttachmentPreview} />
                <QueuedMessageChips
                    onEditMessage={handleQueuedMessageEdit}
                    onSendMessage={handleQueuedMessageSend}
                />
                <AutoReviewBanner />
                {hasDrafts && (
                    <div className="flex flex-wrap items-center gap-2 pb-2">
                        {reviewCount > 0 ? (
                            <div
                                className="inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1"
                                style={{
                                    backgroundColor: currentTheme?.colors?.surface?.elevated,
                                    borderColor: currentTheme?.colors?.interactive?.border,
                                }}
                            >
                                <span className="text-xs font-medium text-muted-foreground">{t('chat.chatInput.reviewComments')}</span>
                                <span className="text-xs font-semibold" style={{ color: currentTheme?.colors?.status?.info }}>{reviewCount}</span>
                                <button
                                    type="button"
                                    className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                                    style={{ minHeight: 0, minWidth: 0 }}
                                    onClick={removeReviewDrafts}
                                    aria-label={t('chat.chatInput.reviewCommentsRemove')}
                                    title={t('chat.chatInput.reviewCommentsRemove')}
                                >
                                    <Icon name="close" className="h-3 w-3" />
                                </button>
                            </div>
                        ) : null}
                        {previewConsoleCount > 0 ? (
                            <div
                                className="inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1"
                                style={{
                                    backgroundColor: currentTheme?.colors?.surface?.elevated,
                                    borderColor: currentTheme?.colors?.interactive?.border,
                                }}
                            >
                                <span className="text-xs font-medium text-muted-foreground">{t('chat.chatInput.devServerLogs')}</span>
                                <span className="text-xs font-semibold" style={{ color: currentTheme?.colors?.status?.info }}>{previewConsoleCount}</span>
                                <button
                                    type="button"
                                    className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                                    style={{ minHeight: 0, minWidth: 0 }}
                                    onClick={() => removePreviewDrafts('preview-console')}
                                    aria-label={t('chat.chatInput.devServerLogsRemove')}
                                    title={t('chat.chatInput.devServerLogsRemove')}
                                >
                                    <Icon name="close" className="h-3 w-3" />
                                </button>
                            </div>
                        ) : null}
                        {previewAnnotationCount > 0 ? (
                            <div
                                className="inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1"
                                style={{
                                    backgroundColor: currentTheme?.colors?.surface?.elevated,
                                    borderColor: currentTheme?.colors?.interactive?.border,
                                }}
                            >
                                <span className="text-xs font-medium text-muted-foreground">{t('chat.chatInput.previewAnnotations')}</span>
                                <span className="text-xs font-semibold" style={{ color: currentTheme?.colors?.status?.info }}>{previewAnnotationCount}</span>
                                <button
                                    type="button"
                                    className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                                    style={{ minHeight: 0, minWidth: 0 }}
                                    onClick={() => removePreviewDrafts('preview-annotation')}
                                    aria-label={t('chat.chatInput.previewContextRemove')}
                                    title={t('chat.chatInput.previewContextRemove')}
                                >
                                    <Icon name="close" className="h-3 w-3" />
                                </button>
                            </div>
                        ) : null}
                    </div>
                )}

                {/* Linked Issue row */}
                {linkedIssue && !isVSCode && (
                    <div className="pb-2 w-full px-1">
                        <div className="flex w-full items-center gap-1.5 text-sm h-5 px-1">
                            <button
                                type="button"
                                onClick={() => setIssuePickerOpen(true)}
                                className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:opacity-80 transition-opacity"
                            >
                                {linkedIssue.author?.avatarUrl && (
                                    <img
                                        src={linkedIssue.author.avatarUrl}
                                        alt={linkedIssue.author.login}
                                        className="h-5 w-5 rounded-full flex-shrink-0"
                                    />
                                )}
                                <span className="text-muted-foreground flex-shrink-0">
                                    #{linkedIssue.number}
                                    {linkedIssue.author && (
                                        <span className="ml-1">{t('chat.chatInput.linked.byAuthor', { author: linkedIssue.author.login })}</span>
                                    )}
                                </span>
                                <span className="text-foreground truncate">
                                    {linkedIssue.title}
                                </span>
                            </button>
                            <span className="flex items-center gap-0.5 flex-shrink-0">
                                <a
                                    href={linkedIssue.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center justify-center h-6 w-6 hover:bg-[var(--interactive-hover)] rounded-full transition-colors"
                                    aria-label={t('chat.chatInput.linked.issue.openInBrowserAria')}
                                >
                                    <Icon name="external-link" className="h-4 w-4 text-muted-foreground" />
                                </a>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setLinkedIssue(null);
                                    }}
                                    className="flex items-center justify-center h-6 w-6 hover:bg-[var(--interactive-hover)] rounded-full transition-colors"
                                    aria-label={t('chat.chatInput.linked.issue.removeAria')}
                                    title={t('chat.chatInput.linked.issue.removeAria')}
                                >
                                    <Icon name="close" className="h-4 w-4 text-muted-foreground" />
                                </button>
                            </span>
                        </div>
                    </div>
                )}
                {linkedPr && !isVSCode && (
                    <div className="pb-2 w-full px-1">
                        <div className="flex w-full items-center gap-1.5 text-sm h-5 px-1">
                            <button
                                type="button"
                                onClick={() => setPrPickerOpen(true)}
                                className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:opacity-80 transition-opacity"
                            >
                                {linkedPr.author?.avatarUrl && (
                                    <img
                                        src={linkedPr.author.avatarUrl}
                                        alt={linkedPr.author.login}
                                        className="h-5 w-5 rounded-full flex-shrink-0"
                                    />
                                )}
                                <span className="text-muted-foreground flex-shrink-0">
                                    {t('chat.chatInput.linked.pr.number', { number: linkedPr.number })}
                                    {linkedPr.author && (
                                        <span className="ml-1">{t('chat.chatInput.linked.byAuthor', { author: linkedPr.author.login })}</span>
                                    )}
                                </span>
                                <span className="text-foreground truncate">
                                    {linkedPr.title}
                                </span>
                                <span className="text-muted-foreground flex-shrink-0 typography-meta">
                                    {linkedPr.head} → {linkedPr.base}
                                </span>
                            </button>
                            <span className="flex items-center gap-0.5 flex-shrink-0">
                                <a
                                    href={linkedPr.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center justify-center h-6 w-6 hover:bg-[var(--interactive-hover)] rounded-full transition-colors"
                                    aria-label={t('chat.chatInput.linked.pr.openInBrowserAria')}
                                >
                                    <Icon name="external-link" className="h-4 w-4 text-muted-foreground" />
                                </a>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setLinkedPr(null);
                                    }}
                                    className="flex items-center justify-center h-6 w-6 hover:bg-[var(--interactive-hover)] rounded-full transition-colors"
                                    aria-label={t('chat.chatInput.linked.pr.removeAria')}
                                    title={t('chat.chatInput.linked.pr.removeAria')}
                                >
                                    <Icon name="close" className="h-4 w-4 text-muted-foreground" />
                                </button>
                            </span>
                        </div>
                    </div>
                )}
                <RevertedMessageDock
                    sessionId={currentSessionId}
                    directory={currentSessionDirectoryForSync ?? currentDirectory}
                />
                <MemoStatusRow
                    showAbortStatus={showAbortStatus}
                    showAssistantStatus={false}
                    showTodos
                    leftAccessory={newSessionDraftOpen || !hasPendingChanges ? null : <PendingChangesBar />}
                />
                {!isMobile && showDraftTargetSelectors && selectedDraftProject ? (
                    <div className="mb-1.5 flex min-w-0 items-center gap-1.5 px-0.5">
                        <Select
                            value={selectedDraftProject.id}
                            onValueChange={handleDraftProjectChange}
                        >
                            <SelectTrigger
                                size="sm"
                                className="h-7 min-w-0 w-fit max-w-[42vw] sm:max-w-[18rem] border-transparent bg-transparent px-1.5 hover:bg-transparent data-[popup-open]:bg-transparent"
                            >
                                <SelectValue>
                                    {renderProjectLabelWithIcon(selectedDraftProject)}
                                </SelectValue>
                            </SelectTrigger>
                            <SelectContent fitContent>
                                {projects.map((project) => (
                                    <SelectItem key={project.id} value={project.id} className="max-w-[24rem] truncate">
                                        {renderProjectLabelWithIcon(project)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>

                        {shouldShowDraftBranchSelector ? (
                            <Select
                                value={selectedDraftDirectory ?? draftBranchItems[0]?.value ?? normalizePath(selectedDraftProject.path) ?? ''}
                                onValueChange={handleDraftDirectoryChange}
                            >
                                <SelectTrigger
                                    size="sm"
                                    className="h-7 min-w-0 w-fit max-w-[48vw] sm:max-w-[20rem] border-transparent bg-transparent px-1.5 hover:bg-transparent data-[popup-open]:bg-transparent"
                                >
                                    <SelectValue>
                                        {selectedDraftBranchLabel ?? t('chat.chatInput.branch')}
                                    </SelectValue>
                                </SelectTrigger>
                                <SelectContent className="w-max min-w-48">
                                    {projectRootBranchOption ? (
                                        <SelectGroup>
                                            <SelectLabel>{t('chat.chatInput.projectRoot')}</SelectLabel>
                                            <SelectItem key={projectRootBranchOption.value} value={projectRootBranchOption.value} className="max-w-[24rem] truncate">
                                                {projectRootBranchOption.label}
                                            </SelectItem>
                                        </SelectGroup>
                                    ) : null}
                                    {projectRootBranchOption ? <SelectSeparator /> : null}
                                    <SelectGroup>
                                        <div className="flex items-center justify-between px-2 py-1.5">
                                            <span className="text-muted-foreground typography-meta">{t('chat.chatInput.worktrees')}</span>
                                            <button
                                                type="button"
                                                className="text-muted-foreground typography-meta hover:text-foreground cursor-pointer"
                                                onPointerDown={(e) => { e.stopPropagation(); }}
                                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); void createWorktreeDraft(); }}
                                            >
                                                {t('chat.chatInput.worktreeNew')}
                                            </button>
                                        </div>
                                        {worktreeBranchOptions.map((option) => (
                                            <SelectItem key={option.value} value={option.value} className="max-w-[24rem] truncate">
                                                {option.pending ? '⏳ ' : ''}{option.label}
                                            </SelectItem>
                                        ))}
                                    </SelectGroup>
                                    {selectedDraftDirectory && !selectedDraftBranchIsKnown ? (
                                        <SelectItem value={selectedDraftDirectory} className="max-w-[24rem] truncate">
                                            {selectedDraftBranchLabel}
                                        </SelectItem>
                                    ) : null}
                                </SelectContent>
                            </Select>
                        ) : null}
                    </div>
                ) : null}
                {isMobile && showDraftTargetSelectors && selectedDraftProject ? (
                    <div className="mb-1.5 flex min-w-0 items-center gap-x-2 px-0.5">
                        <button
                            type="button"
                            className="inline-flex h-7 min-w-0 max-w-[42vw] flex-shrink cursor-pointer items-center gap-1 rounded-lg px-1.5 typography-micro font-medium text-foreground/80 hover:bg-[var(--interactive-hover)]"
                            onClick={() => setMobileDraftPicker('project')}
                        >
                            {renderProjectLabelWithIcon(selectedDraftProject)}
                            <Icon name="arrow-down-s" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                        </button>
                        {shouldShowDraftBranchSelector ? (
                            <button
                                type="button"
                                className="inline-flex h-7 min-w-0 max-w-[48vw] flex-shrink cursor-pointer items-center gap-1 rounded-lg px-1.5 typography-micro font-medium text-foreground/80 hover:bg-[var(--interactive-hover)]"
                                onClick={() => setMobileDraftPicker('branch')}
                            >
                                <span className="truncate">{selectedDraftBranchLabel ?? t('chat.chatInput.branch')}</span>
                                <Icon name="arrow-down-s" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                            </button>
                        ) : null}
                    </div>
                ) : null}
                <div
                    // Desktop: layout-transparent. Mobile: positioning host for
                    // the wrapper-level dictation overlay across pill/full states.
                    className={cn(
                        !isMobile && 'contents',
                        isMobile && 'relative',
                        isMobileExpanded && 'flex min-h-0 flex-1 flex-col',
                    )}
                >
                {isMobile && !mobileComposerExpanded ? (
                    <div className="flex flex-col">
                    <SessionSuggestionChip
                        sessionId={currentSessionId}
                        directory={currentSessionDirectoryForSync ?? currentDirectory}
                        hidden={hasContent || newSessionDraftOpen}
                        onApply={applyAssistSuggestion}
                        className="mb-1.5"
                    />
                    <div className="flex items-center gap-2">
                        <div
                            className="flex h-11 min-w-0 flex-1 items-center gap-x-0.5 rounded-full border border-border/80 pl-2 pr-1"
                            style={{ backgroundColor: currentTheme?.colors?.surface?.subtle }}
                        >
                            <MobileSessionPanelTrigger
                                footerIconButtonClass={footerIconButtonClass}
                                iconSizeClass={iconSizeClass}
                            />
                            <ComposerAttachmentControls
                                isVSCode={isVSCode}
                                footerIconButtonClass={footerIconButtonClass}
                                iconSizeClass={iconSizeClass}
                                handlePickLocalFiles={handlePickLocalFiles}
                                openIssuePicker={openIssuePicker}
                                openPrPicker={openPrPicker}
                                onOpenMobileSheet={openMobileAttachSheet}
                            />
                            <button
                                type="button"
                                className="flex h-full min-w-0 flex-1 cursor-text items-center px-1.5 text-left"
                                onClick={() => expandMobileComposer('focus')}
                            >
                                <span
                                    className={cn(
                                        'truncate typography-ui-label',
                                        message.trim() ? 'text-foreground' : 'text-muted-foreground',
                                    )}
                                >
                                    {message.trim()
                                        ? message
                                        : currentSessionId || newSessionDraftOpen
                                            ? t('chat.chatInput.placeholder.chatCompact')
                                            : t('chat.chatInput.placeholder.selectSession')}
                                </span>
                            </button>
                            <button
                                type="button"
                                className={footerIconButtonClass}
                                onClick={() => {
                                    // Start recording in place; the composer morphs
                                    // into the voice variant once dictation is live
                                    // (handleMobileDictationActiveChange).
                                    window.dispatchEvent(new CustomEvent('openchamber:dictation-toggle'));
                                }}
                                title={t('chat.dictation.start')}
                                aria-label={t('chat.dictation.start')}
                            >
                                <Icon name="mic" className={cn(iconSizeClass, 'text-current')} />
                            </button>
                        </div>
                        {/* New-session button: fades/shrinks away when the draft is
                            already open, letting the pill expand into its place. */}
                        <div
                            className={cn(
                                'flex-shrink-0 overflow-hidden transition-all duration-200 ease-out',
                                newSessionDraftOpen ? 'w-0 opacity-0' : 'w-11 opacity-100',
                            )}
                        >
                            <button
                                type="button"
                                className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-border/80 text-foreground"
                                style={{ backgroundColor: currentTheme?.colors?.surface?.subtle }}
                                onClick={handleMobileNewSession}
                                disabled={newSessionDraftOpen}
                                title={t('mobile.sessions.newChat')}
                                aria-label={t('mobile.sessions.newChat')}
                            >
                                <Icon name="add" className="h-5 w-5 text-current" />
                            </button>
                        </div>
                    </div>
                    </div>
                ) : (
                <>
                <SessionSuggestionChip
                    sessionId={currentSessionId}
                    directory={currentSessionDirectoryForSync ?? currentDirectory}
                    hidden={hasContent || newSessionDraftOpen}
                    onApply={applyAssistSuggestion}
                    className="mb-1.5"
                />
                <div
                    className={cn(
                        "flex flex-col relative overflow-visible",
                        isComposerExpanded && 'flex-1 min-h-0',
                        "border border-border/80",
                        "focus-within:ring-1",
                        inputMode === 'shell'
                            ? 'focus-within:ring-[var(--status-info)]'
                            : 'focus-within:ring-primary/50',
                        isDragging && "ring-2 ring-primary ring-offset-2"
                    )}
                    style={{
                        borderRadius: chatInputRadius,
                        backgroundColor: currentTheme?.colors?.surface?.subtle,
                    }}
                    ref={dropZoneRef}
                    onDropCapture={handleDropCapture}
                    onDragEnter={handleDragEnter}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onDragEnd={handleDragEnd}
                >
                    {isDragging && (
                        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/90 rounded-xl">
                            <div className="text-center">
                                <div className="inline-flex justify-center">
                                    <button
                                        type="button"
                                        className={iconButtonBaseClass}
                                        onClick={() => handlePickLocalFiles()}
                                        title={t('chat.chatInput.actions.attachFiles')}
                                        aria-label={t('chat.chatInput.actions.attachFiles')}
                                    >
                                        <Icon name="attachment-2" className={cn(iconSizeClass, 'text-current')} />
                                    </button>
                                </div>
                                <p className="mt-2 typography-ui-label text-muted-foreground">
                                    {isInternalDrag ? t('chat.chatInput.drop.insertMention') : t('chat.chatInput.drop.attachFiles')}
                                </p>
                            </div>
                        </div>
                    )}

                    {showCommandAutocomplete && (
                        <CommandAutocomplete
                            ref={commandRef}
                            searchQuery={commandQuery}
                            onCommandSelect={handleCommandSelect}
                            onClose={() => setShowCommandAutocomplete(false)}
                            style={isDesktopExpanded && autocompleteOverlayPosition
                                ? {
                                    left: `${autocompleteOverlayPosition.left}px`,
                                    top: `${autocompleteOverlayPosition.top}px`,
                                    bottom: 'auto',
                                    width: `min(450px, calc(100% - ${autocompleteOverlayPosition.left + 8}px))`,
                                    maxHeight: `${autocompleteOverlayPosition.maxHeight}px`,
                                    transform: autocompleteOverlayPosition.place === 'above' ? 'translateY(-100%)' : undefined,
                                }
                                : undefined}
                        />
                    )}
                    { }
                    {showSkillAutocomplete && (
                        <SkillAutocomplete
                            ref={skillRef}
                            searchQuery={skillQuery}
                            onSkillSelect={handleSkillSelect}
                            onClose={() => setShowSkillAutocomplete(false)}
                            style={isDesktopExpanded && autocompleteOverlayPosition
                                ? {
                                    left: `${autocompleteOverlayPosition.left}px`,
                                    top: `${autocompleteOverlayPosition.top}px`,
                                    bottom: 'auto',
                                    width: `min(360px, calc(100% - ${autocompleteOverlayPosition.left + 8}px))`,
                                    maxHeight: `${autocompleteOverlayPosition.maxHeight}px`,
                                    transform: autocompleteOverlayPosition.place === 'above' ? 'translateY(-100%)' : undefined,
                                }
                                : undefined}
                        />
                    )}

                    {showSnippetAutocomplete && (
                        <SnippetAutocomplete
                            ref={snippetRef}
                            searchQuery={snippetQuery}
                            onSnippetSelect={handleSnippetSelect}
                            onClose={() => setShowSnippetAutocomplete(false)}
                            style={isDesktopExpanded && autocompleteOverlayPosition
                                ? {
                                    left: `${autocompleteOverlayPosition.left}px`,
                                    top: `${autocompleteOverlayPosition.top}px`,
                                    bottom: 'auto',
                                    width: `min(450px, calc(100% - ${autocompleteOverlayPosition.left + 8}px))`,
                                    maxHeight: `${autocompleteOverlayPosition.maxHeight}px`,
                                    transform: autocompleteOverlayPosition.place === 'above' ? 'translateY(-100%)' : undefined,
                                }
                                : undefined}
                        />
                    )}

                    {showFileMention && (

                        <FileMentionAutocomplete
                            ref={mentionRef}
                            searchQuery={mentionQuery}
                            onFileSelect={handleFileSelect}
                            onAgentSelect={handleAgentSelect}
                            onClose={() => setShowFileMention(false)}
                            style={isDesktopExpanded && autocompleteOverlayPosition
                                ? {
                                    left: `${autocompleteOverlayPosition.left}px`,
                                    top: `${autocompleteOverlayPosition.top}px`,
                                    bottom: 'auto',
                                    width: `min(520px, calc(100% - ${autocompleteOverlayPosition.left + 8}px))`,
                                    maxHeight: `${autocompleteOverlayPosition.maxHeight}px`,
                                    transform: autocompleteOverlayPosition.place === 'above' ? 'translateY(-100%)' : undefined,
                                }
                                : undefined}
                        />
                    )}
                    {/* Positioning context for the dictation overlay: covers the
                        text area + footer exactly, excluding MobileSessionStatusBar. */}
                    <div className={cn('relative flex flex-col', isComposerExpanded && 'flex-1 min-h-0')}>
                    <div className={cn("overflow-hidden", isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}>
                        {mobileComposerHandle}
                        {isMobile ? (
                            <div className="scrollbar-none relative z-10 flex items-center gap-x-2 overflow-x-auto px-3 pb-0.5 pt-1.5">
                                <MemoMobileModelButton onOpenModel={() => handleOpenMobilePanel('model')} className="flex-shrink-0" />
                                <MemoMobileAgentButton
                                    onOpenAgentPanel={handleOpenAgentPanel}
                                    onCycleAgent={handleCycleAgent}
                                    className="flex-shrink-0"
                                />
                            </div>
                        ) : null}
                        <div className="flex items-center gap-1 px-3 pt-1 flex-wrap relative z-10">
                            <AttachedVSCodeFileChips onShowPopup={handleShowAttachmentPreview} />
                            <ActiveEditorFileSuggestion />
                        </div>
                        <div className={cn("relative overflow-hidden", isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}>
                            {/* No highlight mirror on mobile: over wrapped text its
                                layout drifts from the real textarea, which visually
                                misplaces the caret. Plain textarea text keeps caret
                                and text in the same layout. */}
                            {highlightedComposerContent && !isMobile && (
                                <div
                                    aria-hidden
                                    className={cn(
                                        'pointer-events-none absolute inset-0 z-0 whitespace-pre-wrap break-words px-3 rounded-b-none',
                                        isComposerExpanded
                                            ? cn('h-full min-h-0', isMobile ? 'py-2.5' : 'py-4')
                                            : isMobile
                                                ? 'py-2.5'
                                                : 'pt-4 pb-2',
                                        inputMode === 'shell' ? 'font-mono' : 'typography-markdown md:typography-ui-label',
                                    )}
                                    ref={composerHighlightRef}
                                >
                                    {highlightedComposerContent.map((part, index) => (
                                        <span
                                            key={`${index}-${part.text.length}`}
                                            className={part.className}
                                        >
                                            {part.text}
                                        </span>
                                    ))}
                                </div>
                            )}
                            <Textarea
                                simple
                                ref={textareaRef}
                                data-chat-input="true"
                                value={message}
                                onChange={handleTextChange}
                                onBeforeInput={handleBeforeInput}
                                onKeyDown={handleKeyDown}
                                onPaste={handlePaste}
                                onDragEnter={handleDragEnter}
                                onDragOver={handleDragOver}
                                onDropCapture={handleDropCapture}
                                onDrop={handleDrop}
                                onDragEnd={handleDragEnd}
                                onKeyUp={updateAutocompleteOverlayPosition}
                                onClick={updateAutocompleteOverlayPosition}
                                onScroll={(event) => {
                                    updateAutocompleteOverlayPosition();
                                    const scrollTop = event.currentTarget.scrollTop;
                                    if (composerHighlightRef.current) {
                                        composerHighlightRef.current.style.transform = `translateY(-${scrollTop}px)`;
                                    }
                                }}
                                onSelect={(e) => {
                                    const ta = e.currentTarget;
                                    cursorPosRef.current = ta.selectionStart ?? 0;
                                    updateAutocompleteOverlayPosition();
                                }}
                                onFocus={() => {
                                    if (!isMobile) return;
                                    if (mobileBlurTimerRef.current !== null) {
                                        window.clearTimeout(mobileBlurTimerRef.current);
                                        mobileBlurTimerRef.current = null;
                                    }
                                    mobileExpandIntentRef.current = null;
                                    setMobileTextareaFocused(true);
                                }}
                                onBlur={() => {
                                    if (!isMobile) return;
                                    // Focus hold after an overlay-close restore:
                                    // iOS may retract the rising keyboard as the
                                    // closing tap settles — take the focus right
                                    // back instead of accepting the blur.
                                    if (Date.now() < holdComposerFocusUntilRef.current) {
                                        const ta = textareaRef.current;
                                        if (ta) {
                                            ta.focus();
                                            window.setTimeout(() => {
                                                if (Date.now() < holdComposerFocusUntilRef.current
                                                    && document.activeElement !== ta) {
                                                    ta.focus();
                                                }
                                            }, 50);
                                            return;
                                        }
                                    }
                                    lastMobileBlurAtRef.current = Date.now();
                                    // Mobile browsers and installed PWAs share the
                                    // blur race: the keyboard-dismiss reflow moves
                                    // composer buttons before the tap's synthesized
                                    // click lands, so the click misses its target.
                                    // Capacitor's WebView does not need the hold.
                                    if (isCapacitorApp()) {
                                        setMobileTextareaFocused(false);
                                        return;
                                    }
                                    // See mobileBlurTimerRef: hold the pinned
                                    // composer still until the tap's click has
                                    // been delivered.
                                    if (mobileBlurTimerRef.current !== null) {
                                        window.clearTimeout(mobileBlurTimerRef.current);
                                    }
                                    // 120ms is enough to outlive the tap's
                                    // synthesized click (which lands within a
                                    // few ms of the blur) while keeping the
                                    // padding's return visually tied to the
                                    // keyboard dismissal.
                                    mobileBlurTimerRef.current = window.setTimeout(() => {
                                        mobileBlurTimerRef.current = null;
                                        setMobileTextareaFocused(false);
                                    }, 120);
                                }}
                                placeholder={currentSessionId || newSessionDraftOpen
                                    ? inputMode === 'shell'
                                        ? t('chat.chatInput.placeholder.shell')
                                        : t(useCompactChatPlaceholder ? 'chat.chatInput.placeholder.chatCompact' : 'chat.chatInput.placeholder.chat')
                                    : t('chat.chatInput.placeholder.selectSession')}
                                disabled={!currentSessionId && !newSessionDraftOpen}
                                autoCorrect={isMobile ? "on" : "off"}
                                autoCapitalize={isMobile ? "sentences" : "off"}
                                spellCheck={isMobile || inputSpellcheckEnabled}
                                fillContainer={isComposerExpanded}
                                outerClassName={cn('ring-0 bg-transparent shadow-none hover:bg-transparent focus-within:ring-0', isComposerExpanded && 'flex-1 min-h-0')}
                                className={cn(
                                    'min-h-[52px] resize-none border-0 px-3 rounded-b-none appearance-none hover:border-transparent bg-transparent relative z-10',
                                    isComposerExpanded
                                        ? cn('h-full min-h-0', isMobile ? 'py-2.5' : 'py-4')
                                        : isMobile
                                            ? 'py-2.5'
                                            : 'pt-4 pb-2',
                                    inputMode === 'shell' && 'font-mono',
                                    highlightedComposerContent && !isMobile && 'text-transparent caret-[var(--surface-foreground)]',
                                )}
                                style={{
                                    flex: isComposerExpanded ? '1 1 auto' : 'none',
                                    height: !isComposerExpanded && textareaSize ? `${textareaSize.height}px` : undefined,
                                    maxHeight: !isComposerExpanded && textareaSize ? `${textareaSize.maxHeight}px` : undefined,
                                    borderTopLeftRadius: chatInputRadius,
                                    borderTopRightRadius: chatInputRadius,
                                }}
                                rows={1}
                            />
                        </div>
                    </div>
                    <div
                        className={cn(
                            'bg-transparent flex-shrink-0',
                            footerPaddingClass,
                            isMobile ? 'flex items-center gap-x-1.5' : cn('flex items-center justify-between', footerGapClass)
                        )}
                        style={{
                            borderBottomLeftRadius: chatInputRadius,
                            borderBottomRightRadius: chatInputRadius,
                        }}
                        data-chat-input-footer="true"
                    >
                        {isMobile ? (
                            <>
                                <div className="flex w-full items-center justify-between gap-x-1.5">
                                    <div className="composer-mobile-actions flex items-center gap-x-2 pl-1">
                                        <MobileSessionPanelTrigger
                                            footerIconButtonClass={footerIconButtonClass}
                                            iconSizeClass={iconSizeClass}
                                        />
                                        <ComposerAttachmentControls
                                            isVSCode={isVSCode}
                                            footerIconButtonClass={footerIconButtonClass}
                                            iconSizeClass={iconSizeClass}
                                            handlePickLocalFiles={handlePickLocalFiles}
                                            openIssuePicker={openIssuePicker}
                                            openPrPicker={openPrPicker}
                                            onOpenSettings={onOpenSettings}
                                            onOpenMobileSheet={openMobileAttachSheet}
                                        />
                                        <PermissionAutoAcceptButton
                                            footerIconButtonClass={footerIconButtonClass}
                                            iconSizeClass={iconSizeClass}
                                            permissionScopeSessionId={permissionScopeSessionId}
                                            permissionAutoAcceptEnabled={permissionAutoAcceptEnabled}
                                            handlePermissionAutoAcceptToggle={handlePermissionAutoAcceptToggle}
                                        />
                                    </div>
                                    <div className="flex items-center min-w-0 gap-x-1 justify-end">
                                        <div className="flex items-center gap-x-1 flex-shrink-0">
                                            <button
                                                type="button"
                                                className={footerIconButtonClass}
                                                // Keep the soft keyboard open (same guard as
                                                // PermissionAutoAcceptButton); the recording
                                                // engine lives in the wrapper-level
                                                // ComposerDictation instance.
                                                onMouseDown={(event) => event.preventDefault()}
                                                onPointerDownCapture={(event) => {
                                                    if (event.pointerType === 'touch') {
                                                        event.preventDefault();
                                                    }
                                                }}
                                                onClick={() => {
                                                    window.dispatchEvent(new CustomEvent('openchamber:dictation-toggle'));
                                                }}
                                                disabled={mobileDictationActive}
                                                title={t('chat.dictation.start')}
                                                aria-label={t('chat.dictation.start')}
                                            >
                                                <Icon name="mic" className={cn(iconSizeClass, 'text-current')} />
                                            </button>
                                            <ComposerActionButtons
                                                isMobile={isMobile}
                                                footerIconButtonClass={footerIconButtonClass}
                                                sendIconSizeClass={sendIconSizeClass}
                                                stopIconSizeClass={stopIconSizeClass}
                                                canSend={canSend}
                                                canAbort={canAbort}
                                                hasContent={!!hasContent}
                                                currentSessionId={currentSessionId}
                                                newSessionDraftOpen={newSessionDraftOpen}
                                                onPrimaryAction={handlePrimaryAction}
                                                onQueueMessage={handleQueueMessage}
                                                onAbort={handleAbort}
                                            />
                                        </div>
                                    </div>
                                </div>
                            </>
                        ) : (
                            <>
                                <div className={cn("flex items-center flex-shrink-0", footerGapClass)}>
                                    <ComposerAttachmentControls
                                        isVSCode={isVSCode}
                                        footerIconButtonClass={footerIconButtonClass}
                                        iconSizeClass={iconSizeClass}
                                        handlePickLocalFiles={handlePickLocalFiles}
                                        openIssuePicker={openIssuePicker}
                                        openPrPicker={openPrPicker}
                                        onOpenSettings={onOpenSettings}
                                    />
                                    <FocusModeButton
                                        footerIconButtonClass={footerIconButtonClass}
                                        iconSizeClass={iconSizeClass}
                                        isExpandedInput={isExpandedInput}
                                        onToggle={handleToggleExpandedInput}
                                    />
                                    <PermissionAutoAcceptButton
                                        footerIconButtonClass={footerIconButtonClass}
                                        iconSizeClass={iconSizeClass}
                                        permissionScopeSessionId={permissionScopeSessionId}
                                        permissionAutoAcceptEnabled={permissionAutoAcceptEnabled}
                                        handlePermissionAutoAcceptToggle={handlePermissionAutoAcceptToggle}
                                        withTooltip
                                    />
                                </div>
                                <div className={cn('flex items-center flex-1 justify-end', footerGapClass, 'md:gap-x-3')}>
                                    <MemoModelControls className={cn('flex-1 min-w-0 justify-end')} />
                                    <MemoComposerDictation
                                        radius={chatInputRadius}
                                        isMobile={isMobile}
                                        footerIconButtonClass={footerIconButtonClass}
                                        footerPaddingClass={footerPaddingClass}
                                        iconSizeClass={iconSizeClass}
                                        sendIconSizeClass={sendIconSizeClass}
                                        onInsert={handleDictationInsert}
                                        onInsertAndSend={handleDictationInsertAndSend}
                                        onContentHeightChange={handleDictationContentHeightChange}
                                    />
                                    <ComposerActionButtons
                                        isMobile={isMobile}
                                        footerIconButtonClass={footerIconButtonClass}
                                        sendIconSizeClass={sendIconSizeClass}
                                        stopIconSizeClass={stopIconSizeClass}
                                        canSend={canSend}
                                        canAbort={canAbort}
                                        hasContent={!!hasContent}
                                        currentSessionId={currentSessionId}
                                        newSessionDraftOpen={newSessionDraftOpen}
                                        onPrimaryAction={handlePrimaryAction}
                                        onQueueMessage={handleQueueMessage}
                                        onAbort={handleAbort}
                                    />
                                </div>
                            </>
                        )}
                    </div>
                    </div>

                </div>
                </>
                )}
                {/* Wrapper-level dictation engine + overlay: stays mounted across
                    the pill ↔ composer swap so a recording started from the pill
                    survives the morph. Its absolute overlay covers whichever
                    shape the wrapper currently has. */}
                {isMobile ? (
                    <MemoComposerDictation
                        radius={chatInputRadius}
                        isMobile={isMobile}
                        footerIconButtonClass={footerIconButtonClass}
                        footerPaddingClass={footerPaddingClass}
                        iconSizeClass={iconSizeClass}
                        sendIconSizeClass={sendIconSizeClass}
                        onInsert={handleDictationInsert}
                        onInsertAndSend={handleDictationInsertAndSend}
                        onActiveChange={handleMobileDictationActiveChange}
                        onContentHeightChange={handleDictationContentHeightChange}
                        renderTrigger={false}
                        topAccessory={mobileComposerHandle}
                    />
                ) : null}
                </div>
                {/* Mobile session panel: slide-up overlay toggled by
                    MobileSessionPanelTrigger. Mounted outside the pill
                    conditional so the pill's trigger works too. */}
                {isMobile && <MobileSessionStatusBar />}
                {/* Hidden host for the model/agent/variant bottom sheets. Kept
                    outside the pill conditional so an open panel survives (and
                    stays visible over) the collapsed composer. */}
                {isMobile ? (
                    <MemoModelControls
                        className="hidden"
                        mobilePanel={mobileControlsPanel}
                        onMobilePanelChange={setMobileControlsPanel}
                    />
                ) : null}
            </div>
            {newSessionDraftOpen && !isDesktopExpanded && !isMobile && !isVSCode && !isMiniChatSurface ? (
                <DraftPresetChips onSubmit={submitPresetPrompt} className="chat-input-column mt-4" />
            ) : null}
        </form>

        {/* Issue Picker Dialog */}
        <GitHubIssuePickerDialog
            open={issuePickerOpen}
            onOpenChange={setIssuePickerOpen}
            mode="select"
            onSelect={(issue) => {
                setLinkedIssue(issue);
                setLinkedPr(null);
            }}
        />
        <GitHubPrPickerDialog
            open={prPickerOpen}
            onOpenChange={setPrPickerOpen}
            onSelect={(pr) => {
                setLinkedPr(pr);
                setLinkedIssue(null);
            }}
        />
        <ReviewFlowDialog
            open={reviewDialogOpen}
            onOpenChange={setReviewDialogOpen}
            projectDirectory={currentSessionDirectoryForSync ?? currentDirectory ?? null}
            submitting={reviewFlowSubmitting}
            onConfirm={handleStartReviewFlow}
        />
        <ToolOutputDialog
            popup={attachmentPreview}
            onOpenChange={handleAttachmentPreviewOpenChange}
            isMobile={isMobile}
        />

        {/* Single always-mounted picker input. It must NOT live inside
            ComposerAttachmentControls: that component mounts once per composer
            variant (pill / expanded footer), so a shared ref got nulled when a
            variant unmounted, and a variant swap while the OS file picker was
            open detached the clicked input — its change event was silently
            lost and the picked files never attached. */}
        <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleLocalFileSelect}
            accept="*/*"
        />

        {/* Mobile attachment sheet: replaces the dropdown (which stole focus and
            dismissed the keyboard) and leaves room for more actions later. */}
        {isMobile ? (
            <MobileOverlayPanel
                open={mobileAttachMenuOpen}
                title={t('chat.chatInput.actions.addAttachment')}
                onClose={() => setMobileAttachMenuOpen(false)}
            >
                <div className="flex flex-col px-3 pb-4 pt-1">
                    <button
                        type="button"
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-3 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
                        onClick={() => {
                            // The native file/photo picker takes over next — restoring
                            // the keyboard in between would flash it open and shut.
                            restoreKeyboardAfterOverlayRef.current = false;
                            setMobileAttachMenuOpen(false);
                            requestAnimationFrame(handlePickLocalFiles);
                        }}
                    >
                        <Icon name="attachment-2" className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                        {t('chat.chatInput.actions.attachFiles')}
                    </button>
                    <button
                        type="button"
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-3 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
                        onClick={() => {
                            // Hand-off to the picker: don't sync-restore the
                            // keyboard under the overlay that opens next frame.
                            skipNextOverlayCloseRestoreRef.current = true;
                            setMobileAttachMenuOpen(false);
                            requestAnimationFrame(openIssuePicker);
                        }}
                    >
                        <Icon name="github" className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                        {t('chat.chatInput.actions.linkGithubIssue')}
                    </button>
                    <button
                        type="button"
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-3 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
                        onClick={() => {
                            skipNextOverlayCloseRestoreRef.current = true;
                            setMobileAttachMenuOpen(false);
                            requestAnimationFrame(openPrPicker);
                        }}
                    >
                        <Icon name="git-pull-request" className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                        {t('chat.chatInput.actions.linkGithubPr')}
                    </button>
                </div>
            </MobileOverlayPanel>
        ) : null}

        {/* Mobile draft target pickers: bottom sheets replacing the inline
            project/branch Selects (which desktop keeps). */}
        {isMobile && showDraftTargetSelectors && selectedDraftProject ? (
            <>
                <MobileOverlayPanel
                    open={mobileDraftPicker === 'project'}
                    title={t('chat.chatInput.draftPicker.projectTitle')}
                    onClose={() => setMobileDraftPicker(null)}
                >
                    <div className="flex flex-col gap-2 px-3 pb-4 pt-1">
                        <Input
                            value={mobileDraftPickerQuery}
                            onChange={(event) => setMobileDraftPickerQuery(event.target.value)}
                            placeholder={t('chat.chatInput.draftPicker.searchProjects')}
                            className="h-9"
                        />
                        <div className="flex flex-col">
                            {projects
                                .filter((project) => {
                                    const query = mobileDraftPickerQuery.trim().toLowerCase();
                                    if (!query) return true;
                                    return getProjectDisplayLabel(project).toLowerCase().includes(query)
                                        || project.path.toLowerCase().includes(query);
                                })
                                .map((project) => (
                                    <button
                                        key={project.id}
                                        type="button"
                                        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2.5 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
                                        onClick={() => {
                                            handleDraftProjectChange(project.id);
                                            setMobileDraftPicker(null);
                                        }}
                                    >
                                        <span className="min-w-0 flex-1">{renderProjectLabelWithIcon(project)}</span>
                                        {project.id === selectedDraftProject.id ? (
                                            <Icon name="check" className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                                        ) : null}
                                    </button>
                                ))}
                        </div>
                    </div>
                </MobileOverlayPanel>
                <MobileOverlayPanel
                    open={mobileDraftPicker === 'branch'}
                    title={t('chat.chatInput.branch')}
                    onClose={() => setMobileDraftPicker(null)}
                >
                    <div className="flex flex-col gap-2 px-3 pb-4 pt-1">
                        <Input
                            value={mobileDraftPickerQuery}
                            onChange={(event) => setMobileDraftPickerQuery(event.target.value)}
                            placeholder={t('chat.chatInput.draftPicker.searchBranches')}
                            className="h-9"
                        />
                        <div className="flex flex-col">
                            {(() => {
                                const query = mobileDraftPickerQuery.trim().toLowerCase();
                                const matches = (label: string) => !query || label.toLowerCase().includes(query);
                                const selectedValue = selectedDraftDirectory
                                    ?? draftBranchItems[0]?.value
                                    ?? normalizePath(selectedDraftProject.path)
                                    ?? '';
                                const renderRow = (value: string, label: React.ReactNode, key?: string) => (
                                    <button
                                        key={key ?? value}
                                        type="button"
                                        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2.5 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
                                        onClick={() => {
                                            handleDraftDirectoryChange(value);
                                            setMobileDraftPicker(null);
                                        }}
                                    >
                                        <span className="min-w-0 flex-1 truncate">{label}</span>
                                        {value === selectedValue ? (
                                            <Icon name="check" className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                                        ) : null}
                                    </button>
                                );
                                return (
                                    <>
                                        {projectRootBranchOption && matches(projectRootBranchOption.label) ? (
                                            <>
                                                <div className="px-2 pb-1 pt-1.5 text-muted-foreground typography-meta">
                                                    {t('chat.chatInput.projectRoot')}
                                                </div>
                                                {renderRow(projectRootBranchOption.value, projectRootBranchOption.label)}
                                            </>
                                        ) : null}
                                        <div className="flex items-center justify-between px-2 pb-1 pt-2">
                                            <span className="text-muted-foreground typography-meta">{t('chat.chatInput.worktrees')}</span>
                                            <button
                                                type="button"
                                                className="cursor-pointer text-muted-foreground typography-meta hover:text-foreground"
                                                onClick={() => {
                                                    setMobileDraftPicker(null);
                                                    void createWorktreeDraft();
                                                }}
                                            >
                                                {t('chat.chatInput.worktreeNew')}
                                            </button>
                                        </div>
                                        {worktreeBranchOptions
                                            .filter((option) => matches(option.label))
                                            .map((option) => renderRow(option.value, `${option.pending ? '⏳ ' : ''}${option.label}`))}
                                        {selectedDraftDirectory && !selectedDraftBranchIsKnown && matches(selectedDraftBranchLabel ?? '')
                                            ? renderRow(selectedDraftDirectory, selectedDraftBranchLabel, 'unknown-current')
                                            : null}
                                    </>
                                );
                            })()}
                        </div>
                    </div>
                </MobileOverlayPanel>
            </>
        ) : null}
        </>
    );
};

ChatInputComponent.displayName = 'ChatInput';

export const ChatInput = React.memo(ChatInputComponent);

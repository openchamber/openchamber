import React from 'react';
import { Textarea } from '@/components/ui/textarea';
import {
    RiAddCircleLine,
    RiAiAgentLine,
    RiAttachment2,
    RiCloseLine,
    RiCommandLine,
    RiExternalLinkLine,
    RiFolderLine,
    RiFullscreenLine,
    RiGitPullRequestLine,
    RiShieldCheckLine,
    RiShieldUserLine,
    RiGithubLine,
    RiSendPlane2Line,
} from '@remixicon/react';
import { BrowserVoiceButton } from '@/components/voice';
// sessionStore removed — currentSessionId comes from useSessionUIStore
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useInputStore } from '@/sync/input-store';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import * as sessionActions from '@/sync/session-actions';
import { useUserMessageHistory } from '@/sync/sync-context';
import { useInlineCommentDraftStore, type InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { appendInlineComments } from '@/lib/messages/inlineComments';
import { AttachedFilesList } from './FileAttachment';
import { QueuedMessageChips } from './QueuedMessageChips';
import { FileMentionAutocomplete, type FileMentionHandle } from './FileMentionAutocomplete';
import { CommandAutocomplete, type CommandAutocompleteHandle } from './CommandAutocomplete';
import { SkillAutocomplete, type SkillAutocompleteHandle } from './SkillAutocomplete';
import { cn, formatDirectoryName, isMacOS } from '@/lib/utils';
import { ModelControls } from './ModelControls';
import { UnifiedControlsDrawer } from './UnifiedControlsDrawer';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { StatusRow } from './StatusRow';
import { MobileAgentButton } from './MobileAgentButton';
import { MobileModelButton } from './MobileModelButton';
import { MobileSessionStatusBar } from './MobileSessionStatusBar';
import { useCurrentSessionActivity } from '@/hooks/useSessionActivity';
import { toast } from '@/components/ui';
// useMessageStore removed — messages now come from sync system
import { isTauriShell, isVSCodeRuntime } from '@/lib/desktop';
import { isIMECompositionEvent } from '@/lib/ime';
import { StopIcon } from '@/components/icons/StopIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { MobileControlsPanel } from './mobileControlsUtils';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { GitHubIssuePickerDialog } from '@/components/session/GitHubIssuePickerDialog';
import { GitHubPrPickerDialog } from '@/components/session/GitHubPrPickerDialog';
import { useChatSearchDirectory } from '@/hooks/useChatSearchDirectory';
import { opencodeClient } from '@/lib/opencode/client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, getProjectIconImageUrl } from '@/lib/projectMeta';
import { useGitBranches, useGitStore } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { createWorktreeDraft } from '@/lib/worktreeSessionCreator';
import { buildSessionTargetOptions } from '@/sync/session-worktree-contract';
import { usePermissionStore } from '@/stores/permissionStore';

const MAX_VISIBLE_TEXTAREA_LINES = 8;
const EMPTY_QUEUE: QueuedMessage[] = [];
const FILE_MENTION_TOKEN = /^@[^\s]+$/;
const CHAT_DRAFT_PERSIST_DEBOUNCE_MS = 500;
const VS_CODE_DROP_DATA_TYPES = [
    'CodeFiles',
    'codefiles',
    'application/vnd.code.tree',
    'application/vnd.code.tree.explorer',
    'text/uri-list',
    'text/plain',
];

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

const getProjectIconColor = (projectColor?: string | null): string | undefined => {
    if (!projectColor) {
        return undefined;
    }
    return PROJECT_COLOR_MAP[projectColor] ?? undefined;
};

const MemoModelControls = React.memo(ModelControls);
const MemoUnifiedControlsDrawer = React.memo(UnifiedControlsDrawer);
const MemoBrowserVoiceButton = React.memo(BrowserVoiceButton);
const MemoMobileAgentButton = React.memo(MobileAgentButton);
const MemoMobileModelButton = React.memo(MobileModelButton);
const MemoStatusRow = React.memo(StatusRow);

type ComposerAttachmentControlsProps = {
    isMobile: boolean;
    isVSCode: boolean;
    footerIconButtonClass: string;
    iconSizeClass: string;
    fileInputRef: React.RefObject<HTMLInputElement | null>;
    handleLocalFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void | Promise<void>;
    handlePickLocalFiles: () => void;
    handleOpenCommandMenu: () => void;
    openIssuePicker: () => void;
    openPrPicker: () => void;
    onOpenSettings?: () => void;
};

const ComposerAttachmentControls = React.memo(function ComposerAttachmentControls(props: ComposerAttachmentControlsProps) {
    const {
        isMobile,
        isVSCode,
        footerIconButtonClass,
        iconSizeClass,
        fileInputRef,
        handleLocalFileSelect,
        handlePickLocalFiles,
        handleOpenCommandMenu,
        openIssuePicker,
        openPrPicker,
        onOpenSettings,
    } = props;

    return (
        <div className="flex items-center gap-x-1.5">
            {isMobile ? (
                <button
                    type="button"
                    className={cn(
                        footerIconButtonClass,
                        'rounded-md',
                        'hover:bg-interactive-hover/40'
                    )}
                    onPointerDownCapture={(event) => {
                        if (event.pointerType === 'touch') {
                            event.preventDefault();
                            event.stopPropagation();
                        }
                    }}
                    onClick={handleOpenCommandMenu}
                    title="Commands"
                    aria-label="Commands"
                >
                    <RiCommandLine className={cn(iconSizeClass)} />
                </button>
            ) : null}
            <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleLocalFileSelect}
                accept="*/*"
            />

            <div className="relative inline-flex">
                {isVSCode ? (
                    <button
                        type="button"
                        className={footerIconButtonClass}
                        onClick={handlePickLocalFiles}
                        title="Attach files"
                        aria-label="Attach files"
                    >
                        <RiAttachment2 className={cn(iconSizeClass, 'text-current')} />
                    </button>
                ) : (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                className={footerIconButtonClass}
                                title="Add attachment"
                                aria-label="Add attachment"
                            >
                                <RiAddCircleLine className={cn(iconSizeClass, 'text-current')} />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            <DropdownMenuItem
                                onSelect={() => {
                                    requestAnimationFrame(handlePickLocalFiles);
                                }}
                            >
                                <RiAttachment2 />
                                Attach files
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onSelect={() => {
                                    requestAnimationFrame(openIssuePicker);
                                }}
                            >
                                <RiGithubLine />
                                Link GitHub Issue
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onSelect={() => {
                                    requestAnimationFrame(openPrPicker);
                                }}
                            >
                                <RiGitPullRequestLine />
                                Link GitHub PR
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
                    title="Model and agent settings"
                    aria-label="Model and agent settings"
                >
                    <RiAiAgentLine className={cn(iconSizeClass, 'text-current')} />
                </button>
            ) : null}
        </div>
    );
}, (prev, next) => (
    prev.isMobile === next.isMobile
    && prev.isVSCode === next.isVSCode
    && prev.footerIconButtonClass === next.footerIconButtonClass
    && prev.iconSizeClass === next.iconSizeClass
    && prev.onOpenSettings === next.onOpenSettings
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
    const {
        footerIconButtonClass,
        iconSizeClass,
        permissionScopeSessionId,
        permissionAutoAcceptEnabled,
        handlePermissionAutoAcceptToggle,
        withTooltip = false,
    } = props;

    const ariaLabel = permissionAutoAcceptEnabled
        ? 'Disable permission auto-accept'
        : 'Enable permission auto-accept';
    const tooltipLabel = permissionAutoAcceptEnabled
        ? 'Permission auto-accept: on'
        : 'Permission auto-accept: off';

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
                <RiShieldCheckLine className={cn(iconSizeClass)} style={{ color: 'var(--status-info)' }} />
            ) : (
                <RiShieldUserLine className={cn(iconSizeClass)} />
            )}
        </button>
    );

    if (!withTooltip) {
        return button;
    }

    return (
        <Tooltip delayDuration={600}>
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

    return (
        <Tooltip delayDuration={600}>
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
                    aria-label="Toggle focus mode"
                    aria-pressed={isExpandedInput}
                >
                    <RiFullscreenLine className={cn(iconSizeClass)} />
                </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
                <div className="flex flex-col gap-0.5 text-center">
                    <span>Focus mode</span>
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
            aria-label="Send message"
        >
            <RiSendPlane2Line className={cn(sendIconSizeClass)} />
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
                    aria-label="Queue message"
                >
                    <RiSendPlane2Line className={cn(sendIconSizeClass, '-rotate-90')} />
                </button>
            ) : null}
            <button
                type="button"
                onClick={onAbort}
                className={cn(
                    footerIconButtonClass,
                    'text-[var(--status-error)] hover:text-[var(--status-error)]'
                )}
                aria-label="Stop generating"
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
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
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

const ChatInputComponent: React.FC<ChatInputProps> = ({ onOpenSettings, scrollToBottom }) => {
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
    const [inputMode, setInputMode] = React.useState<'normal' | 'shell'>('normal');
    const [isDragging, setIsDragging] = React.useState(false);
    const [showFileMention, setShowFileMention] = React.useState(false);
    const [mentionQuery, setMentionQuery] = React.useState('');
    const [showCommandAutocomplete, setShowCommandAutocomplete] = React.useState(false);
    const [commandQuery, setCommandQuery] = React.useState('');
    const [autocompleteTab, setAutocompleteTab] = React.useState<'commands' | 'agents' | 'files'>('commands');
    const [showSkillAutocomplete, setShowSkillAutocomplete] = React.useState(false);
    const [skillQuery, setSkillQuery] = React.useState('');
    const [textareaSize, setTextareaSize] = React.useState<{ height: number; maxHeight: number } | null>(null);
    const [mobileControlsOpen, setMobileControlsOpen] = React.useState(false);
    const [mobileControlsPanel, setMobileControlsPanel] = React.useState<MobileControlsPanel>(null);
    // Message history navigation state (up/down arrow to recall previous messages)
    const [historyIndex, setHistoryIndex] = React.useState(-1); // -1 = not browsing, 0+ = index from most recent
    const [draftMessage, setDraftMessage] = React.useState(''); // Preserves input when entering history mode
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const previousMessageLengthRef = React.useRef(message.length);
    const dropZoneRef = React.useRef<HTMLDivElement>(null);
    const suppressNextFileDropTextInsertRef = React.useRef(false);
    const suppressNextFileDropTextInsertTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingDroppedAbsolutePathsRef = React.useRef<string[]>([]);
    const canAcceptDropRef = React.useRef(false);
    const nativeDragInsideDropZoneRef = React.useRef(false);
    const mentionRef = React.useRef<FileMentionHandle>(null);
    const commandRef = React.useRef<CommandAutocompleteHandle>(null);
    const skillRef = React.useRef<SkillAutocompleteHandle>(null);
    // Ref to track current message value without triggering re-renders in effects
    const messageRef = React.useRef(message);
    const draftPersistTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const skipNextDraftPersistRef = React.useRef(false);
    const lastPersistedDraftRef = React.useRef<Map<string, string>>(new Map());
    const currentSessionIdForDraftRef = React.useRef<string | null>(null);

    // TODO: port sendMessage to session-actions (complex — creates sessions, handles attachments, etc.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendMessage = React.useRef((...args: any[]) =>
        Promise.resolve((useSessionUIStore.getState().sendMessage as (...a: unknown[]) => unknown)(...args)),
    ).current;
    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const newSessionDraftOpen = Boolean(newSessionDraft?.open);
    const setNewSessionDraftTarget = useSessionUIStore((s) => s.setNewSessionDraftTarget);
    const availableWorktreesByProject = useSessionUIStore((s) => s.availableWorktreesByProject);
    const abortPromptSessionId = useSessionUIStore((s) => s.abortPromptSessionId);
    const clearAbortPrompt = useSessionUIStore((s) => s.clearAbortPrompt);
    const attachedFiles = useInputStore((s) => s.attachedFiles);
    const addAttachedFile = useInputStore((s) => s.addAttachedFile);
    const clearAttachedFiles = useInputStore((s) => s.clearAttachedFiles);
    const saveSessionAgentSelection = useSelectionStore((s) => s.saveSessionAgentSelection);
    const consumePendingInputText = useInputStore((s) => s.consumePendingInputText);
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

    const currentProviderId = useConfigStore((state) => state.currentProviderId);
    const currentModelId = useConfigStore((state) => state.currentModelId);
    const currentVariant = useConfigStore((state) => state.currentVariant);
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const setAgent = useConfigStore((state) => state.setAgent);
    const getVisibleAgents = useConfigStore((state) => state.getVisibleAgents);
    const agents = getVisibleAgents();
    const primaryAgents = React.useMemo(() => agents.filter((agent) => agent.mode === 'primary'), [agents]);
    const isMobile = useUIStore((state) => state.isMobile);
    const inputBarOffset = useUIStore((state) => state.inputBarOffset);
    const isKeyboardOpen = useUIStore((state) => state.isKeyboardOpen);
    const persistChatDraft = useUIStore((state) => state.persistChatDraft);
    const inputSpellcheckEnabled = useUIStore((state) => state.inputSpellcheckEnabled);
    const isExpandedInput = useUIStore((state) => state.isExpandedInput);
    const setExpandedInput = useUIStore((state) => state.setExpandedInput);
    const { git: runtimeGit } = useRuntimeAPIs();
    const { currentTheme } = useThemeSystem();
    const chatSearchDirectory = useChatSearchDirectory();
    const [showAbortStatus, setShowAbortStatus] = React.useState(false);
    const setSessionAutoAccept = usePermissionStore((state) => state.setSessionAutoAccept);
    const composerHighlightRef = React.useRef<HTMLDivElement | null>(null);

    const isDesktopExpanded = isExpandedInput && !isMobile;
    const chatInputRadius = 'var(--radius-lg)';

    const sendableAttachedFiles = attachedFiles;

    const hasInlineMentionForHighlight = React.useMemo(() => {
        if (!message || !message.includes('@') || inputMode === 'shell') {
            return false;
        }
        const knownAgentNames = new Set(agents.map((agent) => agent.name.toLowerCase()));
        const mentionRegex = /@([^\s]+)/g;
        let match: RegExpExecArray | null;
        while ((match = mentionRegex.exec(message)) !== null) {
            const offset = match.index;
            const charBefore = offset > 0 ? message[offset - 1] : null;
            if (charBefore && !/(\s|\(|\)|\[|\]|\{|\}|"|'|`|,|\.|;|:)/.test(charBefore)) {
                continue;
            }
            const mentionPath = String(match[1] || '').trim().replace(/[),.;:!?`"'>]+$/g, '');
            if (!mentionPath) {
                continue;
            }
            if (knownAgentNames.has(mentionPath.toLowerCase())) {
                return true;
            }
            if (mentionPath.includes('/') || mentionPath.includes('\\') || mentionPath.includes('.')) {
                return true;
            }
        }
        return false;
    }, [agents, inputMode, message]);

    const highlightedComposerContent = React.useMemo(() => {
        if (!hasInlineMentionForHighlight) {
            return null;
        }

        const parts: Array<{ text: string; mentionKind: 'none' | 'file' | 'agent' }> = [];
        const knownAgentNames = new Set(agents.map((agent) => agent.name.toLowerCase()));
        const mentionRegex = /@([^\s]+)/g;
        let lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = mentionRegex.exec(message)) !== null) {
            const full = match[0];
            const mention = String(match[1] || '').trim().replace(/[),.;:!?`"'>]+$/g, '');
            const start = match.index;
            const end = start + full.length;
            const charBefore = start > 0 ? message[start - 1] : null;
            const isBoundary = !charBefore || /(\s|\(|\)|\[|\]|\{|\}|"|'|`|,|\.|;|:)/.test(charBefore);
            const isAgentMention = isBoundary && mention.length > 0 && knownAgentNames.has(mention.toLowerCase());
            const isFileMention = isBoundary
                && mention.length > 0
                && !knownAgentNames.has(mention.toLowerCase())
                && (mention.includes('/') || mention.includes('\\') || mention.includes('.'));

            if (start > lastIndex) {
                parts.push({ text: message.slice(lastIndex, start), mentionKind: 'none' });
            }
            parts.push({
                text: full,
                mentionKind: isFileMention ? 'file' : isAgentMention ? 'agent' : 'none',
            });
            lastIndex = end;
        }

        if (lastIndex < message.length) {
            parts.push({ text: message.slice(lastIndex), mentionKind: 'none' });
        }

        return parts;
    }, [agents, hasInlineMentionForHighlight, message]);

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
        const knownAgentNames = new Set(agents.map((agent) => agent.name.toLowerCase()));
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

            if (knownAgentNames.has(mentionPath.toLowerCase())) {
                continue;
            }

            const looksLikeFilePath = mentionPath.includes('/') || mentionPath.includes('\\') || mentionPath.includes('.');
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
    }, [agents, chatSearchDirectory]);
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
    const queueModeEnabled = useMessageQueueStore((state) => state.queueModeEnabled);
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
    const consumeDrafts = useInlineCommentDraftStore((state) => state.consumeDrafts);
    const hasDrafts = draftCount > 0;

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
                if (newDraft) {
                    requestAnimationFrame(() => {
                        textareaRef.current?.select();
                    });
                }
            } else {
                // Persist disabled: clear input without saving
                setMessage('');
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

    const handleTextareaPointerDownCapture = React.useCallback((event: React.PointerEvent<HTMLTextAreaElement>) => {
        if (!isMobile) {
            return;
        }

        if (event.pointerType !== 'touch') {
            return;
        }

        const textarea = textareaRef.current;
        if (!textarea) {
            return;
        }

        if (document.activeElement === textarea) {
            return;
        }

        // Prevent iOS from scrolling the page to reveal the input.
        event.preventDefault();
        event.stopPropagation();

        const scroller = document.scrollingElement;
        if (scroller && scroller.scrollTop !== 0) {
            scroller.scrollTop = 0;
        }
        if (window.scrollY !== 0) {
            window.scrollTo(0, 0);
        }

        try {
            textarea.focus({ preventScroll: true });
        } catch {
            textarea.focus();
        }

        const len = textarea.value.length;
        try {
            textarea.setSelectionRange(len, len);
        } catch {
            // ignored
        }
    }, [isMobile]);

    const handleOpenMobileControls = React.useCallback(() => {
        if (!isMobile) {
            return;
        }

        if (mobileControlsOpen) {
            setMobileControlsOpen(false);
            return;
        }

        setMobileControlsPanel(null);

        if (isKeyboardOpen) {
            textareaRef.current?.blur();
            requestAnimationFrame(() => {
                setMobileControlsOpen(true);
            });
            return;
        }

        setMobileControlsOpen(true);
    }, [isMobile, isKeyboardOpen, mobileControlsOpen]);

    const handleCloseMobileControls = React.useCallback(() => {
        setMobileControlsOpen(false);
    }, []);

    const handleOpenMobilePanel = React.useCallback((panel: MobileControlsPanel) => {
        if (!isMobile) {
            return;
        }
        setMobileControlsOpen(false);
        textareaRef.current?.blur();
        requestAnimationFrame(() => {
            setMobileControlsPanel(panel);
        });
    }, [isMobile]);

    const handleReturnToUnifiedControls = React.useCallback(() => {
        if (!isMobile) {
            return;
        }
        setMobileControlsPanel(null);
        requestAnimationFrame(() => {
            setMobileControlsOpen(true);
        });
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

    // Keep a ref to handleSubmit so callbacks don't depend on it.
    type SubmitOptions = {
        queuedOnly?: boolean;
    };
    const handleSubmitRef = React.useRef<(options?: SubmitOptions) => Promise<void>>(async () => {});

    // Add message to queue instead of sending
    const handleQueueMessage = React.useCallback(() => {
        if (!hasContent || !currentSessionId) return;

        const drafts = consumeDrafts(currentSessionId);

        let messageToQueue = message.replace(/^\n+|\n+$/g, '');
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
        setMessage('');
        if (attachmentsToQueue.length > 0) {
            clearAttachedFiles();
        }

        if (!isMobile) {
            textareaRef.current?.focus();
        }
    }, [hasContent, currentSessionId, message, sendableAttachedFiles, sanitizeAttachmentsForSend, addToQueue, clearAttachedFiles, isMobile, consumeDrafts, currentProviderId, currentModelId, currentAgentName, currentVariant]);

    const handleQueuedMessageEdit = React.useCallback((content: string) => {
        setMessage(content);
        setTimeout(() => {
            textareaRef.current?.focus();
        }, 0);
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

        if (queuedOnly) {
            if (!hasQueuedMessages || !currentSessionId) return;
        } else if (!canSend || (!currentSessionId && !newSessionDraftOpen)) {
            return;
        }

        if (!currentProviderId || !currentModelId) {
            console.warn('Cannot send message: provider or model not selected');
            return;
        }

        // Build the primary message (first part) and additional parts
        let primaryText = '';
        let primaryAttachments: AttachedFile[] = [];
        let agentMentionName: string | undefined;
        const additionalParts: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }> = [];

        // Consume any pending synthetic parts (from conflict resolution, etc.)
        const syntheticParts = consumePendingSyntheticParts();

        // Process queued messages first
        for (let i = 0; i < queuedMessages.length; i++) {
            const queuedMsg = queuedMessages[i];
            const { sanitizedText, mention } = parseAgentMentions(queuedMsg.content, agents);
            const { sanitizedText: queuedText, attachments: mentionAttachments } = extractInlineFileMentions(sanitizedText);

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
        if (!queuedOnly && hasContent) {
            const messageToSend = message.replace(/^\n+|\n+$/g, '');
            const { sanitizedText, mention } = parseAgentMentions(messageToSend, agents);
            const { sanitizedText: messageText, attachments: mentionAttachments } = extractInlineFileMentions(sanitizedText);
            const attachmentsToSend = sanitizeAttachmentsForSend(sendableAttachedFiles);

            if (!agentMentionName && mention?.name) {
                agentMentionName = mention.name;
            }

            if (queuedMessages.length === 0) {
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
            if (queuedMessages.length === 0) {
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

        if (!primaryText && additionalParts.length === 0) return;

        // Clear queue and input
        if (currentSessionId && hasQueuedMessages) {
            clearQueue(currentSessionId);
        }
        if (!queuedOnly) {
            setMessage('');
            // Clear per-session draft on submit
            saveStoredDraft(currentSessionId, '');
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
                scrollToBottom?.({ instant: true, force: true });
                return;
            }
            else if (commandName === 'redo' && currentSessionId) {
                await useSessionUIStore.getState().handleSlashRedo(currentSessionId);
                scrollToBottom?.({ instant: true, force: true });
                return;
            }
            else if (commandName === 'compact' && currentSessionId) {
                try {
                    if (!useConfigStore.getState().isConnected) {
                        throw new Error("Connection lost. Please wait for reconnection.");
                    }
                    const { opencodeClient } = await import('@/lib/opencode/client');
                    const sdk = opencodeClient.getSdkClient();
                    const configState = useConfigStore.getState();
                    await sdk.session.summarize({
                        sessionID: currentSessionId,
                        modelID: configState.currentModelId || '',
                        providerID: configState.currentProviderId || '',
                    });
                } catch (error) {
                    toast.error(error instanceof Error ? error.message : 'Failed to compact session');
                }
                return;
            }
        }

        // Collect all attachments for error recovery
        const allAttachments = [
            ...primaryAttachments,
            ...additionalParts.flatMap(p => p.attachments ?? []),
        ];

        const sendPromise = sendMessage(
            primaryText,
            currentProviderId,
            currentModelId,
            currentAgentName,
            primaryAttachments,
            agentMentionName,
            additionalParts.length > 0 ? additionalParts : undefined,
            currentVariant,
            inputMode
        );

        if (typeof window === 'undefined') {
            scrollToBottom?.({ instant: true, force: true });
        } else {
            window.requestAnimationFrame(() => {
                scrollToBottom?.({ instant: true, force: true });
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
                toast.error('Attachments are too large to send. Please try reducing the number or size of images.');
                if (allAttachments.length > 0) {
                    useInputStore.setState({ attachedFiles: allAttachments });
                }
                return;
            }

            if (isSoftNetworkError) {
                if (allAttachments.length > 0) {
                    useInputStore.setState({ attachedFiles: allAttachments });
                    toast.error('Failed to send attachments. Try fewer files or smaller images.');
                }
                return;
            }

            if (allAttachments.length > 0) {
                useInputStore.setState({ attachedFiles: allAttachments });
            }
            toast.error(rawMessage || 'Message failed to send. Attachments restored.');
        });

        if (!isMobile) {
            textareaRef.current?.focus();
        }
    };

    // Update ref with latest handleSubmit on every render
    handleSubmitRef.current = handleSubmit;

    // Primary action for send button - respects queue mode setting
    const handlePrimaryAction = React.useCallback(() => {
        const canQueue = inputMode === 'normal' && hasContent && currentSessionId && sessionPhase !== 'idle';
        if (queueModeEnabled && canQueue) {
            handleQueueMessage();
        } else {
            void handleSubmitRef.current();
        }
    }, [inputMode, hasContent, currentSessionId, sessionPhase, queueModeEnabled, handleQueueMessage]);

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
                    const looksLikeFileMention = FILE_MENTION_TOKEN.test(token)
                        && (token.includes('/') || token.includes('\\') || token.includes('.'));

                    if (looksLikeFileMention) {
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
                commandRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (showSkillAutocomplete && skillRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                skillRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (showFileMention && mentionRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                mentionRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (isDesktopExpanded && e.key === 'Escape') {
            e.preventDefault();
            setExpandedInput(false);
            return;
        }

        if (e.key === 'Tab' && !showCommandAutocomplete && !showFileMention) {
            e.preventDefault();
            handleCycleAgent();
            return;
        }

        // Handle ArrowUp/ArrowDown for message history navigation
        // ArrowUp: only when cursor at start (position 0) or input is empty
        // ArrowDown: also works when cursor at end (to cycle forward through history)
        const isAnyAutocompleteOpen = showCommandAutocomplete || showSkillAutocomplete || showFileMention;
        const cursorAtStart = textareaRef.current?.selectionStart === 0 && textareaRef.current?.selectionEnd === 0;
        const cursorAtEnd = textareaRef.current?.selectionStart === message.length && textareaRef.current?.selectionEnd === message.length;
        const canNavigateHistoryUp = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtStart);
        const canNavigateHistoryDown = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtEnd);

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

        // Handle Enter/Ctrl+Enter based on queue mode
        if (e.key === 'Enter' && !e.shiftKey && (!isMobile || e.ctrlKey || e.metaKey)) {
            e.preventDefault();

            const isCtrlEnter = e.ctrlKey || e.metaKey;

            // Queue mode: Enter queues, Ctrl+Enter sends
            // Normal mode: Enter sends, Ctrl+Enter queues
            // Note: Queueing only works when there's an existing session (currentSessionId)
            // For new sessions (draft), always send immediately
            const canQueue = inputMode === 'normal' && hasContent && currentSessionId && sessionPhase !== 'idle';

            if (queueModeEnabled) {
                if (isCtrlEnter || !canQueue) {
                    // Ctrl+Enter sends, or Enter when can't queue (new session)
                    handleSubmit();
                } else {
                    // Enter queues when we have a session
                    handleQueueMessage();
                }
            } else {
                if (isCtrlEnter && canQueue) {
                    // Ctrl+Enter queues when we have a session
                    handleQueueMessage();
                } else {
                    // Enter sends
                    handleSubmit();
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

        if (!showCommandAutocomplete && !showSkillAutocomplete && !showFileMention) {
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

        const desiredWidth = showFileMention ? 520 : showCommandAutocomplete ? 450 : 360;
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
        showSkillAutocomplete,
    ]);

    React.useLayoutEffect(() => {
        updateAutocompleteOverlayPosition();
    }, [
        updateAutocompleteOverlayPosition,
        message,
        showCommandAutocomplete,
        showSkillAutocomplete,
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

    const handleCycleAgent = React.useCallback(() => {
        if (primaryAgents.length <= 1) return;

        const currentIndex = primaryAgents.findIndex(agent => agent.name === currentAgentName);
        const nextIndex = (currentIndex + 1) % primaryAgents.length;
        const nextAgent = primaryAgents[nextIndex];

        setAgent(nextAgent.name);

        if (currentSessionId) {
            saveSessionAgentSelection(currentSessionId, nextAgent.name);
        }
    }, [primaryAgents, currentAgentName, currentSessionId, setAgent, saveSessionAgentSelection]);

    const adjustTextareaHeight = React.useCallback((options?: { allowShrink?: boolean }) => {
        const textarea = textareaRef.current;
        if (!textarea) {
            return;
        }

        const previousScrollTop = textarea.scrollTop;

        if (isDesktopExpanded) {
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
        const nextHeight = Math.min(scrollHeight, maxHeight);

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
    }, [isDesktopExpanded]);

    React.useLayoutEffect(() => {
        const allowShrink = message.length < previousMessageLengthRef.current;
        previousMessageLengthRef.current = message.length;
        adjustTextareaHeight({ allowShrink });
    }, [adjustTextareaHeight, message, isMobile]);

    const updateAutocompleteState = React.useCallback((value: string, cursorPosition: number) => {
        if (inputMode === 'shell') {
            setShowCommandAutocomplete(false);
            setShowFileMention(false);
            setShowSkillAutocomplete(false);
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
                setAutocompleteTab('commands');
                setShowCommandAutocomplete(true);
                setShowFileMention(false);
                setShowSkillAutocomplete(false);
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

        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
        if (lastAtSymbol !== -1) {
            const charBefore = lastAtSymbol > 0 ? textBeforeCursor[lastAtSymbol - 1] : null;
            const textAfterAt = textBeforeCursor.substring(lastAtSymbol + 1);
            const isWordBoundary = !charBefore || /\s/.test(charBefore);
            if (isWordBoundary && !textAfterAt.includes(' ') && !textAfterAt.includes('\n')) {
                setMentionQuery(textAfterAt);
                setAutocompleteTab('agents');
                setShowFileMention(true);
            } else {
                setShowFileMention(false);
            }
        } else {
            setShowFileMention(false);
        }
    }, [inputMode, setAutocompleteTab, setCommandQuery, setMentionQuery, setShowCommandAutocomplete, setShowFileMention, setShowSkillAutocomplete, setSkillQuery]);

    const applyAutocompletePrefix = React.useCallback((prefix: '/' | '@') => {
        const nextMessage = message.length === 0
            ? prefix
            : (message[0] === '/' || message[0] === '@')
                ? `${prefix}${message.slice(1)}`
                : `${prefix}${message}`;
        setMessage(nextMessage);
        requestAnimationFrame(() => {
            if (textareaRef.current) {
                const nextCursor = Math.min(nextMessage.length, textareaRef.current.value.length);
                textareaRef.current.selectionStart = nextCursor;
                textareaRef.current.selectionEnd = nextCursor;
            }
            adjustTextareaHeight();
            updateAutocompleteState(nextMessage, nextMessage.length);
        });
    }, [adjustTextareaHeight, message, setMessage, updateAutocompleteState]);

    const handleAutocompleteTabSelect = React.useCallback((tab: 'commands' | 'agents' | 'files') => {
        const textarea = textareaRef.current;
        if (isMobile && textarea) {
            try {
                textarea.focus({ preventScroll: true });
            } catch {
                textarea.focus();
            }
            const len = textarea.value.length;
            try {
                textarea.setSelectionRange(len, len);
            } catch {
                // ignored
            }
        }
        setAutocompleteTab(tab);
        setCommandQuery('');
        setMentionQuery('');
        if (tab === 'commands') {
            applyAutocompletePrefix('/');
        }
        if (tab === 'agents') {
            applyAutocompletePrefix('@');
        }
        if (tab === 'files') {
            applyAutocompletePrefix('@');
        }
        setShowSkillAutocomplete(false);
        setShowCommandAutocomplete(tab === 'commands');
        setShowFileMention(tab === 'agents' || tab === 'files');
    }, [applyAutocompletePrefix, isMobile, setAutocompleteTab, setCommandQuery, setMentionQuery, setShowCommandAutocomplete, setShowFileMention, setShowSkillAutocomplete]);

    const handleOpenCommandMenu = React.useCallback(() => {
        if (!isMobile) {
            return;
        }
        const textarea = textareaRef.current;
        if (textarea) {
            try {
                textarea.focus({ preventScroll: true });
            } catch {
                textarea.focus();
            }
            const len = textarea.value.length;
            try {
                textarea.setSelectionRange(len, len);
            } catch {
                // ignored
            }
        }
        applyAutocompletePrefix('/');
        setCommandQuery('');
        setAutocompleteTab('commands');
        setShowCommandAutocomplete(true);
        setShowFileMention(false);
        setShowSkillAutocomplete(false);
    }, [applyAutocompletePrefix, isMobile, setAutocompleteTab, setCommandQuery, setShowCommandAutocomplete, setShowFileMention, setShowSkillAutocomplete]);

    const insertTextAtSelection = React.useCallback((text: string) => {
        if (!text) {
            return;
        }

        const textarea = textareaRef.current;
        if (!textarea) {
            const nextValue = message + text;
            setMessage(nextValue);
            updateAutocompleteState(nextValue, nextValue.length);
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

        updateAutocompleteState(nextValue, cursorPosition);
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
        updateAutocompleteState(value, cursorPosition);
    };

    React.useEffect(() => {
        return () => {
            clearDropTextSuppression();
        };
    }, [clearDropTextSuppression]);

    const handlePaste = React.useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
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
        if (imageFiles.length === 0) {
            return;
        }

        if (!currentSessionId && !newSessionDraftOpen) {
            return;
        }

        e.preventDefault();

        const pastedText = e.clipboardData.getData('text');
        if (pastedText) {
            insertTextAtSelection(pastedText);
        }

        for (const file of imageFiles) {
            try {
                await addAttachedFile(file);
            } catch (error) {
                console.error('Clipboard image attach failed', error);
                toast.error(error instanceof Error ? error.message : 'Failed to attach image from clipboard');
            }
        }
    }, [addAttachedFile, currentSessionId, newSessionDraftOpen, insertTextAtSelection]);

    const handleFileSelect = (file: { name: string; path: string; relativePath?: string }) => {

        const cursorPosition = textareaRef.current?.selectionStart || 0;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

        const mentionPath = (file.relativePath && file.relativePath.trim().length > 0)
            ? file.relativePath.trim()
            : (toProjectRelativeMentionPath(file.path) || file.name);

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

    const handleCommandSelect = (command: { name: string; description?: string; agent?: string; model?: string }) => {

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
            setMobileControlsOpen(false);
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

        const mentions = Array.from(new Set(uris
            .map((entry) => normalizeDroppedPath(entry))
            .map((entry) => toProjectRelativeMentionPath(entry))
            .map((entry) => entry.trim().replace(/^\.\//, ''))
            .filter((entry) => entry.length > 0)
            .map((entry) => `@${entry}`)));

        if (mentions.length === 0) {
            return;
        }

        setPendingInputText(mentions.join(' '), 'append-inline');
        toast.success(`Added ${mentions.length} file mention${mentions.length > 1 ? 's' : ''}`);
    }, [normalizeDroppedPath, setPendingInputText, toProjectRelativeMentionPath]);

    const handleDragEnter = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
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
        if (e.currentTarget === e.target) {
            setIsDragging(false);
            clearDropTextSuppression();
        }
    };

    const handleDrop = async (e: React.DragEvent) => {
        const draggedFiles = hasDraggedFiles(e.dataTransfer);
        if (!draggedFiles) {
            clearDropTextSuppression();
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);

        if (!currentSessionId && !newSessionDraftOpen) return;

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
                    toast.error(error instanceof Error ? error.message : 'Failed to attach file');
                }
            }
        }
        clearDropTextSuppression();
    };

    const handleDropCapture = (e: React.DragEvent) => {
        if (!isVSCodeRuntime()) {
            return;
        }
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        suppressNextFileDropTextInsertRef.current = true;
        scheduleDropTextSuppressionExpiry();
        e.preventDefault();
    };

    // Tauri desktop: handle native file drops via onDragDropEvent
    React.useEffect(() => {
        if (!isTauriShell()) return;
        let cancelled = false;
        let unlisten: (() => void) | null = null;

        void (async () => {
            try {
                const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
                const webviewWindow = getCurrentWebviewWindow();
                const removeListener = await webviewWindow.onDragDropEvent(async (event) => {
                    if (!canAcceptDropRef.current) return;

                    const payload = (event as { payload?: unknown }).payload;
                    if (!payload || typeof payload !== 'object') return;

                    const typed = payload as { type?: string; paths?: string[]; position?: { x?: number; y?: number } };
                    const type = typed.type;
                    const x = typed.position?.x;
                    const y = typed.position?.y;

                    // Check if drop is inside the chat input area
                    const zone = dropZoneRef.current;
                    let inZone: boolean | null = null;
                    if (zone && typeof x === 'number' && typeof y === 'number') {
                        const rect = zone.getBoundingClientRect();
                        inZone = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
                        // Handle retina displays where Tauri might report physical pixels
                        if (!inZone && window.devicePixelRatio > 1) {
                            const sx = x / window.devicePixelRatio;
                            const sy = y / window.devicePixelRatio;
                            inZone = sx >= rect.left && sx <= rect.right && sy >= rect.top && sy <= rect.bottom;
                        }
                    }

                    if (type === 'enter' || type === 'over') {
                        if (inZone !== null) {
                            nativeDragInsideDropZoneRef.current = inZone;
                        }
                        setIsDragging(nativeDragInsideDropZoneRef.current);
                        return;
                    }
                    if (type === 'leave') {
                        nativeDragInsideDropZoneRef.current = false;
                        setIsDragging(false);
                        return;
                    }
                    if (type === 'drop') {
                        const shouldHandleDrop = inZone ?? nativeDragInsideDropZoneRef.current;
                        nativeDragInsideDropZoneRef.current = false;
                        setIsDragging(false);
                        if (!shouldHandleDrop) return;

                        const paths = Array.isArray(typed.paths)
                            ? typed.paths.filter((p): p is string => typeof p === 'string')
                            : [];
                        if (paths.length === 0) return;

                        for (const path of paths) {
                            try {
                                const normalizedPath = normalizeDroppedPath(path);
                                const fileName = normalizedPath.split(/[\\/]/).pop() || normalizedPath;
                                let file: File;

                                // In Tauri shell, dropped paths are local machine paths.
                                // Read bytes via native command to avoid workspace-bound /api/fs/raw restrictions.
                                if (isTauriShell()) {
                                    const { invoke } = await import('@tauri-apps/api/core');
                                    const result = await invoke<{ mime: string; base64: string }>('desktop_read_file', { path: normalizedPath });
                                    const byteCharacters = atob(result.base64);
                                    const byteNumbers = new Array(byteCharacters.length);
                                    for (let i = 0; i < byteCharacters.length; i++) {
                                        byteNumbers[i] = byteCharacters.charCodeAt(i);
                                    }
                                    const byteArray = new Uint8Array(byteNumbers);
                                    const blob = new Blob([byteArray], { type: result.mime || 'application/octet-stream' });
                                    file = new File([blob], fileName, { type: result.mime || 'application/octet-stream' });
                                } else {
                                    const response = await fetch(`/api/fs/raw?path=${encodeURIComponent(normalizedPath)}`);
                                    if (!response.ok) {
                                        throw new Error(`Failed to read dropped file (${response.status})`);
                                    }
                                    const blob = await response.blob();
                                    file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
                                }

                                await addAttachedFile(file);
                            } catch (error) {
                                console.error('Failed to attach dropped file:', path, error);
                                toast.error(`Failed to attach ${path.split(/[\\/]/).pop() || 'file'}`);
                            }
                        }
                    }
                });

                if (cancelled) {
                    removeListener();
                    return;
                }
                unlisten = removeListener;
            } catch (error) {
                if (!cancelled) {
                    console.warn('Failed to register Tauri drag-drop listener:', error);
                }
            }
        })();

        return () => {
            cancelled = true;
            if (unlisten) unlisten();
        };
    }, [addAttachedFile, normalizeDroppedPath]);

    const fileInputRef = React.useRef<HTMLInputElement>(null);

    const attachFiles = React.useCallback(async (files: FileList | File[]) => {
        const list = Array.isArray(files) ? files : Array.from(files);

        for (const file of list) {
            try {
                await addAttachedFile(file);
            } catch (error) {
                console.error('File attach failed', error);
                toast.error(error instanceof Error ? error.message : 'Failed to attach file');
            }
        }
    }, [addAttachedFile]);

    const handleVSCodePickFiles = React.useCallback(async () => {
        try {
            const response = await fetch('/api/vscode/pick-files');
            const data = await response.json();
            const picked = Array.isArray(data?.files) ? data.files : [];
            const skipped = Array.isArray(data?.skipped) ? data.skipped : [];

            if (skipped.length > 0) {
                const summary = skipped
                    .map((s: { name?: string; reason?: string }) => `${s?.name || 'file'}: ${s?.reason || 'skipped'}`)
                    .join('\n');
                toast.error(`Some files were skipped:\n${summary}`);
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
            toast.error(error instanceof Error ? error.message : 'Failed to pick files in VS Code');
        }
    }, [attachFiles]);

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

    const selectedDraftProjectBranches = useGitBranches(selectedDraftProjectPath);
    const fetchBranches = useGitStore((state) => state.fetchBranches);
    const [isDiscoveringDraftBranches, setIsDiscoveringDraftBranches] = React.useState(false);

    React.useEffect(() => {
        if (!showDraftTargetSelectors || !selectedDraftProjectPath || !selectedDraftProject || !runtimeGit) {
            setIsDiscoveringDraftBranches(false);
            return;
        }

        if (selectedDraftProjectBranches?.all) {
            setIsDiscoveringDraftBranches(false);
            return;
        }

        let cancelled = false;
        setIsDiscoveringDraftBranches(true);

        void fetchBranches(selectedDraftProjectPath, runtimeGit)
            .finally(() => {
                if (!cancelled) {
                    setIsDiscoveringDraftBranches(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [fetchBranches, runtimeGit, selectedDraftProject, selectedDraftProjectBranches?.all, selectedDraftProjectPath, showDraftTargetSelectors]);

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
        });
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
        if (isDiscoveringDraftBranches) {
            return false;
        }
        if (projectRootBranchOption) {
            return true;
        }
        return worktreeBranchOptions.length > 0;
    }, [isDiscoveringDraftBranches, projectRootBranchOption, worktreeBranchOptions.length]);

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
        const imageUrl = getProjectIconImageUrl(
            { id: project.id, iconImage: project.iconImage ?? null },
            {
                themeVariant: currentTheme.metadata.variant,
                iconColor: currentTheme.colors.surface.foreground,
            },
        );
        const ProjectIcon = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
        const iconColor = getProjectIconColor(project.color);

        return (
            <span className="inline-flex min-w-0 items-center gap-1.5">
                {imageUrl ? (
                    <span
                        className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center overflow-hidden rounded-[3px]"
                        style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
                    >
                        <img src={imageUrl} alt="" className="h-full w-full object-contain" draggable={false} />
                    </span>
                ) : ProjectIcon ? (
                    <ProjectIcon className="h-3.5 w-3.5 shrink-0" style={iconColor ? { color: iconColor } : undefined} />
                ) : (
                    <RiFolderLine className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" style={iconColor ? { color: iconColor } : undefined} />
                )}
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
            toast.error('Open a session first');
            return;
        }

        const nextEnabled = !permissionAutoAcceptEnabled;
        setSessionAutoAccept(permissionScopeSessionId, nextEnabled).catch(() => {
            toast.error('Failed to toggle permission auto-accept');
        });
    }, [permissionAutoAcceptEnabled, permissionScopeSessionId, setSessionAutoAccept]);

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
            onSubmit={(e) => { e.preventDefault(); handlePrimaryAction(); }}
            className={cn(
                "relative pt-0 pb-4",
                isDesktopExpanded && 'flex h-full min-h-0 flex-col pt-4',
                isMobile && (isKeyboardOpen ? 'ios-keyboard-safe-area' : 'bottom-safe-area')
            )}
            data-keyboard-avoid="true"
            style={isMobile && inputBarOffset > 0 && !isKeyboardOpen ? { marginBottom: `${inputBarOffset}px` } : undefined}
        >
            <div className={cn('chat-column relative overflow-visible', isDesktopExpanded && 'flex flex-1 min-h-0 flex-col')}>
                <AttachedFilesList />
                <QueuedMessageChips
                    onEditMessage={handleQueuedMessageEdit}
                />
                {hasDrafts && (
                    <div className="pb-2">
                        <div
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border"
                            style={{
                                backgroundColor: currentTheme?.colors?.surface?.elevated,
                                borderColor: currentTheme?.colors?.interactive?.border,
                            }}
                        >
                            <span className="text-xs font-medium text-muted-foreground">Review comments:</span>
                            <span className="text-xs font-semibold" style={{ color: currentTheme?.colors?.status?.info }}>
                                {draftCount}
                            </span>
                        </div>
                    </div>
                )}

                {/* Linked Issue row */}
                {linkedIssue && !isVSCode && (
                    <div className="pb-2 w-full px-1">
                        <button
                            type="button"
                            onClick={() => setIssuePickerOpen(true)}
                            className="flex w-full items-center gap-1.5 text-sm hover:opacity-80 transition-opacity text-left h-5 px-1"
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
                                    <span className="ml-1">by {linkedIssue.author.login}</span>
                                )}
                            </span>
                            <span className="text-foreground truncate">
                                {linkedIssue.title}
                            </span>
                            <span className="flex items-center gap-0.5 flex-shrink-0">
                                <a
                                    href={linkedIssue.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="flex items-center justify-center h-6 w-6 hover:bg-[var(--interactive-hover)] rounded-full transition-colors"
                                    aria-label="Open issue in browser"
                                >
                                    <RiExternalLinkLine className="h-4 w-4 text-muted-foreground" />
                                </a>
                                <span
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setLinkedIssue(null);
                                    }}
                                    className="flex items-center justify-center h-6 w-6 hover:bg-[var(--interactive-hover)] rounded-full transition-colors cursor-pointer"
                                    aria-label="Remove linked issue"
                                >
                                    <RiCloseLine className="h-4 w-4 text-muted-foreground" />
                                </span>
                            </span>
                        </button>
                    </div>
                )}
                {linkedPr && !isVSCode && (
                    <div className="pb-2 w-full px-1">
                        <button
                            type="button"
                            onClick={() => setPrPickerOpen(true)}
                            className="flex w-full items-center gap-1.5 text-sm hover:opacity-80 transition-opacity text-left h-5 px-1"
                        >
                            {linkedPr.author?.avatarUrl && (
                                <img
                                    src={linkedPr.author.avatarUrl}
                                    alt={linkedPr.author.login}
                                    className="h-5 w-5 rounded-full flex-shrink-0"
                                />
                            )}
                            <span className="text-muted-foreground flex-shrink-0">
                                PR #{linkedPr.number}
                                {linkedPr.author && (
                                    <span className="ml-1">by {linkedPr.author.login}</span>
                                )}
                            </span>
                            <span className="text-foreground truncate">
                                {linkedPr.title}
                            </span>
                            <span className="text-muted-foreground flex-shrink-0 typography-meta">
                                {linkedPr.head} → {linkedPr.base}
                            </span>
                            <span className="flex items-center gap-0.5 flex-shrink-0">
                                <a
                                    href={linkedPr.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="flex items-center justify-center h-6 w-6 hover:bg-[var(--interactive-hover)] rounded-full transition-colors"
                                    aria-label="Open pull request in browser"
                                >
                                    <RiExternalLinkLine className="h-4 w-4 text-muted-foreground" />
                                </a>
                                <span
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setLinkedPr(null);
                                    }}
                                    className="flex items-center justify-center h-6 w-6 hover:bg-[var(--interactive-hover)] rounded-full transition-colors cursor-pointer"
                                    aria-label="Remove linked pull request"
                                >
                                    <RiCloseLine className="h-4 w-4 text-muted-foreground" />
                                </span>
                            </span>
                        </button>
                    </div>
                )}
                <MemoStatusRow
                    showAbortStatus={showAbortStatus}
                    showAssistantStatus={false}
                    showTodos
                />
                {showDraftTargetSelectors && selectedDraftProject ? (
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
                                        {selectedDraftBranchLabel ?? 'Branch'}
                                    </SelectValue>
                                </SelectTrigger>
                                <SelectContent fitContent>
                                    {projectRootBranchOption ? (
                                        <SelectGroup>
                                            <SelectLabel>Project root</SelectLabel>
                                            <SelectItem key={projectRootBranchOption.value} value={projectRootBranchOption.value} className="max-w-[24rem] truncate">
                                                {projectRootBranchOption.label}
                                            </SelectItem>
                                        </SelectGroup>
                                    ) : null}
                                    {projectRootBranchOption ? <SelectSeparator /> : null}
                                    <SelectGroup>
                                        <div className="flex items-center justify-between px-2 py-1.5">
                                            <span className="text-muted-foreground typography-meta">Worktrees</span>
                                            <button
                                                type="button"
                                                className="text-muted-foreground typography-meta hover:text-foreground cursor-pointer"
                                                onPointerDown={(e) => { e.stopPropagation(); }}
                                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); void createWorktreeDraft(); }}
                                            >
                                                + New
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
                <div
                    className={cn(
                        "flex flex-col relative overflow-visible",
                        isDesktopExpanded && 'flex-1 min-h-0',
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
                >
                    {isDragging && (
                        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/90 rounded-xl">
                            <div className="text-center">
                                <div className="inline-flex justify-center">
                                    <button
                                        type="button"
                                        className={iconButtonBaseClass}
                                        onClick={() => handlePickLocalFiles()}
                                        title="Attach files"
                                        aria-label="Attach files"
                                    >
                                        <RiAttachment2 className={cn(iconSizeClass, 'text-current')} />
                                    </button>
                                </div>
                                <p className="mt-2 typography-ui-label text-muted-foreground">Drop files here to attach</p>
                            </div>
                        </div>
                    )}

                    {showCommandAutocomplete && (
                        <CommandAutocomplete
                            ref={commandRef}
                            searchQuery={commandQuery}
                            onCommandSelect={handleCommandSelect}
                            showTabs={isMobile}
                            activeTab={autocompleteTab}
                            onTabSelect={handleAutocompleteTabSelect}
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

                    {showFileMention && (

                        <FileMentionAutocomplete
                            ref={mentionRef}
                            searchQuery={mentionQuery}
                            onFileSelect={handleFileSelect}
                            onAgentSelect={handleAgentSelect}
                            showTabs={isMobile}
                            activeTab={autocompleteTab}
                            onTabSelect={handleAutocompleteTabSelect}
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
                    <div className={cn("relative overflow-hidden", isDesktopExpanded && 'flex flex-1 min-h-0 flex-col')}>
                        {highlightedComposerContent && (
                            <div
                                aria-hidden
                                className={cn(
                                    'pointer-events-none absolute inset-0 z-0 whitespace-pre-wrap break-words px-3 rounded-b-none',
                                    isDesktopExpanded
                                        ? 'h-full min-h-0 py-4'
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
                                        className={
                                            part.mentionKind === 'file'
                                                ? 'text-[var(--status-info)]'
                                                : part.mentionKind === 'agent'
                                                    ? 'text-[var(--status-success)]'
                                                    : 'text-foreground'
                                        }
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
                            onPointerDownCapture={handleTextareaPointerDownCapture}
                            onKeyUp={updateAutocompleteOverlayPosition}
                            onClick={updateAutocompleteOverlayPosition}
                            onScroll={(event) => {
                                updateAutocompleteOverlayPosition();
                                const scrollTop = event.currentTarget.scrollTop;
                                if (composerHighlightRef.current) {
                                    composerHighlightRef.current.style.transform = `translateY(-${scrollTop}px)`;
                                }
                            }}
                            onSelect={updateAutocompleteOverlayPosition}
                            placeholder={currentSessionId || newSessionDraftOpen
                                ? inputMode === 'shell'
                                    ? "Enter shell command..."
                                    : "@ for files/agents; / for commands; ! for shell"
                                : "Select or create a session to start chatting"}
                            disabled={!currentSessionId && !newSessionDraftOpen}
                            autoCorrect={isMobile ? "on" : "off"}
                            autoCapitalize={isMobile ? "sentences" : "off"}
                            spellCheck={isMobile || inputSpellcheckEnabled}
                            fillContainer={isDesktopExpanded}
                            outerClassName={cn('ring-0 bg-transparent shadow-none hover:bg-transparent focus-within:ring-0', isDesktopExpanded && 'flex-1 min-h-0')}
                            className={cn(
                                'min-h-[52px] resize-none border-0 px-3 rounded-b-none appearance-none hover:border-transparent bg-transparent relative z-10',
                                isDesktopExpanded
                                    ? 'h-full min-h-0 py-4'
                                    : isMobile
                                        ? 'py-2.5'
                                        : 'pt-4 pb-2',
                                inputMode === 'shell' && 'font-mono',
                                highlightedComposerContent && 'text-transparent caret-[var(--surface-foreground)]',
                            )}
                            style={{
                                flex: isDesktopExpanded ? '1 1 auto' : 'none',
                                height: !isDesktopExpanded && textareaSize ? `${textareaSize.height}px` : undefined,
                                maxHeight: !isDesktopExpanded && textareaSize ? `${textareaSize.maxHeight}px` : undefined,
                                borderTopLeftRadius: chatInputRadius,
                                borderTopRightRadius: chatInputRadius,
                            }}
                            rows={1}
                        />
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
                                    <div className="flex items-center gap-x-1.5">
                                        <ComposerAttachmentControls
                                            isMobile={isMobile}
                                            isVSCode={isVSCode}
                                            footerIconButtonClass={footerIconButtonClass}
                                            iconSizeClass={iconSizeClass}
                                            fileInputRef={fileInputRef}
                                            handleLocalFileSelect={handleLocalFileSelect}
                                            handlePickLocalFiles={handlePickLocalFiles}
                                            handleOpenCommandMenu={handleOpenCommandMenu}
                                            openIssuePicker={openIssuePicker}
                                            openPrPicker={openPrPicker}
                                            onOpenSettings={onOpenSettings}
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
                                        <div className="flex items-center gap-x-1 min-w-0 max-w-[60vw] flex-shrink">
                                            <MemoMobileModelButton onOpenModel={handleOpenMobileControls} className="min-w-0 flex-shrink" />
                                            <MemoMobileAgentButton
                                                onOpenAgentPanel={handleOpenAgentPanel}
                                                onCycleAgent={handleCycleAgent}
                                                className="min-w-0 flex-shrink"
                                            />
                                        </div>
                                        <div className="flex items-center gap-x-1 flex-shrink-0">
                                            <MemoBrowserVoiceButton />
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
                                <MemoModelControls
                                    className="hidden"
                                    mobilePanel={mobileControlsPanel}
                                    onMobilePanelChange={setMobileControlsPanel}
                                    onMobilePanelSelection={handleReturnToUnifiedControls}
                                    onAgentPanelSelection={() => setMobileControlsPanel(null)}
                                />
                                <MemoUnifiedControlsDrawer
                                    open={mobileControlsOpen}
                                    onClose={handleCloseMobileControls}
                                    onOpenModel={() => handleOpenMobilePanel('model')}
                                    onOpenEffort={() => handleOpenMobilePanel('variant')}
                                />
                            </>
                        ) : (
                            <>
                                <div className={cn("flex items-center flex-shrink-0", footerGapClass)}>
                                    <ComposerAttachmentControls
                                        isMobile={isMobile}
                                        isVSCode={isVSCode}
                                        footerIconButtonClass={footerIconButtonClass}
                                        iconSizeClass={iconSizeClass}
                                        fileInputRef={fileInputRef}
                                        handleLocalFileSelect={handleLocalFileSelect}
                                        handlePickLocalFiles={handlePickLocalFiles}
                                        handleOpenCommandMenu={handleOpenCommandMenu}
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
                                    <MemoBrowserVoiceButton />
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

                    {/* Mobile Session Status Bar - above input */}
                    {isMobile && <MobileSessionStatusBar />}
                </div>
            </div>
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
        </>
    );
};

ChatInputComponent.displayName = 'ChatInput';

export const ChatInput = React.memo(ChatInputComponent);

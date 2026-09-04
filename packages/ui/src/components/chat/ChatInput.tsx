import React from 'react';
import { ComposerDictation } from '@/components/dictation/ComposerDictation';
// sessionStore removed — currentSessionId comes from useSessionUIStore
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { createMessageQueueTarget, getMessageQueueKey, useMessageQueueStore, type QueuedContextPart, type QueuedMessage } from '@/stores/messageQueueStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { prepareLocalAttachments, useInputStore, type SyntheticContextPart } from '@/sync/input-store';
import {
    ACCEPTED_ATTACHMENT_EXTENSIONS,
    ATTACHMENT_ACCEPT,
    getUnsupportedAttachmentInputs,
    isDocumentAttachmentFilename,
    type AttachmentInputModality,
} from '@/sync/attachment-files';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import * as sessionActions from '@/sync/session-actions';
import { buildLinkedIssue, buildLinkedLinearIssue } from '@/lib/linkedIssues';
import { useUserMessageHistory } from "@/sync/sync-context";
import { getInlineCommentDraftKey, useInlineCommentDraftStore, type InlineCommentDraft, type InlineCommentDraftTarget } from '@/stores/useInlineCommentDraftStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { startReviewFlow } from '@/lib/reviewFlow';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
    createChatDraftIdentity,
    readChatDraft,
    writeChatDraft,
    type ChatDraftIdentity,
    type ChatDraftSnapshot,
} from '@/lib/chatDraftPersistence';
import { ReviewFlowDialog, type ReviewFlowExecution } from '@/components/session/ReviewFlowDialog';
import { BtwPanel } from './btw/BtwPanel';
import { useBtwPanelState } from './btw/useBtwPanelState';
import { wasPromotedBtwSession } from '@/lib/sessionBtwMetadata';
import { buildBtwSyntheticTexts, destroyBtwSession, startBtwSession, type BtwSessionRef } from '@/lib/btw';
import { AttachedFilesList, AttachedVSCodeFileChips, ActiveEditorFileSuggestion } from './FileAttachment';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import type { ToolPopupContent } from './message/types';
import { QueuedMessageChips } from './QueuedMessageChips';
import { AutoReviewBanner } from './AutoReviewBanner';
import type { FileMentionHandle } from './FileMentionAutocomplete';
import type { CommandAutocompleteHandle, CommandInfo } from './CommandAutocomplete';
import type { SkillAutocompleteHandle } from './SkillAutocomplete';
import type { SnippetAutocompleteHandle } from './SnippetAutocomplete';
import { cn } from "@/lib/utils";
import { ModelControls } from './ModelControls';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { CONTEXT_METADATA_KEY, draftFromContextPayload } from '@/lib/messages/contextParts';
import { ComposerStatusBar } from './ComposerStatusBar';
import { PendingChangesBar } from './PendingChangesBar';
import { useChatColumnSession } from './chatColumnSession';
import { useChatSurfaceMode } from './useChatSurfaceMode';
import { MobileAgentButton } from './MobileAgentButton';
import { MobileModelButton } from './MobileModelButton';
import { useCurrentSessionActivity, useSessionActivity } from '@/hooks/useSessionActivity';
import { toast } from '@/components/ui';
// useMessageStore removed — messages now come from sync system
import { isVSCodeRuntime } from '@/lib/desktop';
import { useTabletLayout } from '@/lib/device';
import { useHardwareKeyboard } from '@/lib/hardwareKeyboard';
import { isIMECompositionEvent } from '@/lib/ime';
import { getCycledPrimaryAgentName, type MobileControlsPanel } from './mobileControlsUtils';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { GitHubIssuePickerDialog } from '@/components/session/GitHubIssuePickerDialog';
import { GitHubPrPickerDialog } from '@/components/session/GitHubPrPickerDialog';
import { LinearIssuePickerDialog } from '@/components/session/LinearIssuePickerDialog';
import { Icon } from "@/components/icon/Icon";
import { DraftPresetChips } from './DraftPresetChips';
import { useChatSearchDirectory } from '@/hooks/useChatSearchDirectory';
import { opencodeClient } from '@/lib/opencode/client';
import { useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { selectSkillsForDirectory, useSkillsStore } from '@/stores/useSkillsStore';
import { selectCommandsForDirectory, useCommandsStore } from '@/stores/useCommandsStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { usePermissionStore } from '@/stores/permissionStore';
import { togglePermissionAutoAccept } from './permissionAutoAccept';
import { useKeybind } from '@/hooks/useKeybind';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { extractGitChangedFiles } from './changedFiles';
import { useI18n } from '@/lib/i18n';
import { sessionEvents } from '@/lib/sessionEvents';
import { fetchResponseStyleInstruction } from '@/lib/responseStyle';
import { wrapSystemReminder } from '@/lib/systemReminder';
import { getSyncMessages } from '@/sync/sync-refs';
import { eventMatchesShortcut, getEffectiveShortcutCombo, normalizeCombo } from '@/lib/shortcuts';
import {
    assignImageAttachmentFilenames,
    buildAttachmentCitationText,
    nextPastedContextFilename,
} from './attachmentCitations';
import {
    createPastedContextFile,
    isLargePlainTextPaste,
} from './composer/largeTextPaste';
import {
    LARGE_TEXT_PASTE_TOAST_CLASSNAME,
    beginLargeTextPasteOffer,
    resolveLargeTextPasteOffer,
} from './composer/largeTextPasteOffer';
import type { LargeTextPasteBehavior } from '@/stores/useUIStore';
import type { FileMentionAutocompleteInputSource } from './fileMentionAutocompleteState';
import {
    classifyMention,
    scanMentions,
} from './composer/language/mentions';
import { collectKnownTokenNames } from './composer/language/prefixTokens';
import { resolveAutocompleteTrigger, type AutocompleteKind } from './composer/language/triggers';
import { type ComposerLanguageContext } from './composer/language/tokenize';
import {
    ComposerEditor,
    type ComposerChange,
    type ComposerEditorHandle,
} from './composer/editor/ComposerEditor';
import { createComposerEditorViewStore } from './composer/editor/viewStore';
import { composerAutoCorrect } from './composer/editor/autocorrect';
import {
    appendInlineText,
    appendWithLineBreaks,
    buildImagePasteInsertion,
    getMarkdownAutoPairEdit,
    shouldWrapSelectionAsLink,
    withInlineInsertionBoundaries,
} from './composer/text';
import {
    collectDroppedFileUris,
    collectDroppedFiles,
    hasDraggedFiles,
} from './composer/attachments/dataTransfer';
import {
    normalizeDroppedPath,
    normalizePath,
    toProjectRelativeMentionPath,
    toServerFileUrl,
} from './composer/attachments/filePaths';
import { buildComposerContext, buildOutgoingMessage } from './composer/submit/buildOutgoingMessage';
import {
    buildCommandVariables,
    canRunCommand,
    findMagicPromptCommand,
    parseSlashCommand,
} from './composer/submit/slashCommands';
import { useAutocompletePosition } from './composer/state/useAutocompletePosition';
import { useMessageHistory } from './composer/state/useMessageHistory';
import { useComposerDraft } from './composer/state/useComposerDraft';
import { useDraftTarget } from './composer/state/useDraftTarget';
import { useMobileComposerShell } from './composer/state/useMobileComposerShell';
import { useMobileViewportPin } from './composer/state/useMobileViewportPin';
import {
    DraftTargetSelectors,
    MobileDraftTargetSheets,
    MobileDraftTargetTriggers,
} from './composer/ui/DraftTargetSelectors';
import { ComposerAutocompletePopups } from './composer/ui/ComposerAutocompletePopups';
import { ComposerFooter } from './composer/ui/ComposerFooter';
import { MobilePillComposer } from './composer/ui/MobilePillComposer';
import { ComposerContextChips } from './composer/ui/ComposerContextChips';
import { LinkedReferenceRow } from './composer/ui/LinkedReferenceRow';
import { RevertedMessageDock } from './composer/ui/RevertedMessageDock';
import { SessionSuggestionChip } from '@/components/chat/SessionSuggestionChip';
import { SessionGoalRow } from '@/components/chat/SessionGoalRow';

// Lazy like in ChatMessage: a static import would pull the @pierre/diffs and
// Shiki stacks into the eager startup graph for a dialog opened on demand.
const ToolOutputDialog = lazyWithChunkRecovery(() => import('./message/ToolOutputDialog'));

const MAX_VISIBLE_COMPOSER_LINES = 8;
/**
 * Mobile grows the composer with content instead of offering a fullscreen
 * gesture — the old swipe-up handle bought barely a line of extra height.
 * The real ceiling is measured: the editor may grow until the composer fills
 * its screen container (marked data-composer-bound in ChatContainer), with
 * the chrome around the editor read from the DOM. The line cap only stops
 * absurdly tall editors on tablets.
 */
const MAX_MOBILE_COMPOSER_LINES = 16;
/**
 * Breathing room between the fully grown composer and the top of its screen
 * container: without it the composer's border lands exactly on the header's
 * bottom edge on the chat screen. A visual gap by design, not an estimate.
 */
const MOBILE_COMPOSER_BOUND_GAP_PX = 4;
const EMPTY_QUEUE: QueuedMessage[] = [];
const COMPACT_CHAT_PLACEHOLDER_MAX_WIDTH = 560;
const renameFileForAttachmentCitation = (file: File, filename: string): File => {
    if (file.name === filename) {
        return file;
    }

    return new File([file], filename, {
        type: file.type,
        lastModified: file.lastModified,
    });
};

const getFileMentionInputSourceForInsertedText = (insertedText: string): FileMentionAutocompleteInputSource => (
    insertedText.includes('@') ? 'paste' : 'manual'
);

/**
 * Skills the user named inline with `/name`. Matched against the registry's
 * exact casing, since the name is echoed back to the model as a skill to load.
 */
const collectInlineSkillMentions = (text: string, skillNames: Set<string>): string[] =>
    collectKnownTokenNames(text, '/', skillNames, 'exact');

const buildSkillMentionInstruction = (skillNames: string[]): string | null => {
    if (skillNames.length === 0) return null;
    const formatted = skillNames.map((name) => `/${name}`).join(', ');
    return `The user explicitly mentioned these skills in their message: ${formatted}. Use the corresponding skill tool when it is relevant to accomplishing the user's request.`;
};

type LinkedReferenceAuthor = { login: string; avatarUrl?: string };
type LinkedGitHubIssue = { number: number; title: string; url: string; contextText: string; author?: LinkedReferenceAuthor };
type LinkedGitHubPr = {
    number: number;
    title: string;
    url: string;
    head: string;
    base: string;
    includeDiff: boolean;
    instructionsText: string;
    contextText: string;
    author?: LinkedReferenceAuthor;
};
type LinkedLinearIssueRef = { identifier: string; title: string; url: string; contextText: string; author?: LinkedReferenceAuthor };
type LinkedReferences = { issue: LinkedGitHubIssue | null; pr: LinkedGitHubPr | null; linear: LinkedLinearIssueRef | null };

/**
 * Record what a session was pointed at, so the work-status panel can show it
 * as a context source long after the message scrolled away. A snapshot only —
 * never re-fetched, never authoritative. Failures are swallowed: the message
 * went out (or was queued), and a missing bookkeeping entry must not surface
 * as an error.
 */
const recordLinkedReferences = (
    sessionId: string,
    directory: Parameters<typeof sessionActions.setLinkedIssue>[1],
    refs: LinkedReferences,
) => {
    const attachedThread = refs.issue
        ? { attachment: refs.issue, kind: 'issue' as const }
        : refs.pr
            ? { attachment: refs.pr, kind: 'pull' as const }
            : null;
    if (attachedThread) {
        void sessionActions.setLinkedIssue(
            sessionId,
            directory,
            buildLinkedIssue({
                url: attachedThread.attachment.url,
                number: attachedThread.attachment.number,
                title: attachedThread.attachment.title,
                kind: attachedThread.kind,
                author: attachedThread.attachment.author,
                linkedAt: Date.now(),
            }),
            true,
        ).catch(() => undefined);
    }
    if (refs.linear) {
        void sessionActions.setLinkedIssue(
            sessionId,
            directory,
            buildLinkedLinearIssue({
                identifier: refs.linear.identifier,
                title: refs.linear.title,
                url: refs.linear.url,
                author: refs.linear.author,
                linkedAt: Date.now(),
            }),
            true,
        ).catch(() => undefined);
    }
};

const hasUserMessages = (sessionId: string, directory?: string) => {
    return getSyncMessages(sessionId, directory).some((message) => message.role === 'user');
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

const MemoModelControls = React.memo(ModelControls);
const MemoComposerDictation = React.memo(ComposerDictation);
const MemoMobileAgentButton = React.memo(MobileAgentButton);
const MemoMobileModelButton = React.memo(MobileModelButton);
const MemoComposerStatusBar = React.memo(ComposerStatusBar);

interface ChatInputProps {
    onOpenSettings?: () => void;
    scrollToBottom?: () => void;
    // Queued sends do not create a user row (the queue delivers later), so
    // the anchor-arming scrollToBottom is wrong for them; this returns the
    // viewport to the live edge instead.
    scrollToLatest?: () => void;
    active?: boolean;
    draftPresentationExiting?: boolean;
}

const resolveChatDraftIdentity = (sessionId: string | null): ChatDraftIdentity | null => {
    const sessionState = useSessionUIStore.getState();
    const newSessionDirectory = sessionState.newSessionDraft?.open
        ? sessionState.newSessionDraft.bootstrapPendingDirectory ?? sessionState.newSessionDraft.directoryOverride
        : null;
    const directory = sessionId
        ? sessionState.getDirectoryForSession(sessionId) ?? sessionState.currentSessionDirectory
        : newSessionDirectory ?? useDirectoryStore.getState().currentDirectory;
    return createChatDraftIdentity(getRuntimeKey(), directory, sessionId);
};

const ChatInputComponent: React.FC<ChatInputProps> = ({
    onOpenSettings,
    scrollToBottom,
    scrollToLatest,
    active = true,
    draftPresentationExiting = false,
}) => {
    const { t } = useI18n();
    // Track if we restored a draft on mount (for text selection)
    const initialDraftRef = React.useRef<string | null>(null);
    const initialDraftIdentityRef = React.useRef<ChatDraftIdentity | null>(null);
    const initialDraftSnapshotRef = React.useRef<ChatDraftSnapshot>({ text: '', confirmedMentions: new Set() });
    const [message, setMessage] = React.useState(() => {
        const sessionId = useSessionUIStore.getState().currentSessionId;
        const identity = resolveChatDraftIdentity(sessionId);
        const snapshot = readChatDraft(identity);
        initialDraftIdentityRef.current = identity;
        initialDraftSnapshotRef.current = snapshot;
        if (snapshot.text) {
            initialDraftRef.current = snapshot.text;
        }
        return snapshot.text;
    });
    const confirmedMentionsRef = React.useRef<Set<string>>(initialDraftSnapshotRef.current.confirmedMentions);
    const [inputMode, setInputMode] = React.useState<'normal' | 'shell'>('normal');
    const [isDragging, setIsDragging] = React.useState(false);
    const [isInternalDrag, setIsInternalDrag] = React.useState(false);
    // At most one picker is open at a time; the prompt language decides which.
    const [openAutocomplete, setOpenAutocomplete] = React.useState<AutocompleteKind | null>(null);
    const [autocompleteQuery, setAutocompleteQuery] = React.useState('');
    const closeAutocomplete = React.useCallback(() => setOpenAutocomplete(null), []);
    const [mobileControlsPanel, setMobileControlsPanel] = React.useState<MobileControlsPanel>(null);
    const [mobileAttachMenuOpen, setMobileAttachMenuOpen] = React.useState(false);
    const [mobileDraftPicker, setMobileDraftPicker] = React.useState<'project' | 'branch' | null>(null);
    const [mobileDraftPickerQuery, setMobileDraftPickerQuery] = React.useState('');
    // Message history navigation state (up/down arrow to recall previous messages)
    const composerRef = React.useRef<ComposerEditorHandle>(null);
    // The mobile composer swaps between the collapsed pill and the full
    // composer, which unmounts the editor. Building a CodeMirror view is far
    // from free, and it would happen inside the tap that expands the pill —
    // before the browser may paint the swap. The store keeps one view alive for
    // as long as the composer itself is mounted.
    const composerViewStore = React.useRef(createComposerEditorViewStore()).current;
    React.useEffect(() => () => {
        composerViewStore.view?.destroy();
        composerViewStore.view = null;
    }, [composerViewStore]);
    const composerFormRef = React.useRef<HTMLFormElement | null>(null);
    const cursorPosRef = React.useRef(0);
    const dropZoneRef = React.useRef<HTMLDivElement>(null);
    const dragEnterCountRef = React.useRef(0);
    const suppressNextFileDropTextInsertRef = React.useRef(false);
    const suppressNextFileDropTextInsertTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const suppressNextFileMentionPasteRef = React.useRef(false);
    const suppressNextFileMentionPasteTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const shellTriggerNormalizationRef = React.useRef(false);
    const pendingDroppedAbsolutePathsRef = React.useRef<string[]>([]);
    const canAcceptDropRef = React.useRef(false);
    const mentionRef = React.useRef<FileMentionHandle>(null);
    const commandRef = React.useRef<CommandAutocompleteHandle>(null);
    const skillRef = React.useRef<SkillAutocompleteHandle>(null);
    const snippetRef = React.useRef<SnippetAutocompleteHandle>(null);
    // Ref to track current message value without triggering re-renders in effects
    const messageRef = React.useRef(message);
    const currentChatDraftIdentityRef = React.useRef<ChatDraftIdentity | null>(initialDraftIdentityRef.current);
    const pendingPastedAttachmentFilenamesRef = React.useRef<Set<string>>(new Set());
    const largeTextPasteToastIdRef = React.useRef<string | number | null>(null);
    const largeTextPasteOfferIdRef = React.useRef(0);

    // TODO: port sendMessage to session-actions (complex — creates sessions, handles attachments, etc.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendMessage = React.useRef((...args: any[]) =>
        Promise.resolve((useSessionUIStore.getState().sendMessage as (...a: unknown[]) => unknown)(...args)),
    ).current;
    // Inside the chat column the composer follows the session the timeline is
    // showing (see chatColumnSession.ts); elsewhere it follows the live one.
    const liveSessionId = useSessionUIStore((s) => s.currentSessionId);
    const chatColumnSession = useChatColumnSession();
    const currentSessionId = chatColumnSession ? chatColumnSession.sessionId : liveSessionId;
    const fallbackDirectory = useDirectoryStore((s) => s.currentDirectory);
    const liveEffectiveDirectory = useEffectiveDirectory();
    const currentDirectory = (chatColumnSession?.sessionId ? chatColumnSession.directory : null)
        ?? liveEffectiveDirectory
        ?? fallbackDirectory;
    const currentSessionDirectoryForSync = useSessionUIStore(
        React.useCallback((s) => currentSessionId ? s.getDirectoryForSession(currentSessionId) : null, [currentSessionId]),
    );
    // btw mode: the CURRENT session's metadata links an active btw fork and
    // the panel is expanded, so this composer's sends route to the fork
    // instead of the main session. Collapsed keeps the fork alive (chip stays
    // visible) while the composer talks to the main session again.
    const btwPanel = useBtwPanelState(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory ?? undefined);
    const btwSessionId = btwPanel.btwSessionId;
    const btwDirectory = btwPanel.btwDirectory;
    const btwSessionRef = React.useMemo<BtwSessionRef | null>(
        () => (currentSessionId && btwSessionId && btwDirectory
            ? { parentSessionId: currentSessionId, btwSessionId, directory: btwDirectory }
            : null),
        [btwDirectory, btwSessionId, currentSessionId],
    );
    const isBtwActive = Boolean(btwSessionRef) && !btwPanel.collapsed;
    // A session promoted out of `/btw` keeps the boundary instructions in its
    // transcript — there is no way to delete a message part — so it has to say
    // they no longer apply.
    const isPromotedBtwSession = wasPromotedBtwSession(btwPanel.parentSession);
    const activeRuntimeKey = getRuntimeKey();
    const chatDraftIdentity = React.useMemo(
        () => createChatDraftIdentity(
            activeRuntimeKey,
            currentSessionDirectoryForSync ?? currentDirectory,
            currentSessionId,
        ),
        [activeRuntimeKey, currentDirectory, currentSessionDirectoryForSync, currentSessionId],
    );
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const newSessionDraftOpen = Boolean(newSessionDraft?.open);
    const draftPermissionAutoAcceptEnabled = useSessionUIStore((s) => (
        s.newSessionDraft?.open ? s.newSessionDraft.permissionAutoAcceptEnabled === true : false
    ));
    const setNewSessionDraftTarget = useSessionUIStore((s) => s.setNewSessionDraftTarget);
    const setDraftPermissionAutoAcceptEnabled = useSessionUIStore((s) => s.setDraftPermissionAutoAcceptEnabled);
    const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
    const prepareChatDraftDirectory = useSessionUIStore((s) => s.prepareChatDraftDirectory);
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

    React.useEffect(() => {
        if (!newSessionDraftOpen || newSessionDraft.target !== 'chat' || message.trim().length === 0) return;
        void prepareChatDraftDirectory();
    }, [message, newSessionDraft.target, newSessionDraftOpen, prepareChatDraftDirectory]);
    const consumePendingSyntheticParts = useInputStore((s) => s.consumePendingSyntheticParts);
    const acknowledgeSessionAbort = useSessionUIStore((s) => s.acknowledgeSessionAbort);
    const abortCurrentOperation = React.useCallback(
        (sessionIdOverride?: string) => sessionActions.abortCurrentOperation(sessionIdOverride ?? currentSessionId ?? ''),
        [currentSessionId],
    );
    const currentManagementSessionId = currentSessionId;
    const [reviewDialogOpen, setReviewDialogOpen] = React.useState(false);
    const [reviewFlowSubmitting, setReviewFlowSubmitting] = React.useState(false);

    const currentProviderId = useConfigStore((state) => state.currentProviderId);
    const currentModelId = useConfigStore((state) => state.currentModelId);
    const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
    // Subscribe to both sources read by getModelMetadata so async metadata and provider updates are observed.
    useConfigStore((state) => state.modelsMetadata);
    useConfigStore((state) => state.providers);
    const currentModelMetadata = currentProviderId && currentModelId
        ? getModelMetadata(currentProviderId, currentModelId)
        : undefined;
    const currentVariant = useConfigStore((state) => state.currentVariant);
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const setAgent = useConfigStore((state) => state.setAgent);
    const getVisibleAgents = useConfigStore((state) => state.getVisibleAgents);
    const agents = getVisibleAgents();
    const isMobile = useUIStore((state) => state.isMobile);
    const hasHardwareKeyboard = useHardwareKeyboard();
    const { enabled: isTabletLayout } = useTabletLayout();
    const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);
    const inputBarOffset = useUIStore((state) => state.inputBarOffset);
    const persistChatDraft = useUIStore((state) => state.persistChatDraft);
    const inputSpellcheckEnabled = useUIStore((state) => state.inputSpellcheckEnabled);
    const largeTextPasteBehavior = useUIStore((state) => state.largeTextPasteBehavior);
    const isExpandedInput = useUIStore((state) => state.isExpandedInput);
    const setExpandedInput = useUIStore((state) => state.setExpandedInput);
    const setTimelineDialogOpen = useUIStore((state) => state.setTimelineDialogOpen);
    const { git: runtimeGit, vscode: vscodeApi, linear: runtimeLinear } = useRuntimeAPIs();
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
    const clearGitDiffCache = useGitStore((state) => state.clearDiffCache);
    const setSessionAutoAccept = usePermissionStore((state) => state.setSessionAutoAccept);
    const [isNarrowComposer, setIsNarrowComposer] = React.useState(false);
    const [attachmentPreview, setAttachmentPreview] = React.useState<ToolPopupContent>({
        open: false,
        title: '',
        content: '',
    });
    // Mount the lazy preview dialog only after its first open; rendering it
    // closed would fetch the ToolOutputDialog chunk (with the @pierre/diffs
    // stack) on the draft screen before any preview is requested.
    const [attachmentPreviewMounted, setAttachmentPreviewMounted] = React.useState(false);
    React.useEffect(() => {
        if (attachmentPreview.open) {
            setAttachmentPreviewMounted(true);
        }
    }, [attachmentPreview.open]);
    const attachmentCompatibilityRef = React.useRef({
        modelKey: `${currentProviderId ?? ''}/${currentModelId ?? ''}`,
        modalitySignature: currentModelMetadata?.modalities?.input?.slice().sort().join(',') ?? null,
        attachmentIds: new Set<string>(),
    });

    React.useEffect(() => {
        const modelKey = `${currentProviderId ?? ''}/${currentModelId ?? ''}`;
        const inputModalities = currentModelMetadata?.modalities?.input;
        const modalitySignature = inputModalities?.slice().sort().join(',') ?? null;
        const previous = attachmentCompatibilityRef.current;
        const modelChanged = previous.modelKey !== modelKey;
        const metadataBecameAvailable = previous.modalitySignature === null && modalitySignature !== null;
        const filesToCheck = modelChanged || metadataBecameAvailable
            ? attachedFiles
            : attachedFiles.filter((file) => !previous.attachmentIds.has(file.id));

        attachmentCompatibilityRef.current = {
            modelKey,
            modalitySignature,
            attachmentIds: new Set(attachedFiles.map((file) => file.id)),
        };

        if (!inputModalities || filesToCheck.length === 0) return;

        const incompatibleFiles = getUnsupportedAttachmentInputs(filesToCheck, inputModalities);
        if (incompatibleFiles.length === 0) return;

        const unsupportedModalities = Array.from(new Set(incompatibleFiles.map(({ modality }) => modality)));
        const modalityLabels: Record<AttachmentInputModality, string> = {
            text: t('chat.modelControls.modality.text'),
            image: t('chat.modelControls.modality.image'),
            pdf: t('chat.modelControls.modality.pdf'),
            audio: t('chat.modelControls.modality.audio'),
            video: t('chat.modelControls.modality.video'),
        };
        const filenames = incompatibleFiles.map(({ attachment }) => attachment.filename);
        const fileSummary = filenames.length > 3
            ? `${filenames.slice(0, 3).join(', ')} (+${filenames.length - 3})`
            : filenames.join(', ');

        toast.warning(t('chat.chatInput.toast.unsupportedAttachmentModalities', {
            model: currentModelMetadata.name ?? currentModelId ?? '',
            modalities: unsupportedModalities.map((modality) => modalityLabels[modality]).join(', '),
            files: fileSummary,
        }), { id: `attachment-modalities:${modelKey}` });
    }, [attachedFiles, currentModelId, currentModelMetadata, currentProviderId, t]);

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
            if (hint.paths?.length) {
                clearGitDiffCache(currentDirectory, hint.paths);
            }
            void fetchGitStatus(currentDirectory, runtimeGit, { silent: true });
        });
    }, [clearGitDiffCache, currentDirectory, runtimeGit, fetchGitStatus]);

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

    const knownAgentNames = React.useMemo(
        () => new Set(agents.map((agent) => agent.name.toLowerCase())),
        [agents]
    );
    const knownAgentNamesRef = React.useRef(knownAgentNames);
    knownAgentNamesRef.current = knownAgentNames;

    // Known slash-invocations (commands + skills + built-ins) used to highlight
    // matching /tokens in the composer, the same way confirmed @files are.
    const availableCommands = useCommandsStore((s) => selectCommandsForDirectory(s, currentDirectory));
    const availableSkills = useSkillsStore((s) => selectSkillsForDirectory(s, currentDirectory));
    const knownSlashNames = React.useMemo(() => {
        const names = new Set<string>([
            'init', 'review', 'undo', 'redo', 'timeline', 'compact', 'btw', 'summary', 'workspace-review', 'plan-feature', 'craft-goal', 'schedule-task', 'catch-up', 'debug', 'weigh', 'explore',
        ]);
        if (!isMobile && !isVSCodeRuntime()) names.add('handoff-review');
        for (const command of availableCommands) names.add(command.name.toLowerCase());
        for (const skill of availableSkills) names.add(skill.name.toLowerCase());
        return names;
    }, [availableCommands, availableSkills, isMobile]);

    const availableSnippets = useSnippetsStore((s) => s.snippets);
    const knownSnippetTriggers = React.useMemo(() => {
        const triggers = new Set<string>();
        for (const snippet of availableSnippets) {
            triggers.add(snippet.name.toLowerCase());
            for (const alias of snippet.aliases ?? []) triggers.add(alias.toLowerCase());
        }
        return triggers;
    }, [availableSnippets]);

    const attachmentFilenames = React.useMemo(
        () => attachedFiles.map((file) => file.filename),
        [attachedFiles],
    );

    /**
     * Everything the prompt language needs to resolve references. Rebuilt only
     * when a registry changes, so typing does not churn the tokenizer input.
     */
    const languageContext = React.useMemo<ComposerLanguageContext>(() => ({
        inputMode,
        knownAgentNames,
        confirmedMentions: confirmedMentionsRef.current,
        knownSlashNames,
        knownSnippetTriggers,
        attachmentFilenames,
    }), [attachmentFilenames, inputMode, knownAgentNames, knownSlashNames, knownSnippetTriggers]);

    const sanitizeAttachmentsForSend = React.useCallback(
        (files: readonly AttachedFile[] | undefined): AttachedFile[] => [...(files ?? [])]
            .map((file) => ({
                ...file,
                dataUrl: file.source === 'server' && file.serverPath
                    ? toServerFileUrl(file.serverPath)
                    : file.dataUrl,
            })),
        [],
    );

    const resolveInlineFileMention = React.useCallback((mentionPath: string): { serverPath: string; filename: string } | null => {
        const kind = classifyMention(mentionPath, {
            knownAgentNames: knownAgentNamesRef.current,
            confirmedMentions: confirmedMentionsRef.current,
        });
        if (kind !== 'file') return null;

        const normalizedMentionPath = mentionPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
        if (!normalizedMentionPath) return null;

        const clientDirectory = opencodeClient.getDirectory() || '';
        const root = (chatSearchDirectory || clientDirectory).replace(/\\/g, '/').replace(/\/+$/, '');
        let serverPath: string | null = null;
        if (mentionPath.startsWith('/')) {
            serverPath = mentionPath.replace(/\\/g, '/');
        } else if (root) {
            serverPath = `${root}/${normalizedMentionPath}`;
        }
        if (!serverPath) return null;

        return {
            serverPath: serverPath.replace(/\/+/g, '/'),
            filename: normalizedMentionPath.split('/').filter(Boolean).pop() || normalizedMentionPath,
        };
    }, [chatSearchDirectory]);

    const extractInlineFileMentions = React.useCallback((
        rawText: string,
        preparedDocumentMentions?: ReadonlyMap<string, AttachedFile[]>,
    ) => {
        if (!rawText || !rawText.includes('@')) {
            return { sanitizedText: rawText, attachments: [] };
        }

        const seenPaths = new Set<string>();
        const attachments: AttachedFile[] = [];

        for (const token of scanMentions(rawText)) {
            const mention = resolveInlineFileMention(token.name);
            if (!mention || seenPaths.has(mention.serverPath)) continue;
            seenPaths.add(mention.serverPath);

            const prepared = preparedDocumentMentions?.get(mention.serverPath);
            if (prepared) {
                attachments.push(...prepared);
                continue;
            }
            attachments.push({
                id: `inline-server-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                file: new File([], mention.filename, { type: 'text/plain' }),
                filename: mention.filename,
                mimeType: 'text/plain',
                size: 0,
                dataUrl: toServerFileUrl(mention.serverPath),
                source: 'server',
                serverPath: mention.serverPath,
            });
        }

        return {
            sanitizedText: rawText,
            attachments,
        };
    }, [resolveInlineFileMention]);

    type DocumentMentionPreparation =
        | { status: 'ready'; prepared: Map<string, AttachedFile[]> }
        | { status: 'failed'; filename: string }
        | { status: 'runtime-changed' };

    /**
     * Document mentions (`@notes.pdf`) are sent as converted attachments. Their
     * sources are fetched up front — by the send, or by queueing, since the
     * server that later delivers a queued message cannot read them.
     */
    const prepareDocumentMentions = React.useCallback(async (
        texts: readonly string[],
        reservedFilenames: Set<string>,
        runtimeKey: string,
    ): Promise<DocumentMentionPreparation> => {
        const prepared = new Map<string, AttachedFile[]>();
        for (const rawText of texts) {
            for (const token of scanMentions(rawText)) {
                const mention = resolveInlineFileMention(token.name);
                if (
                    !mention
                    || !isDocumentAttachmentFilename(mention.filename)
                    || prepared.has(mention.serverPath)
                ) {
                    continue;
                }
                try {
                    const response = await runtimeFetch('/api/fs/raw', { query: { path: mention.serverPath } });
                    if (!response.ok) throw new Error(`Failed to read ${mention.filename}`);
                    const sourceBlob = await response.blob();
                    if (getRuntimeKey() !== runtimeKey) return { status: 'runtime-changed' };
                    const source = new File([sourceBlob], mention.filename);
                    const converted = await prepareLocalAttachments(source, reservedFilenames);
                    if (!converted || converted.length === 0) throw new Error(`Failed to prepare ${mention.filename}`);
                    if (getRuntimeKey() !== runtimeKey) return { status: 'runtime-changed' };
                    prepared.set(mention.serverPath, converted);
                    for (const attachment of converted) reservedFilenames.add(attachment.filename);
                } catch {
                    if (getRuntimeKey() !== runtimeKey) return { status: 'runtime-changed' };
                    return { status: 'failed', filename: mention.filename };
                }
            }
        }
        return { status: 'ready', prepared };
    }, [resolveInlineFileMention]);
    const prevWasAbortedRef = React.useRef(false);

    // Issue linking state
    const [issuePickerOpen, setIssuePickerOpen] = React.useState(false);
    const [prPickerOpen, setPrPickerOpen] = React.useState(false);
    const [linearPickerOpen, setLinearPickerOpen] = React.useState(false);
    const [linkedIssue, setLinkedIssue] = React.useState<LinkedGitHubIssue | null>(null);
    const [linkedPr, setLinkedPr] = React.useState<LinkedGitHubPr | null>(null);
    const [linkedLinearIssue, setLinkedLinearIssue] = React.useState<LinkedLinearIssueRef | null>(null);

    // Message queue
    const messageQueueTarget = currentSessionId
        ? createMessageQueueTarget(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory)
        : null;
    const messageQueueKey = messageQueueTarget ? getMessageQueueKey(messageQueueTarget) : null;
    const followUpBehavior = useMessageQueueStore((state) => state.followUpBehavior);
    const queuedMessages = useMessageQueueStore(
        React.useCallback(
            (state) => {
                if (!messageQueueKey) return EMPTY_QUEUE;
                return state.queuedMessages[messageQueueKey] ?? EMPTY_QUEUE;
            },
            [messageQueueKey]
        )
    );
    const addToQueue = useMessageQueueStore((state) => state.addToQueue);
    const takeForSend = useMessageQueueStore((state) => state.takeForSend);

    // Inline comment drafts
    const inlineDraftSessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : '');
    const inlineDraftDirectory = currentSessionDirectoryForSync ?? currentDirectory;
    const inlineDraftTarget = React.useMemo<InlineCommentDraftTarget | null>(
        () => inlineDraftSessionKey && inlineDraftDirectory
            ? { directory: inlineDraftDirectory, sessionKey: inlineDraftSessionKey }
            : null,
        [inlineDraftDirectory, inlineDraftSessionKey],
    );
    const inlineDraftKey = inlineDraftTarget
        ? getInlineCommentDraftKey(activeRuntimeKey, inlineDraftTarget.directory, inlineDraftTarget.sessionKey)
        : null;
    const draftCount = useInlineCommentDraftStore(
        React.useCallback(
            (state) => inlineDraftKey ? (state.drafts[inlineDraftKey] ?? []).length : 0,
            [inlineDraftKey]
        )
    );
    const consumeDrafts = useInlineCommentDraftStore((state) => state.consumeDrafts);
    const hasDrafts = draftCount > 0;

    // User message history for up/down arrow navigation.
    // Keep this on a narrow hook instead of full session message records.
    const messageHistory = useMessageHistory(useUserMessageHistory(currentSessionId ?? ""));

    // Keep messageRef in sync with message state
    React.useEffect(() => {
        messageRef.current = message;
    }, [message]);

    React.useEffect(() => {
        currentChatDraftIdentityRef.current = chatDraftIdentity;
    }, [chatDraftIdentity]);

    // Draft persistence: identity switching, debounced writes and the
    // flush-on-hide edges live in the hook.
    const { persistNow: persistDraftImmediately } = useComposerDraft({
        message,
        messageRef,
        setMessage,
        confirmedMentionsRef,
        identity: chatDraftIdentity,
        persistEnabled: persistChatDraft,
        initialDraft: {
            text: initialDraftRef.current ?? '',
            identity: initialDraftIdentityRef.current,
        },
        onIdentityChange: () => setInputMode('normal'),
        onDraftRestored: () => composerRef.current?.selectAll(),
    });

    // Focus textarea when new session draft is opened
    const prevNewSessionDraftOpenRef = React.useRef(newSessionDraftOpen);
    React.useEffect(() => {
        if (!prevNewSessionDraftOpenRef.current && newSessionDraftOpen) {
            // New session draft just opened - focus the textarea
            requestAnimationFrame(() => {
                if (isMobile) {
                    // On mobile, use preventScroll to avoid viewport jumping
                    composerRef.current?.focus({ preventScroll: true });
                } else {
                    composerRef.current?.focus();
                }
            });
        }
        prevNewSessionDraftOpenRef.current = newSessionDraftOpen;
    }, [newSessionDraftOpen, isMobile]);

    // Session activity for queue availability and controls. In btw mode the
    // composer controls the temporary fork, so the stop button and send-button
    // state follow the FORK's activity; the queue affordance stays tied to the
    // main session (queued messages always belong to the main chat).
    const { phase: currentSessionPhase } = useCurrentSessionActivity();
    const { phase: btwSessionPhase } = useSessionActivity(btwSessionId, btwDirectory ?? undefined);
    const sessionPhase = isBtwActive ? btwSessionPhase : currentSessionPhase;
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
        composerRef.current?.blur();
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
                    composerRef.current?.focus();
                }, 0);
            }
        }
    }, [pendingInputText, consumePendingInputText]);

    const hasContent = message.trim().length > 0 || attachedFiles.length > 0 || hasDrafts;
    const hasQueuedMessages = queuedMessages.length > 0;
    const canSend = hasContent || hasQueuedMessages;

    const canAbort = sessionPhase !== 'idle';

    const getCurrentInputSnapshot = React.useCallback(() => {
        const currentMessage = composerRef.current?.getValue() ?? message;
        return {
            message: currentMessage,
            hasContent: currentMessage.trim().length > 0 || attachedFiles.length > 0 || hasDrafts,
        };
    }, [attachedFiles.length, hasDrafts, message]);

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
    const handleQueueMessage = React.useCallback(async () => {
        const inputSnapshot = getCurrentInputSnapshot();
        if (!inputSnapshot.hasContent || !currentSessionId || !messageQueueTarget) return;
        const queueRuntimeKey = getRuntimeKey();
        const queueTarget = messageQueueTarget;
        const queueSessionId = currentSessionId;
        const messageToQueue = inputSnapshot.message.replace(/^\n+|\n+$/g, '');
        const composerAttachments = sanitizeAttachmentsForSend(attachedFiles);

        // A queued message is resolved now, not at delivery: the server that
        // sends it has no agent list, no confirmed mentions, and no way to read
        // a document the user named — and the mention must match what was
        // visible when the user typed it.
        const documentMentions = await prepareDocumentMentions(
            [messageToQueue],
            new Set(composerAttachments.map((attachment) => attachment.filename)),
            queueRuntimeKey,
        );
        if (documentMentions.status === 'runtime-changed') return;
        if (documentMentions.status === 'failed') {
            toast.error(t('chat.chatInput.toast.attachNamedFailed', { name: documentMentions.filename }));
            return;
        }
        const { sanitizedText, mention } = parseAgentMentions(messageToQueue, agents);
        const { attachments: mentionAttachments } = extractInlineFileMentions(sanitizedText, documentMentions.prepared);
        const availableSkillNames = new Set(
            selectSkillsForDirectory(useSkillsStore.getState(), currentDirectory).map((skill) => skill.name),
        );
        const skillInstruction = buildSkillMentionInstruction(collectInlineSkillMentions(sanitizedText, availableSkillNames));

        // Everything attached to the composer leaves with the message: the
        // chips are part of what was queued, and come back if it is edited.
        const syntheticParts = consumePendingSyntheticParts() ?? [];
        const draftTarget = inlineDraftTarget;
        const drafts = draftTarget ? consumeDrafts(draftTarget) : [];
        const linked: LinkedReferences = { issue: linkedIssue, pr: linkedPr, linear: linkedLinearIssue };
        const context = buildComposerContext({
            inlineComments: drafts,
            syntheticTexts: syntheticParts.map((part) => part.text),
            linkedIssue: linked.issue
                ? { number: linked.issue.number, title: linked.issue.title, url: linked.issue.url, contextText: linked.issue.contextText }
                : null,
            linkedPr: linked.pr
                ? { number: linked.pr.number, title: linked.pr.title, url: linked.pr.url, instructions: linked.pr.instructionsText, context: linked.pr.contextText }
                : null,
            linkedLinearIssue: linked.linear
                ? { identifier: linked.linear.identifier, title: linked.linear.title, url: linked.linear.url, contextText: linked.linear.contextText }
                : null,
        }, skillInstruction);
        const attachmentsToQueue = [...composerAttachments, ...mentionAttachments];

        // Sending while the agent works must still take the reader to the
        // live edge — a queued message produces no user row yet, so the
        // anchor path has nothing to claim and would leave the viewport
        // parked mid-history.
        scrollToLatest?.();

        // Clear the composer. The mentions it had confirmed were resolved
        // above, so nothing later needs them.
        setMessage('');
        confirmedMentionsRef.current.clear();
        if (composerAttachments.length > 0) {
            clearAttachedFiles();
        }
        setLinkedIssue(null);
        setLinkedPr(null);
        setLinkedLinearIssue(null);
        if (!isMobile) {
            composerRef.current?.focus();
        }

        try {
            await addToQueue(queueTarget, {
                content: messageToQueue,
                text: sanitizedText,
                agentMention: mention?.name,
                attachments: attachmentsToQueue.length > 0 ? attachmentsToQueue : undefined,
                context: context.length > 0 ? context : undefined,
                sendConfig: currentProviderId && currentModelId ? {
                    providerID: currentProviderId,
                    modelID: currentModelId,
                    agent: currentAgentName ?? undefined,
                    variant: currentVariant ?? undefined,
                } : undefined,
            });
        } catch (error) {
            console.warn('[queue] failed to queue message:', error);
            toast.error(t('chat.queuedMessage.toast.queueFailed'));
            // The composer was cleared on queueing; give everything back. The
            // text is appended if the user has already typed something new.
            const currentInput = composerRef.current?.getValue() ?? messageRef.current;
            if (!currentInput) {
                setMessage(messageToQueue);
            } else {
                useInputStore.getState().setPendingInputText(messageToQueue, 'append');
            }
            if (composerAttachments.length > 0) {
                useInputStore.getState().setAttachedFiles([...useInputStore.getState().attachedFiles, ...composerAttachments]);
            }
            if (draftTarget && drafts.length > 0) {
                useInlineCommentDraftStore.getState().restoreDrafts(draftTarget, drafts);
            }
            if (syntheticParts.length > 0) {
                useInputStore.getState().setPendingSyntheticParts(syntheticParts);
            }
            setLinkedIssue(linked.issue);
            setLinkedPr(linked.pr);
            setLinkedLinearIssue(linked.linear);
            return;
        }
        recordLinkedReferences(queueSessionId, queueTarget.directory, linked);
    }, [getCurrentInputSnapshot, currentSessionId, messageQueueTarget, attachedFiles, sanitizeAttachmentsForSend, prepareDocumentMentions, extractInlineFileMentions, agents, currentDirectory, consumePendingSyntheticParts, inlineDraftTarget, consumeDrafts, linkedIssue, linkedPr, linkedLinearIssue, scrollToLatest, clearAttachedFiles, isMobile, addToQueue, currentProviderId, currentModelId, currentAgentName, currentVariant, t]);

    /** Put the context a queued message was captured with back on the composer chips. */
    const restoreQueuedContext = React.useCallback((context: readonly QueuedContextPart[]) => {
        const synthetic: SyntheticContextPart[] = [];
        for (const part of context) {
            if (part.kind === 'synthetic') {
                synthetic.push({ text: part.text, synthetic: true });
                continue;
            }
            // An instruction is derived from the text, and derived again on send.
            if (part.kind !== 'context') continue;
            const payload = part.metadata[CONTEXT_METADATA_KEY];
            if (payload.kind === 'github-issue') {
                setLinkedIssue({ number: payload.number, title: payload.title, url: payload.url, contextText: part.text });
                setLinkedPr(null);
                setLinkedLinearIssue(null);
            } else if (payload.kind === 'github-pr') {
                // The captured context is final: whatever diff it includes is
                // already in the text, and the branches were not captured.
                setLinkedPr({
                    number: payload.number,
                    title: payload.title,
                    url: payload.url,
                    head: '',
                    base: '',
                    includeDiff: false,
                    instructionsText: part.instructions ?? '',
                    contextText: part.text,
                });
                setLinkedIssue(null);
                setLinkedLinearIssue(null);
            } else if (payload.kind === 'linear-issue') {
                setLinkedLinearIssue({ identifier: payload.identifier, title: payload.title, url: payload.url, contextText: part.text });
                setLinkedIssue(null);
                setLinkedPr(null);
            } else {
                const draft = draftFromContextPayload(payload);
                if (draft && inlineDraftTarget) {
                    useInlineCommentDraftStore.getState().addDraft(inlineDraftTarget, draft);
                }
            }
        }
        if (synthetic.length > 0) {
            const pending = useInputStore.getState().pendingSyntheticParts ?? [];
            useInputStore.getState().setPendingSyntheticParts([...pending, ...synthetic]);
        }
    }, [inlineDraftTarget]);

    const handleQueuedMessageEdit = React.useCallback((queued: QueuedMessage) => {
        setMessage(queued.content);
        restoreQueuedContext(queued.context ?? []);
        setTimeout(() => {
            composerRef.current?.focus();
        }, 0);
    }, [restoreQueuedContext]);

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

    const openLinearPicker = React.useCallback(() => {
        setLinearPickerOpen(true);
    }, []);

    const getSubmitErrorMessage = (error: unknown, fallback: string) => {
        const message = error instanceof Error ? error.message : '';
        return message.toLowerCase().includes('runtime changed')
            ? t('chat.chatInput.toast.messageSendFailed')
            : message || fallback;
    };

    const handleSubmit = async (options?: SubmitOptions) => {
        const submitRuntimeKey = getRuntimeKey();
        const queuedOnly = options?.queuedOnly ?? false;
        const queuedMessageId = options?.queuedMessageId;
        const delivery = options?.delivery === 'steer' && sessionPhase !== 'idle' ? 'steer' : undefined;
        const capturedTarget = messageQueueTarget;
        // An expired session cannot deliver anything: keep the prompt in the
        // composer and point at the login banner instead of burning the send
        // on a guaranteed 401.
        if (useAuthSessionStore.getState().state !== 'ok') {
            toast.error(t('sessionAuth.expired.sendBlocked'));
            return;
        }

        // Snapshot the draft and current-session identity before the first
        // async gap so a later sidebar selection cannot reroute the send.
        const capturedDraftSnapshot = newSessionDraftOpen ? { ...newSessionDraft } : null;
        const inputSnapshot = options?.presetText != null
            ? {
                message: options.presetText,
                hasContent: options.presetText.trim().length > 0 || attachedFiles.length > 0 || hasDrafts,
            }
            : getCurrentInputSnapshot();
        if (queuedOnly && autoReviewRunning) {
            return;
        }

        if (queuedOnly) {
            if (!queuedMessages.some((message) => !queuedMessageId || message.id === queuedMessageId) || !currentSessionId) return;
        } else if ((!inputSnapshot.hasContent && !hasQueuedMessages) || (!currentSessionId && !newSessionDraftOpen)) {
            return;
        }

        // The projection knows the captured send configuration; the full
        // messages are taken from the queue only once nothing below can still
        // bail out, so an early return leaves the queue untouched.
        const queuedProjection = queuedMessageId
            ? queuedMessages.filter((message) => message.id === queuedMessageId)
            : queuedMessages;
        const capturedSendConfig = queuedOnly ? queuedProjection[0]?.sendConfig : undefined;
        const providerIdToSend = capturedSendConfig?.providerID ?? currentProviderId;
        const modelIdToSend = capturedSendConfig?.modelID ?? currentModelId;
        const agentNameToSend = capturedSendConfig?.agent ?? currentAgentName;
        const variantToSend = capturedSendConfig?.variant ?? currentVariant;

        if (!providerIdToSend || !modelIdToSend) {
            console.warn('Cannot send message: provider or model not selected');
            toast.error(t('chat.chatInput.toast.noModelSelected'));
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
        if (currentSessionId && !queuedOnly && autoReviewRunning && !isBtwActive) {
            void handleQueueMessage();
            return;
        }

        // btw mode: the child fork's blocking prompts are answered inside the
        // panel; the composer send goes straight to the fork (routeMessage
        // queues if the fork's own turn is busy).
        if (currentSessionId && !queuedOnly && !isBtwActive) {
            // Sending is authoritative for blocking prompts: deny pending
            // permissions and dismiss open questions for the session subtree,
            // then queue the message once if either was open. The deny/clear
            // vanishes the card instantly (optimistic); rejecting unblocks the
            // agent's tool but does NOT end its turn, so a direct send would
            // race with the still-active run and be silently discarded by the
            // OpenCode runner. Instead we queue; the queued-message auto-send
            // hook delivers it as the next turn once the rejected turn winds
            // down and the session returns to idle (parity with #1740).
            const [deniedPermissions, dismissedQuestions] = await Promise.all([
                sessionActions.dismissOpenPermissionsForSession(currentSessionId),
                sessionActions.dismissOpenQuestionsForSession(currentSessionId),
            ]);
            if (deniedPermissions || dismissedQuestions) {
                void handleQueueMessage();
                return;
            }
        }

        let sendMessageOptions: {
            target?: NonNullable<typeof capturedTarget>;
            sessionId?: string;
            directory?: string;
            draftSnapshot?: NonNullable<typeof capturedDraftSnapshot>;
            delivery?: 'steer';
        } | undefined;
        if (isBtwActive && btwSessionId && btwDirectory) {
            sendMessageOptions = {
                sessionId: btwSessionId,
                directory: btwDirectory,
            };
        } else if (capturedTarget || capturedDraftSnapshot || delivery) {
            sendMessageOptions = {};
            if (capturedTarget) sendMessageOptions.target = capturedTarget;
            if (capturedDraftSnapshot) sendMessageOptions.draftSnapshot = capturedDraftSnapshot;
        }
        if (delivery && sendMessageOptions) sendMessageOptions.delivery = delivery;

        // Queued messages resolved their mentions when they were queued; only
        // the composer's own text can still name a document.
        const reservedFilenames = new Set([
            ...attachedFiles.map((attachment) => attachment.filename),
            ...queuedProjection.flatMap((queued) => queued.attachments?.map((attachment) => attachment.filename) ?? []),
        ]);
        const documentMentions = await prepareDocumentMentions(
            !queuedOnly && inputSnapshot.hasContent ? [inputSnapshot.message] : [],
            reservedFilenames,
            submitRuntimeKey,
        );
        if (documentMentions.status === 'runtime-changed') return;
        if (documentMentions.status === 'failed') {
            toast.error(t('chat.chatInput.toast.attachNamedFailed', { name: documentMentions.filename }));
            return;
        }
        const preparedDocumentMentions = documentMentions.prepared;

        // The composer delivers these itself, so they leave the queue now — the
        // queue's own delivery (server-side, or the auto-send hook in VS Code)
        // skips anything already in flight, and a message already being
        // delivered stays out of this send so it cannot go out twice.
        let queuedMessagesToSend: QueuedMessage[] = [];
        if (capturedTarget && hasQueuedMessages) {
            try {
                queuedMessagesToSend = await takeForSend(capturedTarget, queuedMessageId);
            } catch (error) {
                console.warn('[queue] failed to take queued messages for sending:', error);
                toast.error(t('chat.queuedMessage.toast.takeFailed'));
                return;
            }
            if (queuedOnly && queuedMessagesToSend.length === 0) return;
        }

        // Inline review comments and synthetic context are consumed before
        // assembly so a failed send can restore exactly what it took. What is
        // here belongs to this send: queueing took its own context with it.
        const syntheticParts = consumePendingSyntheticParts();
        const consumedDraftTarget = inlineDraftTarget;
        const drafts: InlineCommentDraft[] = consumedDraftTarget
            ? consumeDrafts(consumedDraftTarget)
            : [];

        const availableSkillNames = new Set(
            selectSkillsForDirectory(useSkillsStore.getState(), currentDirectory).map((skill) => skill.name),
        );

        const outgoing = buildOutgoingMessage({
            queued: queuedMessagesToSend,
            composerText: !queuedOnly && inputSnapshot.hasContent ? inputSnapshot.message : null,
            composerAttachments: attachedFiles,
            inlineComments: drafts,
            syntheticTexts: [
                ...buildBtwSyntheticTexts({ isBtwActive, isPromotedBtwSession }),
                ...(syntheticParts?.map((part) => part.text) ?? []),
            ],
            linkedIssue: linkedIssue
                ? { number: linkedIssue.number, title: linkedIssue.title, url: linkedIssue.url, contextText: linkedIssue.contextText }
                : null,
            linkedPr: linkedPr
                ? { number: linkedPr.number, title: linkedPr.title, url: linkedPr.url, instructions: linkedPr.instructionsText, context: linkedPr.contextText }
                : null,
            linkedLinearIssue: linkedLinearIssue
                ? { identifier: linkedLinearIssue.identifier, title: linkedLinearIssue.title, url: linkedLinearIssue.url, contextText: linkedLinearIssue.contextText }
                : null,
        }, {
            parseAgentMention: (text) => {
                const { sanitizedText, mention } = parseAgentMentions(text, agents);
                return { text: sanitizedText, agentName: mention?.name };
            },
            extractFileMentions: (text) => {
                const { sanitizedText, attachments } = extractInlineFileMentions(text, preparedDocumentMentions);
                return { text: sanitizedText, attachments };
            },
            sanitizeAttachments: sanitizeAttachmentsForSend,
            collectSkillNames: (text) => collectInlineSkillMentions(text, availableSkillNames),
            buildSkillInstruction: buildSkillMentionInstruction,
        });

        let primaryText = outgoing.primaryText;
        const { primaryAttachments, additionalParts, agentMentionName } = outgoing;

        if (outgoing.isEmpty) return;

        // Clear input (the queue was taken above)
        if (!queuedOnly) {
            setMessage('');
            confirmedMentionsRef.current.clear();
            // Clear per-session draft on submit
            persistDraftImmediately(chatDraftIdentity, '');
            messageHistory.reset();
            if (attachedFiles.length > 0) {
                clearAttachedFiles();
            }
            // Close expanded input overlay when submitting
            setExpandedInput(false);
        }

        if (isMobile) {
            composerRef.current?.blur();
        }

        // Local slash commands, normal mode only.
        const parsedCommand = inputMode === 'normal' ? parseSlashCommand(primaryText) : null;
        if (parsedCommand) {
            const { name: commandName, argument } = parsedCommand;

            // Commands that manipulate session state or open UI rather than
            // sending a message.
            if (commandName === 'undo' && currentSessionId) {
                await useSessionUIStore.getState().handleSlashUndo(currentSessionId);
                scrollToBottom?.();
                return;
            }
            if (commandName === 'redo' && currentSessionId) {
                await useSessionUIStore.getState().handleSlashRedo(currentSessionId);
                scrollToBottom?.();
                return;
            }
            if (commandName === 'timeline' && currentSessionId) {
                setTimelineDialogOpen(true);
                return;
            }
            if (commandName === 'handoff-review' && currentSessionId && !isMobile && !isVSCodeRuntime()) {
                setReviewDialogOpen(true);
                return;
            }
            if (commandName === 'compact' && currentSessionId) {
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const compactDirectory = useSessionUIStore.getState().getDirectoryForSession(currentSessionId) || currentDirectory || undefined;
                    await opencodeClient.summarizeSession(currentSessionId, currentProviderId, currentModelId, compactDirectory);
                } catch (error) {
                    toast.error(getSubmitErrorMessage(error, t('chat.chatInput.toast.compactFailed')));
                }
                return;
            }
            if (commandName === 'btw' && currentSessionId) {
                const question = argument.trim();
                if (!question) {
                    toast.error(t('chat.btw.toast.emptyArgument'));
                    return;
                }
                const targetDirectory = useSessionUIStore.getState().getDirectoryForSession(currentSessionId)
                    || currentDirectory
                    || null;
                if (!targetDirectory) {
                    toast.error(t('chat.btw.toast.createFailed'));
                    return;
                }
                try {
                    // A new btw replaces this session's current one: destroy
                    // the previous fork first so forks never accumulate.
                    if (btwSessionRef) {
                        await destroyBtwSession(btwSessionRef);
                    }
                    await startBtwSession({
                        parentSessionId: currentSessionId,
                        question,
                        directory: targetDirectory,
                        providerID: providerIdToSend,
                        modelID: modelIdToSend,
                        agent: agentNameToSend,
                        variant: variantToSend,
                    });
                    scrollToBottom?.();
                } catch (error) {
                    toast.error(getSubmitErrorMessage(error, t('chat.btw.toast.createFailed')));
                }
                return;
            }

            // The rest render a visible prompt plus synthetic instructions and
            // send them as one message.
            const command = findMagicPromptCommand(commandName);
            const commandIsAvailable = command !== null && canRunCommand(command, {
                hasSession: Boolean(currentSessionId),
                hasDraft: newSessionDraftOpen,
            });
            if (command && commandIsAvailable) {
                const variables = buildCommandVariables(command, argument);
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const visibleText = await renderMagicPrompt(command.visiblePrompt, variables.visible);
                    const instructionsText = await renderMagicPrompt(command.instructionsPrompt, variables.instructions);
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
                    toast.error(getSubmitErrorMessage(error, t(command.errorToastKey)));
                }
                return;
            }
        }

        const currentSessionDirectory = capturedTarget?.directory ?? currentDirectory;
        // btw mode: the fork already carries the question plus full history,
        // so the response-style instruction never applies there.
        const shouldAddResponseStyle = !isBtwActive && (newSessionDraftOpen || (currentSessionId ? !hasUserMessages(currentSessionId, currentSessionDirectory) : false));
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

        // Arm the timeline anchor BEFORE the optimistic user row can commit;
        // arming after (or a frame later) races the commit and the anchor
        // never claims the new message.
        scrollToBottom?.();

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
        const restoreConsumedDrafts = () => {
            if (consumedDraftTarget && drafts.length > 0) {
                useInlineCommentDraftStore.getState().restoreDrafts(consumedDraftTarget, drafts);
            }
        };

        void sendPromise.then(() => {
            // On a draft there is no session yet in this closure: the send path
            // creates one and makes it current before resolving, so the id is
            // read from the store. The fallback is used only when the closure
            // had no session at all, so a mid-send session switch cannot
            // redirect the write to an unrelated session.
            const sessionState = useSessionUIStore.getState();
            const linkTargetSessionId = currentSessionId ?? sessionState.currentSessionId;
            const linkTargetDirectory = currentSessionId
                ? currentSessionDirectoryForSync ?? currentDirectory
                : sessionState.currentSessionDirectory
                    ?? (linkTargetSessionId ? sessionState.getDirectoryForSession(linkTargetSessionId) : null)
                    ?? currentDirectory;
            if (linkTargetSessionId) {
                recordLinkedReferences(linkTargetSessionId, linkTargetDirectory, { issue: linkedIssue, pr: linkedPr, linear: linkedLinearIssue });
            }

            // Linked references were sent; clear them from the composer.
            setLinkedIssue(null);
            setLinkedPr(null);
            setLinkedLinearIssue(null);
        }).catch((error: unknown) => {
            const rawMessage =
                error instanceof Error
                    ? error.message
                    : typeof error === 'string'
                        ? error
                        : String(error ?? '');
            const normalized = rawMessage.toLowerCase();

            console.error('Message send failed:', rawMessage || error);
            restoreConsumedDrafts();

            // A failed send returns the typed prompt no matter WHY it failed —
            // auth, network, server, anything. Losing a long prompt to a toast
            // is the one outcome this handler must never produce.
            if (inputSnapshot.message) {
                if (currentChatDraftIdentityRef.current !== chatDraftIdentity) {
                    // The user switched sessions mid-send: restore into that
                    // session's persisted draft, not the visible composer.
                    writeChatDraft(chatDraftIdentity, inputSnapshot.message, confirmedMentionsRef.current);
                } else {
                    const currentInput = composerRef.current?.getValue() ?? messageRef.current;
                    if (!currentInput || currentInput === inputSnapshot.message) {
                        setMessage(inputSnapshot.message);
                        writeChatDraft(chatDraftIdentity, inputSnapshot.message, confirmedMentionsRef.current);
                    } else {
                        // New typing already lives in the composer; the failed
                        // prompt joins it instead of clobbering either text.
                        useInputStore.getState().setPendingInputText(inputSnapshot.message, 'append');
                    }
                }
            }

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

            if (normalized.includes('runtime changed')) {
                if (allAttachments.length > 0) {
                    useInputStore.getState().setAttachedFiles(allAttachments);
                }
                toast.error(t('chat.chatInput.toast.messageSendFailed'));
                return;
            }

            if (allAttachments.length > 0) {
                useInputStore.getState().setAttachedFiles(allAttachments);
            }
            toast.error(rawMessage || t('chat.chatInput.toast.messageSendFailed'));
        });

        if (!isMobile) {
            composerRef.current?.focus();
        }
    };

    // Update ref with latest handleSubmit on every render
    handleSubmitRef.current = handleSubmit;

    // Primary action for send/queue button — respects selected follow-up behavior
    const handlePrimaryAction = React.useCallback(() => {
        const inputSnapshot = getCurrentInputSnapshot();
        const canQueue = !isBtwActive && inputMode === 'normal' && inputSnapshot.hasContent && currentSessionId && (currentSessionPhase !== 'idle' || autoReviewRunning);
        if (followUpBehavior === 'queue' && canQueue) {
            void handleQueueMessage();
        } else if (followUpBehavior === 'steer' && canQueue) {
            void handleSubmitRef.current({ delivery: 'steer' });
        } else {
            void handleSubmitRef.current();
        }
    }, [inputMode, getCurrentInputSnapshot, currentSessionId, currentSessionPhase, autoReviewRunning, followUpBehavior, handleQueueMessage, isBtwActive]);

    // Draft welcome presets: submit immediately.
    const submitPresetPrompt = React.useCallback((text: string, type: 'command' | 'skill') => {
        // The text goes straight into the submit (see SubmitOptions.presetText)
        // instead of through the composer input — the collapsed mobile pill has
        // no mounted textarea to stage it in.
        const draft = (composerRef.current?.getValue() ?? messageRef.current).trim();
        // OpenCode recognizes slash commands only when their arguments follow
        // the command on the same line. Skills retain the multiline prompt form.
        const presetText = draft ? `${text}${type === 'command' ? ' ' : '\n'}${draft}` : text;
        void handleSubmitRef.current({ presetText });
    }, []);

    // Dictation: insert the transcript inline; optionally submit immediately.
    // getCurrentInputSnapshot reads composerRef.current.getValue() first, so setting
    // it synchronously lets handleSubmit pick up the text in the same tick.
    const handleDictationInsert = React.useCallback((text: string) => {
        setMessage((prev) => {
            // The editor is controlled by this state; getCurrentInputSnapshot
            // reads it back, so no imperative write is needed.
            return appendInlineText(prev, text);
        });
        setTimeout(() => {
            composerRef.current?.focus();
        }, 0);
    }, []);

    const handleDictationInsertAndSend = React.useCallback((text: string) => {
        // Same as preset chips: the composed text goes into the submit as an
        // explicit override instead of being staged in the textarea, which may
        // not be mounted (collapsed mobile pill).
        const next = appendInlineText(composerRef.current?.getValue() ?? messageRef.current, text);
        void handleSubmitRef.current({ presetText: next });
    }, []);

    // Preset chips rendered outside this component (e.g. under the welcome
    // message on narrow surfaces) request a submit via the input store; consume
    // it here so it routes through the same command-aware submit path.
    React.useEffect(() => {
        if (pendingPresetSubmit == null) return;
        const text = useInputStore.getState().consumePendingPresetSubmit();
        if (text) submitPresetPrompt(text.text, text.type);
    }, [pendingPresetSubmit, submitPresetPrompt]);

    const handleKeyDown = (e: KeyboardEvent) => {
        // Early return during IME composition to prevent interference with autocomplete.
        // Uses keyCode === 229 fallback for WebKit where compositionend fires before keydown.
        if (isIMECompositionEvent(e)) return;

        // Enter shell mode before CodeMirror inserts the trigger. Keeping the
        // document unchanged also keeps the caret at the start for the first
        // command character.
        if (inputMode === 'normal' && e.key === '!') {
            const selection = composerRef.current?.getSelection();
            if (selection?.start === 0 && selection.end === 0) {
                e.preventDefault();
                setInputMode('shell');
                closeAutocomplete();
                return;
            }
        }

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

        if (openAutocomplete === 'command' && commandRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                commandRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (openAutocomplete === 'skill' && skillRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                skillRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (openAutocomplete === 'snippet' && snippetRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                snippetRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (openAutocomplete === 'mention' && mentionRef.current) {
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

        if (cycleAgentDirection !== 0 && openAutocomplete === null) {
            e.preventDefault();
            e.stopPropagation();
            handleCycleAgent(cycleAgentDirection);
            return;
        }

        // Handle ArrowUp/ArrowDown for message history navigation
        // ArrowUp: only when cursor at start (position 0) or input is empty
        // ArrowDown: also works when cursor at end (to cycle forward through history)
        const isAnyAutocompleteOpen = openAutocomplete !== null;
        const cursorAtStart = composerRef.current?.getSelection().start === 0 && composerRef.current?.getSelection().end === 0;
        const cursorAtEnd = composerRef.current?.getSelection().start === message.length && composerRef.current?.getSelection().end === message.length;
        const canNavigateHistoryUp = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtStart);
        const canNavigateHistoryDown = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtEnd);

        // Markdown-aware auto-pairing (source mode), normal input only.
        if (inputMode === 'normal' && !isAnyAutocompleteOpen && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const ta = composerRef.current;
            const selStart = ta?.getSelection().start ?? -1;
            const selEnd = ta?.getSelection().end ?? -1;

            if (ta && selStart >= 0) {
                const edit = getMarkdownAutoPairEdit(message, e.key, selStart, selEnd);
                if (edit) {
                    e.preventDefault();
                    ta.replaceRange(
                        edit.from,
                        edit.to,
                        edit.insert,
                        edit.selectionStart,
                        edit.selectionEnd,
                    );
                    return;
                }
            }
        }

        if (e.key === 'ArrowUp' && canNavigateHistoryUp) {
            e.preventDefault();
            const recalled = messageHistory.older(message);
            if (recalled !== null) {
                setMessage(recalled);
                // Caret to the start, so the recalled message reads from its
                // beginning rather than from wherever the draft's caret was.
                requestAnimationFrame(() => composerRef.current?.setSelection(0, 0));
            }
            return;
        }

        if (e.key === 'ArrowDown' && canNavigateHistoryDown) {
            e.preventDefault();
            const recalled = messageHistory.newer();
            if (recalled !== null) setMessage(recalled);
            return;
        }

        // Handle Enter/Ctrl+Enter based on selected follow-up behavior. On
        // mobile, and in desktop focus mode, plain Enter writes a newline and
        // only Cmd/Ctrl+Enter sends: both are surfaces for composing long
        // prompts, where an accidental send costs more than an extra keypress.
        const requiresModifierToSend = isMobile || isDesktopExpanded;
        if (e.key === 'Enter' && !e.shiftKey && (!requiresModifierToSend || e.ctrlKey || e.metaKey)) {
            e.preventDefault();

            const isCtrlEnter = e.ctrlKey || e.metaKey;

            // Queueing / steering only works when there's an existing busy
            // session (or an active auto-review run).
            const canQueue = !isBtwActive && inputMode === 'normal' && hasContent && currentSessionId && (currentSessionPhase !== 'idle' || autoReviewRunning);

            if (followUpBehavior === 'queue') {
                if (isCtrlEnter || !canQueue) {
                    handleSubmit();
                } else {
                    void handleQueueMessage();
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

    // Focus mode places the open picker at the caret; elsewhere each picker
    // anchors to the composer itself.
    const {
        position: autocompleteOverlayPosition,
        update: updateAutocompleteOverlayPosition,
    } = useAutocompletePosition({
        enabled: isDesktopExpanded,
        openAutocomplete,
        message,
        editorRef: composerRef,
        containerRef: dropZoneRef,
    });


    const handleAbort = React.useCallback(() => {
        clearAbortPrompt();

        // btw mode: the stop button stops the fork's turn, not the main
        // session's.
        const abortTarget = isBtwActive && btwSessionId ? btwSessionId : currentSessionId;
        void abortCurrentOperation(abortTarget || undefined);
    }, [abortCurrentOperation, btwSessionId, clearAbortPrompt, currentSessionId, isBtwActive]);

    const handleCycleAgent = React.useCallback((direction: 1 | -1 = 1) => {
        const nextAgentName = getCycledPrimaryAgentName(agents, currentAgentName, direction);
        if (!nextAgentName) return;

        setAgent(nextAgentName);

        if (currentSessionId) {
            saveSessionAgentSelection(currentSessionId, nextAgentName);
        }
    }, [agents, currentAgentName, currentSessionId, setAgent, saveSessionAgentSelection]);

    // Height the dictation transcript needs (null when idle). Its overlay sits
    // absolutely over the composer, so the composer must be able to grow for
    // it. The editor sizes itself to its own content; this is the one external
    // constraint, applied as a floor on the editor's container.
    const [dictationContentHeight, setDictationContentHeight] = React.useState<number | null>(null);
    const handleDictationContentHeightChange = React.useCallback((height: number | null) => {
        setDictationContentHeight((prev) => (prev === height ? prev : height));
    }, []);

    const updateAutocompleteState = React.useCallback((
        value: string,
        cursorPosition: number,
        inputSource: FileMentionAutocompleteInputSource = 'manual',
        insertedText?: string,
    ) => {
        const trigger = resolveAutocompleteTrigger(value, cursorPosition, {
            inputMode,
            inputSource,
            insertedText,
        });
        setOpenAutocomplete(trigger?.kind ?? null);
        setAutocompleteQuery(trigger?.query ?? '');
    }, [inputMode]);

    const insertTextAtSelection = React.useCallback((
        text: string,
        inputSource: FileMentionAutocompleteInputSource = 'manual',
    ) => {
        if (!text) {
            return;
        }

        const editor = composerRef.current;
        if (!editor) {
            // No mounted editor (collapsed mobile pill): append to the state
            // the editor will be seeded from.
            const nextValue = messageRef.current + text;
            setMessage(nextValue);
            updateAutocompleteState(nextValue, nextValue.length, inputSource, text);
            return;
        }

        const { start, end } = editor.getSelection();
        // Read the live document — delayed toast actions must not use a
        // paste-time React `message` closure.
        const currentMessage = editor.getValue();
        const nextValue = `${currentMessage.substring(0, start)}${text}${currentMessage.substring(end)}`;
        const cursorPosition = start + text.length;

        // One dispatch places both the text and the caret, so there is no
        // frame where the caret sits at a stale offset.
        editor.insertText(text);
        updateAutocompleteState(nextValue, cursorPosition, inputSource, text);
    }, [updateAutocompleteState]);

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

    const handleComposerChange = ({ value, selection, fromPaste, insertedText }: ComposerChange) => {
        if (shellTriggerNormalizationRef.current) {
            shellTriggerNormalizationRef.current = false;
            setMessage(value);
            return;
        }

        // VS Code drops the dragged path as text as well as firing the drop
        // handler; swallow that duplicate insertion.
        if (isVSCodeRuntime() && suppressNextFileDropTextInsertRef.current) {
            const candidateAbsolutePaths = pendingDroppedAbsolutePathsRef.current;
            if (candidateAbsolutePaths.some((path) => path.length > 0 && value.includes(path))) {
                clearDropTextSuppression();
                return;
            }
        }

        const pastedInsertedText = fromPaste ? insertedText : '';
        const isPasteInput = pastedInsertedText.includes('@') || suppressNextFileMentionPasteRef.current;
        if (suppressNextFileMentionPasteRef.current) {
            clearFileMentionPasteSuppression();
        }
        const inputSource: FileMentionAutocompleteInputSource = isPasteInput ? 'paste' : 'manual';

        // A leading `!` switches the composer into shell mode and is consumed.
        // Mobile keyboards and paste may update the document without a usable
        // keydown, so consume the trigger in the same editor transaction rather
        // than moving the caret in a later frame against stale text.
        if (inputMode === 'normal' && value.startsWith('!')) {
            const shellCommand = value.slice(1);
            const nextCursor = Math.max(0, selection.start - 1);
            setInputMode('shell');
            closeAutocomplete();
            const editor = composerRef.current;
            if (editor) {
                shellTriggerNormalizationRef.current = true;
                editor.replaceRange(0, 1, '', nextCursor);
            } else {
                setMessage(shellCommand);
            }
            return;
        }

        setMessage(value);
        updateAutocompleteState(value, selection.start, inputSource, pastedInsertedText);
    };

    React.useEffect(() => {
        return () => {
            clearDropTextSuppression();
            clearFileMentionPasteSuppression();
        };
    }, [clearDropTextSuppression, clearFileMentionPasteSuppression]);

    const handlePaste = React.useCallback(async (event: ClipboardEvent) => {
        const clipboardData = event.clipboardData;
        if (!clipboardData) return;
        // Narrowed alias so the rest of the handler reads as it did when this
        // was a React synthetic event, whose clipboardData is never null.
        const e = { ...event, clipboardData, preventDefault: () => event.preventDefault() };

        // Pasting a URL over a selection wraps it as a markdown link:
        // [selected text](pasted url).
        if (inputMode === 'normal' && (currentSessionId || newSessionDraftOpen)) {
            const ta = composerRef.current;
            const selStart = ta?.getSelection().start ?? -1;
            const selEnd = ta?.getSelection().end ?? -1;
            if (ta && selEnd > selStart) {
                const clipboardText = e.clipboardData.getData('text');
                const url = clipboardText.trim();
                const selected = message.slice(selStart, selEnd);
                if (shouldWrapSelectionAsLink(url, selected)) {
                    e.preventDefault();
                    const next = `${message.slice(0, selStart)}[${selected}](${url})${message.slice(selEnd)}`;
                    const caret = selStart + 1 + selected.length + 2 + url.length + 1;
                    setMessage(next);
                    composerRef.current?.setSelection(caret, caret);
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
        const sessionReady = Boolean(currentSessionId || newSessionDraftOpen);

        if (imageFiles.length === 0) {
            const behavior: LargeTextPasteBehavior = largeTextPasteBehavior;
            const shouldOfferLargePaste = sessionReady
                && inputMode === 'normal'
                && behavior !== 'inline'
                && isLargePlainTextPaste(pastedText);

            if (!shouldOfferLargePaste) {
                if (pastedText.includes('@')) {
                    markFileMentionPasteSuppression();
                }
                return;
            }

            // Must run synchronously — ComposerEditor does not consume paste.
            e.preventDefault();

            const pasteInline = () => {
                if (pastedText.includes('@')) {
                    markFileMentionPasteSuppression();
                }
                insertTextAtSelection(
                    pastedText,
                    getFileMentionInputSourceForInsertedText(pastedText),
                );
            };

            const attachAsFile = async () => {
                // Read live attachment + composer state at action time — the ask
                // toast can outlive the paste while the user types or attaches more.
                const liveAttachedFiles = useInputStore.getState().attachedFiles;
                const filename = nextPastedContextFilename([
                    ...liveAttachedFiles.map((file) => file.filename),
                    ...pendingPastedAttachmentFilenamesRef.current,
                ]);
                const citationText = buildAttachmentCitationText([filename]);
                const editor = composerRef.current;
                const currentMessage = editor?.getValue() ?? messageRef.current;
                const selectionStart = editor?.getSelection().start ?? currentMessage.length;
                const selectionEnd = editor?.getSelection().end ?? currentMessage.length;
                const insertionText = withInlineInsertionBoundaries(
                    citationText,
                    currentMessage.slice(0, selectionStart),
                    currentMessage.slice(selectionEnd),
                );

                insertTextAtSelection(
                    insertionText,
                    getFileMentionInputSourceForInsertedText(insertionText),
                );

                const file = createPastedContextFile(pastedText, filename);
                pendingPastedAttachmentFilenamesRef.current.add(filename);
                try {
                    await addAttachedFile(file);
                } catch (error) {
                    console.error('Clipboard text attach failed', error);
                    toast.error(
                        error instanceof Error
                            ? error.message
                            : t('chat.chatInput.toast.clipboardTextAttachFailed'),
                    );
                } finally {
                    pendingPastedAttachmentFilenamesRef.current.delete(filename);
                }
            };

            if (behavior === 'attach') {
                await attachAsFile();
                return;
            }

            const offerId = beginLargeTextPasteOffer(largeTextPasteOfferIdRef.current);
            largeTextPasteOfferIdRef.current = offerId;

            if (largeTextPasteToastIdRef.current !== null) {
                // Invalidate first so a synchronous onDismiss from dismiss()
                // cannot apply the superseded paste.
                toast.dismiss(largeTextPasteToastIdRef.current);
                largeTextPasteToastIdRef.current = null;
            }

            const resolveLargePaste = (action: 'attach' | 'inline') => {
                const resolution = resolveLargeTextPasteOffer(
                    largeTextPasteOfferIdRef.current,
                    offerId,
                );
                largeTextPasteOfferIdRef.current = resolution.nextOfferId;
                if (!resolution.accepted) {
                    return;
                }
                largeTextPasteToastIdRef.current = null;
                if (action === 'attach') {
                    void attachAsFile();
                    return;
                }
                pasteInline();
            };

            largeTextPasteToastIdRef.current = toast.info(
                t('chat.chatInput.toast.largeTextPaste.title'),
                {
                    duration: Infinity,
                    className: LARGE_TEXT_PASTE_TOAST_CLASSNAME,
                    action: {
                        label: t('chat.chatInput.toast.largeTextPaste.attach'),
                        onClick: () => resolveLargePaste('attach'),
                    },
                    cancel: {
                        label: t('chat.chatInput.toast.largeTextPaste.inline'),
                        onClick: () => resolveLargePaste('inline'),
                    },
                    onDismiss: () => {
                        // Dismissing without a choice keeps the paste — insert inline
                        // so clipboard content is not lost.
                        resolveLargePaste('inline');
                    },
                },
            );
            return;
        }

        if (!sessionReady) {
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
        const textarea = composerRef.current;
        const selectionStart = textarea?.getSelection().start ?? message.length;
        const selectionEnd = textarea?.getSelection().end ?? message.length;
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
    }, [addAttachedFile, attachedFiles, currentSessionId, inputMode, largeTextPasteBehavior, markFileMentionPasteSuppression, message, newSessionDraftOpen, insertTextAtSelection, setMessage, t, updateAutocompleteState]);

    const handleFileSelect = (file: { name: string; path: string; relativePath?: string }) => {

        const cursorPosition = composerRef.current?.getSelection().start || 0;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

        const mentionPath = (file.relativePath && file.relativePath.trim().length > 0)
            ? file.relativePath.trim()
            : (toMentionPath(file.path) || file.name);

        confirmedMentionsRef.current.add(mentionPath);

        if (lastAtSymbol !== -1) {
            const newMessage =
                message.substring(0, lastAtSymbol) +
                `@${mentionPath} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);
            const nextCursor = lastAtSymbol + mentionPath.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        } else if (composerRef.current) {
            const newMessage =
                message.substring(0, cursorPosition) +
                `@${mentionPath} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);
            const nextCursor = cursorPosition + mentionPath.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        closeAutocomplete();

        composerRef.current?.focus();
    };

    const handleAgentSelect = (agentName: string) => {
        const textarea = composerRef.current;
        const cursorPosition = textarea?.getSelection().start ?? message.length;
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
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        } else if (composerRef.current) {
            const newMessage =
                message.substring(0, cursorPosition) +
                `@${agentName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = cursorPosition + agentName.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        closeAutocomplete();

        composerRef.current?.focus();
    };

    const handleSkillSelect = (skillName: string) => {
        const textarea = composerRef.current;
        const cursorPosition = textarea?.getSelection().start ?? message.length;
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
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        closeAutocomplete();

        composerRef.current?.focus();
    };

    const handleSnippetSelect = (_snippet: unknown, trigger: string) => {
        const textarea = composerRef.current;
        const cursorPosition = textarea?.getSelection().start ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastHashSymbol = textBeforeCursor.lastIndexOf('#');
        const startIndex = lastHashSymbol !== -1 ? lastHashSymbol : cursorPosition;
        const newMessage = `${message.substring(0, startIndex)}#${trigger} ${message.substring(cursorPosition)}`;
        setMessage(newMessage);
        const nextCursor = startIndex + trigger.length + 2;
        requestAnimationFrame(() => {
            if (composerRef.current) {
                composerRef.current.setSelection(nextCursor);
            }
            updateAutocompleteState(newMessage, nextCursor);
        });
        closeAutocomplete();
        composerRef.current?.focus();
    };

    const handleCommandSelect = (command: CommandInfo) => {

        setMessage(`/${command.name} `);

        closeAutocomplete();

        const refocus = () => {
            if (composerRef.current) {
                try {
                    composerRef.current.focus({ preventScroll: true });
                } catch {
                    composerRef.current.focus();
                }
                composerRef.current.setSelection(composerRef.current.getValue().length, composerRef.current.getValue().length);
            }
        };

        requestAnimationFrame(() => {
            refocus();
            requestAnimationFrame(refocus);
        });
        setTimeout(refocus, 60);
    };

    React.useEffect(() => {
        if (!active || !currentSessionId || isMobile) return;
        // Focusing forces layout. Right after a session switch the layout is
        // dirty from the whole timeline mounting, so the focus call would pay
        // for that layout inside the commit; a frame later it is nearly free.
        const frame = window.requestAnimationFrame(() => {
            composerRef.current?.focus();
        });
        return () => window.cancelAnimationFrame(frame);
    }, [active, currentSessionId, isMobile]);

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

    // Mention paths are shown relative to the project the chat searches.
    const toMentionPath = React.useCallback(
        (absolutePath: string) => toProjectRelativeMentionPath(absolutePath, chatSearchDirectory || ""),
        [chatSearchDirectory],
    );

    const addVSCodeDroppedUrisAsMentions = React.useCallback((uris: string[]) => {
        if (uris.length === 0) return;

        const paths = uris
            .map((entry) => normalizeDroppedPath(entry))
            .map((entry) => toMentionPath(entry))
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
    }, [setPendingInputText, t, toMentionPath]);

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
            const textarea = composerRef.current;
            const currentMessage = messageRef.current;
            if (textarea) {
                const { start: pos, end } = textarea.getSelection();
                const before = currentMessage.slice(0, pos);
                const after = currentMessage.slice(end);
                const needSpaceBefore = before.length > 0 && !/\s$/.test(before);
                const needSpaceAfter = after.length > 0 && !/^\s/.test(after);
                const insert = `${needSpaceBefore ? ' ' : ''}${mention}${needSpaceAfter ? ' ' : ''}`;
                // Insert through the editor rather than setMessage: an editor
                // dispatch places the caret right after the mention, while the
                // external-rewrite path would send it to the end of the
                // message and pin the scroll to the bottom.
                textarea.replaceRange(pos, end, insert);
                cursorPosRef.current = pos + insert.length;
                textarea.focus();
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
            let attached = false;
            for (const file of files) {
                try {
                    attached = (await addAttachedFile(file)) || attached;
                } catch (error) {
                    console.error('File attach failed', error);
                }
            }
            if (!attached) toast.error(t('chat.chatInput.toast.attachFileFailed'));
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
        let attached = false;

        for (const file of list) {
            try {
                attached = (await addAttachedFile(file)) || attached;
            } catch (error) {
                console.error('File attach failed', error);
            }
        }
        if (list.length > 0 && !attached) {
            toast.error(t('chat.chatInput.toast.attachFileFailed'));
        }
    }, [addAttachedFile, t]);

    const handleVSCodePickFiles = React.useCallback(async () => {
        try {
            const data = (await vscodeApi?.pickFiles?.({ extensions: ACCEPTED_ATTACHMENT_EXTENSIONS })) as {
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
    const showLinearPicker = Boolean(runtimeLinear) && !isVSCode;
    // The work-status panel carries the agent's todos and the changed-file
    // count, but only on the desktop/web layout — VS Code and mobile have no
    // panel, so these keep their place above the composer there.
    const composerStatusExtrasEnabled = isVSCode || isMobile;
    const showDraftTargetSelectors = newSessionDraftOpen && !isVSCode;

    // Which project and directory a new session will target.
    const {
        projects: draftProjects,
        selectedDraftProject,
        draftProjectLabel,
        selectedDraftDirectory,
        selectedDraftBranchLabel,
        selectedDraftBranchIsKnown,
        selectedDraftDirectoryHasUncommittedChanges,
        projectRootBranchOption,
        worktreeBranchOptions,
        draftBranchItems,
        shouldShowDraftBranchSelector,
        handleDraftProjectChange,
        handleDraftDirectoryChange,
    } = useDraftTarget(showDraftTargetSelectors);

    const chatSurfaceMode = useChatSurfaceMode();
    const isMiniChatSurface = chatSurfaceMode === 'mini-chat';
    const showDesktopDraftPresentation = (newSessionDraftOpen || draftPresentationExiting)
        && !isDesktopExpanded
        && !isMobile
        && !isVSCode
        && !isMiniChatSurface;
    const draftPresentationClassName = cn(
        'transition-opacity duration-[120ms] ease-out motion-reduce:transition-none',
        draftPresentationExiting && 'pointer-events-none opacity-0',
    );

    const hasPendingChanges = React.useMemo(() => {
        if (isMiniChatSurface) {
            return false;
        }
        if (isGitRepo !== true || !currentGitStatus || currentGitStatus.isClean) {
            return false;
        }
        return extractGitChangedFiles(currentGitStatus.files, currentGitStatus.diffStats, currentDirectory).length > 0;
    }, [currentDirectory, currentGitStatus, isGitRepo, isMiniChatSurface]);


    React.useEffect(() => {
        if (!showDraftTargetSelectors || !selectedDraftProject || selectedDraftProject.kind === 'chat' || !selectedDraftDirectory) {
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


    // Mobile pill composer: the collapse/expand state machine and the
    // platform corrections that keep it from fighting the soft keyboard.
    const mobileShell = useMobileComposerShell({
        isMobile,
        editorRef: composerRef,
        formRef: composerFormRef,
        setExpandedInput,
        // The pill exists to buy screen back from the soft keyboard. A tablet
        // has the room regardless, and with a hardware keyboard there is no
        // soft keyboard to buy it back from — keep the real composer up.
        alwaysExpanded: hasHardwareKeyboard || isTabletLayout,
        holders: {
            controlsPanelOpen: Boolean(mobileControlsPanel),
            attachMenuOpen: mobileAttachMenuOpen,
            draftPickerOpen: mobileDraftPicker !== null,
            issuePickerOpen,
            prPickerOpen,
            linearPickerOpen,
            isDragging,
        },
    });
    const mobileComposerExpanded = mobileShell.expanded;
    const mobileTextareaFocused = mobileShell.focused;


    const applyAssistSuggestion = React.useCallback((text: string) => {
        setMessage(text);
        if (isMobile && !mobileComposerExpanded) {
            mobileShell.expand();
        } else {
            requestAnimationFrame(() => composerRef.current?.focus());
        }
    }, [isMobile, mobileComposerExpanded, mobileShell]);


    const handleMobileNewSession = React.useCallback(() => {
        if (newSessionDraftOpen) return;
        openNewSessionDraft(currentDirectory ? { directoryOverride: currentDirectory } : undefined);
    }, [newSessionDraftOpen, openNewSessionDraft, currentDirectory]);

    /** The dictation engine listens for this globally; the composer only asks. */
    const toggleDictation = React.useCallback(() => {
        window.dispatchEvent(new CustomEvent('openchamber:dictation-toggle'));
    }, []);

    const openMobileAttachSheet = React.useCallback(() => {
        // Same order as handleOpenMobilePanel: mark the sheet open BEFORE the
        // blur so the collapse watcher sees an overlay when the keyboard-close
        // lands. The trigger button blocks the tap's own focus transfer, so
        // the keyboard must be dismissed explicitly here.
        setMobileAttachMenuOpen(true);
        composerRef.current?.blur();
    }, []);


    // Reset the picker search whenever a draft picker sheet opens/closes.
    React.useEffect(() => {
        setMobileDraftPickerQuery('');
    }, [mobileDraftPicker]);

    // Mobile browsers pan the visual viewport instead of resizing the layout,
    // so the composer form is pinned to it explicitly.
    useMobileViewportPin({
        isMobile,
        isFullscreen: isMobileExpanded,
        isDraftScreen: newSessionDraftOpen,
        isFocused: mobileTextareaFocused,
        formRef: composerFormRef,
        editorRef: composerRef,
    });

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
            return draftPermissionAutoAcceptEnabled;
        }
        return state.isSessionAutoAccepting(permissionScopeSessionId);
    });
    const isPermissionAutoAcceptInteractive = Boolean(permissionScopeSessionId || newSessionDraftOpen);

    const handlePermissionAutoAcceptToggle = React.useCallback(() => {
        togglePermissionAutoAccept({
            permissionScopeSessionId,
            newSessionDraftOpen,
            draftPermissionAutoAcceptEnabled,
            permissionAutoAcceptEnabled,
            setDraftPermissionAutoAcceptEnabled,
            setSessionAutoAccept,
            onOpenSessionFirst: () => toast.error(t('chat.chatInput.toast.openSessionFirst')),
            onToggleFailed: () => toast.error(t('chat.chatInput.toast.togglePermissionAutoAcceptFailed')),
        });
    }, [
        draftPermissionAutoAcceptEnabled,
        newSessionDraftOpen,
        permissionAutoAcceptEnabled,
        permissionScopeSessionId,
        setDraftPermissionAutoAcceptEnabled,
        setSessionAutoAccept,
        t,
    ]);

    useKeybind('toggle_permission_auto_accept', () => {
        if (!isPermissionAutoAcceptInteractive) return false;
        handlePermissionAutoAcceptToggle();
    });

    // Acknowledging the abort record is what lets the working chip resume for
    // the next run; the old "Aborted" banner that used to accompany it is gone.
    React.useEffect(() => {
        const pendingAbort = Boolean(abortPromptSessionId) && abortPromptSessionId === currentSessionId;
        if (!prevWasAbortedRef.current && pendingAbort && currentSessionId) {
            acknowledgeSessionAbort(currentSessionId);
        }
        prevWasAbortedRef.current = pendingAbort;
    }, [abortPromptSessionId, acknowledgeSessionAbort, currentSessionId]);

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
            {showDesktopDraftPresentation ? (
                <div className={cn('chat-input-column mb-7 text-center', draftPresentationClassName)}>
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
                {hasDrafts ? (
                    <ComposerContextChips
                        draftTarget={inlineDraftTarget}
                        colors={currentTheme.colors}
                    />
                ) : null}

                {linkedIssue && !isVSCode ? (
                    <LinkedReferenceRow
                        numberLabel={`#${linkedIssue.number}`}
                        title={linkedIssue.title}
                        url={linkedIssue.url}
                        author={linkedIssue.author}
                        openInBrowserLabel={t('chat.chatInput.linked.issue.openInBrowserAria')}
                        removeLabel={t('chat.chatInput.linked.issue.removeAria')}
                        onReopenPicker={() => setIssuePickerOpen(true)}
                        onRemove={() => setLinkedIssue(null)}
                    />
                ) : null}
                {linkedPr && !isVSCode ? (
                    <LinkedReferenceRow
                        numberLabel={t('chat.chatInput.linked.pr.number', { number: linkedPr.number })}
                        title={linkedPr.title}
                        url={linkedPr.url}
                        author={linkedPr.author}
                        branches={linkedPr.head && linkedPr.base ? { head: linkedPr.head, base: linkedPr.base } : undefined}
                        openInBrowserLabel={t('chat.chatInput.linked.pr.openInBrowserAria')}
                        removeLabel={t('chat.chatInput.linked.pr.removeAria')}
                        onReopenPicker={() => setPrPickerOpen(true)}
                        onRemove={() => setLinkedPr(null)}
                    />
                ) : null}
                {linkedLinearIssue && !isVSCode ? (
                    <LinkedReferenceRow
                        numberLabel={linkedLinearIssue.identifier}
                        title={linkedLinearIssue.title}
                        url={linkedLinearIssue.url}
                        author={linkedLinearIssue.author}
                        openInBrowserLabel={t('chat.chatInput.linked.linearIssue.openInBrowserAria')}
                        removeLabel={t('chat.chatInput.linked.linearIssue.removeAria')}
                        onReopenPicker={() => setLinearPickerOpen(true)}
                        onRemove={() => setLinkedLinearIssue(null)}
                    />
                ) : null}
                <RevertedMessageDock
                    sessionId={currentSessionId}
                    directory={currentSessionDirectoryForSync ?? currentDirectory}
                />
                <MemoComposerStatusBar
                    showTodos={composerStatusExtrasEnabled}
                    leftAccessory={!composerStatusExtrasEnabled || newSessionDraftOpen || !hasPendingChanges
                        ? null
                        : <PendingChangesBar />}
                />
                {!isMobile && (showDraftTargetSelectors || draftPresentationExiting) && selectedDraftProject ? (
                    <div className={draftPresentationClassName}>
                        <DraftTargetSelectors
                            projects={draftProjects}
                            selectedProject={selectedDraftProject}
                            selectedDirectory={selectedDraftDirectory}
                            selectedBranchLabel={selectedDraftBranchLabel}
                            selectedBranchIsKnown={selectedDraftBranchIsKnown}
                            hasUncommittedChanges={selectedDraftDirectoryHasUncommittedChanges}
                            projectRootBranchOption={projectRootBranchOption}
                            worktreeBranchOptions={worktreeBranchOptions}
                            branchItems={draftBranchItems}
                            showBranchSelector={shouldShowDraftBranchSelector}
                            onProjectChange={handleDraftProjectChange}
                            onDirectoryChange={handleDraftDirectoryChange}
                            theme={currentTheme}
                        />
                    </div>
                ) : null}
                {isMobile && showDraftTargetSelectors && selectedDraftProject ? (
                    <MobileDraftTargetTriggers
                        selectedProject={selectedDraftProject}
                        selectedBranchLabel={selectedDraftBranchLabel}
                        hasUncommittedChanges={selectedDraftDirectoryHasUncommittedChanges}
                        showBranchSelector={shouldShowDraftBranchSelector}
                        theme={currentTheme}
                        onOpenPicker={setMobileDraftPicker}
                    />
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
                    <MobilePillComposer
                        message={message}
                        sessionId={currentSessionId}
                        directory={currentSessionDirectoryForSync ?? currentDirectory}
                        newSessionDraftOpen={newSessionDraftOpen}
                        hasContent={Boolean(hasContent)}
                        isVSCode={isVSCode}
                        canAbort={canAbort}
                        footerIconButtonClass={footerIconButtonClass}
                        iconSizeClass={iconSizeClass}
                        stopIconSizeClass={stopIconSizeClass}
                        theme={currentTheme}
                        onExpand={mobileShell.expand}
                        onApplySuggestion={applyAssistSuggestion}
                        onNewSession={handleMobileNewSession}
                        onPickLocalFiles={handlePickLocalFiles}
                        onOpenIssuePicker={openIssuePicker}
                        onOpenPrPicker={openPrPicker}
                        showLinearPicker={showLinearPicker}
                        onOpenLinearPicker={openLinearPicker}
                        onOpenAttachSheet={openMobileAttachSheet}
                        onStartDictation={toggleDictation}
                        onAbort={handleAbort}
                    />
                ) : (
                <>
                <SessionGoalRow
                    sessionId={currentSessionId}
                    directory={currentSessionDirectoryForSync ?? currentDirectory}
                    className="mb-1.5"
                />
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
                        "shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]",
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

                    <ComposerAutocompletePopups
                        open={openAutocomplete}
                        query={autocompleteQuery}
                        overlayPosition={isDesktopExpanded ? autocompleteOverlayPosition : null}
                        commandRef={commandRef}
                        skillRef={skillRef}
                        snippetRef={snippetRef}
                        mentionRef={mentionRef}
                        onCommandSelect={handleCommandSelect}
                        onSkillSelect={handleSkillSelect}
                        onSnippetSelect={handleSnippetSelect}
                        onFileSelect={handleFileSelect}
                        onAgentSelect={handleAgentSelect}
                        onClose={closeAutocomplete}
                    />
                    {/* Positioning context for the dictation overlay: covers the
                        text area + footer exactly. */}
                    <div className={cn('relative flex flex-col', isComposerExpanded && 'flex-1 min-h-0')}>
                    <div className={cn("overflow-hidden", isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}>
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
                        <div
                            className={cn("relative overflow-hidden", isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}
                            onDragEnter={handleDragEnter}
                            onDragOver={handleDragOver}
                            onDropCapture={handleDropCapture}
                            onDrop={handleDrop}
                            onDragEnd={handleDragEnd}
                            style={dictationContentHeight !== null
                                ? { minHeight: `${dictationContentHeight}px` }
                                : undefined}
                        >
                            <ComposerEditor
                                ref={composerRef}
                                viewStore={composerViewStore}
                                data-testid="chat-input"
                                value={message}
                                languageContext={languageContext}
                                onChange={handleComposerChange}
                                onKeyDown={(event) => {
                                    // Every interception branch calls
                                    // preventDefault, so the event itself
                                    // reports whether the composer consumed it.
                                    handleKeyDown(event);
                                    return event.defaultPrevented;
                                }}
                                onPaste={handlePaste}
                                onSelectionChange={(selection) => {
                                    cursorPosRef.current = selection.start;
                                    updateAutocompleteOverlayPosition();
                                }}
                                onFocus={mobileShell.onEditorFocus}
                                onBlur={mobileShell.onEditorBlur}
                                placeholder={isBtwActive
                                    ? t('chat.btw.mainComposerPlaceholder')
                                    : currentSessionId || newSessionDraftOpen
                                        ? inputMode === 'shell'
                                            ? t('chat.chatInput.placeholder.shell')
                                            : t(useCompactChatPlaceholder ? 'chat.chatInput.placeholder.chatCompact' : 'chat.chatInput.placeholder.chat')
                                        : t('chat.chatInput.placeholder.selectSession')}
                                editable={Boolean(currentSessionId || newSessionDraftOpen)}
                                autoCorrect={composerAutoCorrect({ isMobile })}
                                autoCapitalize={isMobile ? 'sentences' : 'none'}
                                spellCheck={isMobile || inputSpellcheckEnabled}
                                fillContainer={isComposerExpanded}
                                maxLines={isMobile ? MAX_MOBILE_COMPOSER_LINES : MAX_VISIBLE_COMPOSER_LINES}
                                boundSelector={isMobile ? '[data-composer-bound]' : undefined}
                                boundGapPx={MOBILE_COMPOSER_BOUND_GAP_PX}
                                className={cn(
                                    'min-h-[52px] px-3 relative z-10',
                                    isComposerExpanded
                                        ? cn('h-full min-h-0', isMobile ? 'py-2.5' : 'py-4')
                                        : isMobile
                                            ? 'py-2.5'
                                            : 'pt-4 pb-2',
                                    inputMode === 'shell' ? 'font-mono' : 'typography-markdown md:typography-ui-label',
                                )}
                            />
                        </div>
                    </div>
                    <ComposerFooter
                        isMobile={isMobile}
                        isVSCode={isVSCode}
                        sessionId={currentSessionId}
                        directory={currentSessionDirectoryForSync ?? currentDirectory}
                        newSessionDraftOpen={newSessionDraftOpen}
                        messageLength={message.length}
                        radius={chatInputRadius}
                        footerPaddingClass={footerPaddingClass}
                        footerGapClass={footerGapClass}
                        footerIconButtonClass={footerIconButtonClass}
                        iconSizeClass={iconSizeClass}
                        sendIconSizeClass={sendIconSizeClass}
                        stopIconSizeClass={stopIconSizeClass}
                        canSend={canSend}
                        canAbort={canAbort}
                        hasContent={Boolean(hasContent)}
                        isExpandedInput={isExpandedInput}
                        permissionAutoAcceptEnabled={permissionAutoAcceptEnabled}
                        isPermissionAutoAcceptInteractive={isPermissionAutoAcceptInteractive}
                        dictationActive={mobileShell.dictationActive}
                        onOpenSettings={onOpenSettings}
                        onPickLocalFiles={handlePickLocalFiles}
                        onOpenIssuePicker={openIssuePicker}
                        onOpenPrPicker={openPrPicker}
                        showLinearPicker={showLinearPicker}
                        onOpenLinearPicker={openLinearPicker}
                        onOpenAttachSheet={openMobileAttachSheet}
                        onToggleExpandedInput={handleToggleExpandedInput}
                        onTogglePermissionAutoAccept={handlePermissionAutoAcceptToggle}
                        onPrimaryAction={handlePrimaryAction}
                        onQueueMessage={handleQueueMessage}
                        onAbort={handleAbort}
                        onStartDictation={toggleDictation}
                        onDictationInsert={handleDictationInsert}
                        onDictationInsertAndSend={handleDictationInsertAndSend}
                        onDictationContentHeightChange={handleDictationContentHeightChange}
                    />
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
                        onActiveChange={mobileShell.onDictationActiveChange}
                        onContentHeightChange={handleDictationContentHeightChange}
                        renderTrigger={false}
                    />
                ) : null}
                </div>
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
            {showDesktopDraftPresentation ? (
                <DraftPresetChips
                    onSubmit={(starter) => submitPresetPrompt(starter.submitText, starter.ref.type)}
                    className={cn('chat-input-column mt-4', draftPresentationClassName)}
                />
            ) : null}
            {currentSessionId ? <BtwPanel parentSessionId={currentSessionId} panel={btwPanel} /> : null}
        </form>

        {/* Issue Picker Dialog */}
        <GitHubIssuePickerDialog
            open={issuePickerOpen}
            onOpenChange={setIssuePickerOpen}
            mode="select"
            onSelect={(issue) => {
                setLinkedIssue(issue);
                setLinkedPr(null);
                setLinkedLinearIssue(null);
            }}
        />
        <GitHubPrPickerDialog
            open={prPickerOpen}
            onOpenChange={setPrPickerOpen}
            onSelect={(pr) => {
                setLinkedPr(pr);
                setLinkedIssue(null);
                setLinkedLinearIssue(null);
            }}
        />
        <LinearIssuePickerDialog
            open={linearPickerOpen}
            onOpenChange={setLinearPickerOpen}
            mode="select"
            onSelect={(issue) => {
                setLinkedLinearIssue(issue);
                setLinkedIssue(null);
                setLinkedPr(null);
            }}
        />
        <ReviewFlowDialog
            open={reviewDialogOpen}
            onOpenChange={setReviewDialogOpen}
            projectDirectory={currentSessionDirectoryForSync ?? currentDirectory ?? null}
            submitting={reviewFlowSubmitting}
            onConfirm={handleStartReviewFlow}
        />
        {attachmentPreviewMounted ? (
            <React.Suspense fallback={null}>
                <ToolOutputDialog
                    popup={attachmentPreview}
                    onOpenChange={handleAttachmentPreviewOpenChange}
                    isMobile={isMobile}
                />
            </React.Suspense>
        ) : null}

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
            accept={ATTACHMENT_ACCEPT}
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
                            mobileShell.cancelOverlayCloseRestore();
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
                            mobileShell.skipNextOverlayCloseRestore();
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
                            mobileShell.skipNextOverlayCloseRestore();
                            setMobileAttachMenuOpen(false);
                            requestAnimationFrame(openPrPicker);
                        }}
                    >
                        <Icon name="git-pull-request" className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                        {t('chat.chatInput.actions.linkGithubPr')}
                    </button>
                    {showLinearPicker ? (
                        <button
                            type="button"
                            className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-3 text-left typography-ui-label hover:bg-[var(--interactive-hover)]"
                            onClick={() => {
                                mobileShell.skipNextOverlayCloseRestore();
                                setMobileAttachMenuOpen(false);
                                requestAnimationFrame(openLinearPicker);
                            }}
                        >
                            <Icon name="linear" className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                            {t('chat.chatInput.actions.linkLinearIssue')}
                        </button>
                    ) : null}
                </div>
            </MobileOverlayPanel>
        ) : null}

        {/* Mobile draft target pickers: bottom sheets replacing the inline
            project/branch Selects (which desktop keeps). */}
        {isMobile && showDraftTargetSelectors && selectedDraftProject ? (
            <MobileDraftTargetSheets
                projects={draftProjects}
                selectedProject={selectedDraftProject}
                selectedDirectory={selectedDraftDirectory}
                selectedBranchLabel={selectedDraftBranchLabel}
                selectedBranchIsKnown={selectedDraftBranchIsKnown}
                hasUncommittedChanges={selectedDraftDirectoryHasUncommittedChanges}
                projectRootBranchOption={projectRootBranchOption}
                worktreeBranchOptions={worktreeBranchOptions}
                branchItems={draftBranchItems}
                showBranchSelector={shouldShowDraftBranchSelector}
                onProjectChange={handleDraftProjectChange}
                onDirectoryChange={handleDraftDirectoryChange}
                theme={currentTheme}
                openPicker={mobileDraftPicker}
                onOpenPickerChange={setMobileDraftPicker}
                query={mobileDraftPickerQuery}
                onQueryChange={setMobileDraftPickerQuery}
            />
        ) : null}
        </>
    );
};

ChatInputComponent.displayName = 'ChatInput';

export const ChatInput = React.memo(ChatInputComponent);

import React from 'react';
import { formatChangeRequestReference } from '@/lib/source-control/identity';
import { ComposerDictation } from '@/components/dictation/ComposerDictation';
// sessionStore removed — currentSessionId comes from useSessionUIStore
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { isServerOwnedMessageQueue, createMessageQueueTarget, getMessageQueueKey, useMessageQueueStore, type QueuedContextPart, type QueuedMessage } from '@/stores/messageQueueStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { prepareLocalAttachments, useDraftAttachedFiles, useInputStore, type SyntheticContextPart } from '@/sync/input-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { openParallelComposer } from '@/lib/multirun/openParallelComposer';
import { useParallelComposer } from './composer/parallel/useParallelComposer';
import { ParallelComposerStrip } from './composer/parallel/ParallelComposerStrip';
import {
    ACCEPTED_ATTACHMENT_EXTENSIONS,
    ATTACHMENT_ACCEPT,
    getUnsupportedAttachmentInputs,
    isDocumentAttachmentFilename,
    type AttachmentInputModality,
} from '@/sync/attachment-files';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import * as sessionActions from '@/sync/session-actions';
// Guest surfaces load on demand: VS Code and mobile never mount them, and the
// composer must not pay for the guest bridge before an extension is installed.
const GuestAttachDialog = React.lazy(() => import('@/components/layout/GuestAttachDialog').then((module) => ({ default: module.GuestAttachDialog })));
import type { AttachIssueRequest } from '@openchamber/sdk';
import { getInlineCommentDraftKey, useInlineCommentDraftStore, type InlineCommentDraft, type InlineCommentDraftTarget } from '@/stores/useInlineCommentDraftStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { startReviewFlow } from '@/lib/reviewFlow';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
    createChatDraftIdentity,
    getChatDraftIdentityKey,
    clearChatDraft,
    readChatDraft,
    type ChatDraftIdentity,
    type ChatDraftSnapshot,
} from '@/lib/chatDraftPersistence';
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { ReviewFlowDialog, type ReviewFlowExecution } from '@/components/session/ReviewFlowDialog';
import { BtwPanel } from './btw/BtwPanel';
import { useBtwPanelState } from './btw/useBtwPanelState';
import { btwModelAvailability, resolveBtwSelection, useBtwStore } from '@/stores/useBtwStore';
import { wasPromotedBtwSession } from '@/lib/sessionBtwMetadata';
import { buildBtwSyntheticTexts, preparePendingBtwSend, startBtwSession } from '@/lib/btw';
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
import { shouldSubmitEnter } from './composer/keyboardPolicy';
import { getDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { useChatColumnActions, useChatColumnExpandedInput, useChatColumnSession, type ChatColumnSession } from './chatColumnSession';
import { usePinnedComposerSelection } from './pinnedComposerSelection';
import { useChatSurfaceMode } from './useChatSurfaceMode';
import { MobileAgentButton } from './MobileAgentButton';
import { MobileModelButton } from './MobileModelButton';
import { useSessionActivity } from '@/hooks/useSessionActivity';
import { toast } from '@/components/ui';
// useMessageStore removed — messages now come from sync system
import { isVSCodeRuntime } from '@/lib/desktop';
import { useTabletLayout } from '@/lib/device';
import { useHardwareKeyboard } from '@/lib/hardwareKeyboard';
import { isCapacitorApp } from '@/lib/platform';
import { isIMECompositionEvent } from '@/lib/ime';
import { setNativeImagePasteEnabled, subscribeToNativeImagePastes } from '@/lib/nativeImagePaste';
import { getCycledPrimaryAgentName, type MobileControlsPanel } from './mobileControlsUtils';
import { isAutoModel } from '@/lib/routing/autoModel';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { ReferencePickerDialog } from '@/components/references/ReferencePickerDialog';
import { useAttachReferences } from '@/components/references/useAttachReferences';
import { useRepositoryReferenceProvider } from '@/components/references/referenceSources';
import {
    composerReferenceKey,
    toContextReference,
    toLinkedIssue,
    withComposerReferences,
    withoutComposerReference,
    type ComposerReference,
} from './composer/composerReferences';
import { usePendingComposerReferences } from './composer/pendingComposerReferences';
import { postLinearSessionStarted } from '@/lib/linearSessionStatus';
import { Icon } from "@/components/icon/Icon";
import { DraftPresetChips } from './DraftPresetChips';
import { useChatSearchDirectory } from '@/hooks/useChatSearchDirectory';
import { useGuestAttachItems, useGuestCommands } from '@/hooks/useGuestSurfaces';
import { useGuestDialogStore } from '@/lib/guests/dialog-store';
import { useGuestItemStore } from '@/lib/guests/item-store';
import { runGuestCommand } from '@/lib/guests/run-command';
import { useGuestsStore } from '@/lib/guests/store';
import { isGuestActive } from '@/lib/guests/capabilities';
import { routeGuestSlashCommand } from './composer/submit/guestCommands';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import { opencodeClient, type SkillMentions } from '@/lib/opencode/client';
import { buildSkillMentionInstruction } from '@/lib/skillMentionInstruction';
import { useGitStore } from '@/stores/useGitStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { selectSkillsForDirectory, useSkillsStore } from '@/stores/useSkillsStore';
import { selectCommandsForDirectory, useCommandsStore } from '@/stores/useCommandsStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { usePermissionStore } from '@/stores/permissionStore';
import { cyclePermissionMode } from './permissionAutoAccept';
import { displayedPermissionMode, nextPermissionMode } from '@/stores/utils/permissionAutoAccept';
import { selectAutoReady, selectSafetyNetAvailable, useRoutingStore } from '@/stores/useRoutingStore';
import { useKeybind } from '@/hooks/useKeybind';
import { hasOpenDropdown } from '@/hooks/keyboard-shortcut-dom';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
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
    renameFileForAttachmentCitation,
} from './attachmentCitations';
import {
    createPastedContextFile,
    isLargePlainTextPaste,
    LargeTextPasteGesture,
    type LargeTextPasteCandidate,
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
import { useComposerHeightLimit } from './composer/editor/useComposerHeightLimit';
import { usePendingComposerText } from './composer/state/usePendingComposerText';
import { createComposerEditorViewStore } from './composer/editor/viewStore';
import { composerAutoCorrect } from './composer/editor/autocorrect';
import {
    appendInlineText,
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
import {
    INLINE_SERVER_ATTACHMENT_ID_PREFIX,
    filterMissingInlineAttachments,
} from './composer/attachments/inlineMentionAttachments';
import { buildComposerContext, buildOutgoingMessage, expandCommentSnippets, selectComposerQueue } from './composer/submit/buildOutgoingMessage';
import {
    buildCommandVariables,
    canRunCommand,
    findMagicPromptCommand,
    planLocalSlashCommand,
} from './composer/submit/slashCommands';
import { runForkCommand } from './composer/submit/forkCommand';
import { useAutocompletePosition } from './composer/state/useAutocompletePosition';
import { useMessageHistory } from './composer/state/useMessageHistory';
import { useComposerDraft } from './composer/state/useComposerDraft';
import { useDictationOrigin } from './composer/state/useDictationOrigin';
import { useDraftTarget } from './composer/state/useDraftTarget';
import { useMobileComposerShell } from './composer/state/useMobileComposerShell';
import { useMobileViewportPin } from './composer/state/useMobileViewportPin';
import { MobileCommentComposer } from './composer/comment/MobileCommentComposer';
import { useMobileCommentComposerController } from './composer/comment/MobileCommentComposerContext';
import { useMobileCommentComposerMode } from './composer/comment/useMobileCommentComposerMode';
import {
    DraftTargetSelectors,
    MobileDraftTargetSheets,
    MobileDraftTargetTriggers,
} from './composer/ui/DraftTargetSelectors';
import { NewSpaceDialog } from '@/components/session/spaces/NewSpaceDialog';
import { NewWorktreeDialog } from '@/components/session/NewWorktreeDialog';
import { isSpaceCreationRequest } from '@/lib/spaces/space-creation';
import { spaceModelRefusal } from '@/lib/spaces/space-model-access';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { isDraftSendWaiting, subscribeDraftSendWaiting } from '@/lib/worktrees/pendingDraftWorktree';
import { ComposerAutocompletePopups } from './composer/ui/ComposerAutocompletePopups';
import { ComposerFooter } from './composer/ui/ComposerFooter';
import { MobilePillComposer } from './composer/ui/MobilePillComposer';
import { ComposerContextChips } from './composer/ui/ComposerContextChips';
import { LinkedReferenceRow } from './composer/ui/LinkedReferenceRow';
import { RevertedMessageDock } from './composer/ui/RevertedMessageDock';
import { SessionSuggestionChip } from '@/components/chat/SessionSuggestionChip';
import { SessionDoneHintRow } from '@/components/chat/SessionDoneHintRow';
import { SessionReviewHintRow } from '@/components/chat/SessionReviewHintRow';
import { BackgroundShellsStrip } from '@/components/chat/BackgroundShellsStrip';
import { WorktreeSetupStrip } from '@/components/chat/WorktreeSetupStrip';
import { useWorktreeBootstrapPending } from '@/hooks/useWorktreeBootstrapPending';
import { FormDock } from '@/components/chat/FormDock';
import { PermissionDock } from '@/components/chat/PermissionDock';
import { SessionGoalRow } from '@/components/chat/SessionGoalRow';
import {
    createInputHistoryIdentity,
    selectInputHistoryEntries,
    type InputHistorySubmission,
    useInputHistoryStore,
} from '@/stores/useInputHistoryStore';
import {
    buildChatInputHistorySubmissions,
    buildInputHistoryNavigatorIdentity,
    mapInputHistoryEntriesToValues,
    mergeSessionInputHistory,
} from './inputHistory';
import { useScopedBlockingForms, useScopedBlockingPermissions, useUserMessageHistory } from '@/sync/sync-context';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';

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

const getFileMentionInputSourceForInsertedText = (insertedText: string): FileMentionAutocompleteInputSource => (
    insertedText.includes('@') ? 'paste' : 'manual'
);

/**
 * Skills the user named with `$name`. Matched against the registry's exact
 * casing, since the name is echoed back to the model as a skill to load.
 */
const collectInlineSkillMentions = (text: string, skillNames: Set<string>): string[] =>
    collectKnownTokenNames(text, '$', skillNames, 'exact');

/** Which reference picker is open, and for GitHub on which tab. */
type ReferencePickerState = { source: 'github'; kind?: 'issue' | 'pull' } | { source: 'linear' } | null;

/**
 * Record what a session was pointed at, so the work-status panel can show it
 * as a context source long after the message scrolled away. A snapshot only —
 * never re-fetched, never authoritative. Failures are swallowed: the message
 * went out (or was queued), and a missing bookkeeping entry must not surface
 * as an error.
 */
const recordLinkedReferences = (
    sessionId: string,
    directory: Parameters<typeof sessionActions.addLinkedIssues>[1],
    references: readonly ComposerReference[],
) => {
    if (references.length === 0) return;
    const linkedAt = Date.now();
    void sessionActions.addLinkedIssues(
        sessionId,
        directory,
        references.map((reference) => toLinkedIssue(reference, linkedAt)),
    ).catch(() => undefined);
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

// A new Chat's working directory moves from the Chats root to a prepared
// folder on the first keystroke. Its composer text keys on the Chats bucket
// instead, so that move neither clears what was typed nor leaves it behind
// under the root for the next new Chat to show.
const NEW_CHAT_DRAFT_DIRECTORY = CHAT_DRAFT_PROJECT_ID;

const resolveChatDraftIdentity = (column: ChatColumnSession | null): ChatDraftIdentity | null => {
    const sessionState = useSessionUIStore.getState();
    const sessionId = column ? column.sessionId : sessionState.currentSessionId;
    const draft = sessionState.newSessionDraft;
    const newSessionDirectory = draft?.open
        ? draft.target === 'chat' ? NEW_CHAT_DRAFT_DIRECTORY : draft.bootstrapPendingDirectory ?? draft.directoryOverride
        : null;
    const directory = sessionId
        ? sessionState.getDirectoryForSession(sessionId) ?? (column ? column.directory : sessionState.currentSessionDirectory)
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
    // The session this composer belongs to: its column's (see
    // chatColumnSession.ts); outside a column it follows the live selection.
    const chatColumnSession = useChatColumnSession();
    const { pinned: columnPinned, openTimelineDialog, focusInput: focusColumnInput } = useChatColumnActions();
    // Track if we restored a draft on mount (for text selection)
    const initialDraftRef = React.useRef<string | null>(null);
    const initialDraftIdentityRef = React.useRef<ChatDraftIdentity | null>(null);
    const initialDraftSnapshotRef = React.useRef<ChatDraftSnapshot>({ text: '', confirmedMentions: new Set() });
    const [message, setMessage] = React.useState(() => {
        const identity = resolveChatDraftIdentity(chatColumnSession);
        const snapshot = readChatDraft(identity);
        initialDraftIdentityRef.current = identity;
        initialDraftSnapshotRef.current = snapshot;
        if (snapshot.text) {
            initialDraftRef.current = snapshot.text;
        }
        return snapshot.text;
    });
    const confirmedMentionsRef = React.useRef<Set<string>>(initialDraftSnapshotRef.current.confirmedMentions);
    const [storedInputMode, setInputMode] = React.useState<'normal' | 'shell'>('normal');
    const inputModeParentRef = React.useRef<string | null>(null);
    const [isDragging, setIsDragging] = React.useState(false);
    const [isInternalDrag, setIsInternalDrag] = React.useState(false);
    // At most one picker is open at a time; the prompt language decides which.
    const [openAutocomplete, setOpenAutocomplete] = React.useState<AutocompleteKind | null>(null);
    const [autocompleteQuery, setAutocompleteQuery] = React.useState('');
    const closeAutocomplete = React.useCallback(() => setOpenAutocomplete(null), []);
    const [mobileControlsPanel, setMobileControlsPanel] = React.useState<MobileControlsPanel>(null);
    const [mobileAttachMenuOpen, setMobileAttachMenuOpen] = React.useState(false);
    const [mobileDraftPicker, setMobileDraftPicker] = React.useState<'project' | 'branch' | null>(null);
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
    const dictationSendInFlightRef = React.useRef(false);
    const currentChatDraftIdentityRef = React.useRef<ChatDraftIdentity | null>(initialDraftIdentityRef.current);
    const pendingPastedAttachmentFilenamesRef = React.useRef<Set<string>>(new Set());
    const largeTextPasteToastIdRef = React.useRef<string | number | null>(null);
    const largeTextPasteOfferIdRef = React.useRef(0);
    const [largeTextPasteGesture] = React.useState(() => new LargeTextPasteGesture());

    // TODO: port sendMessage to session-actions (complex — creates sessions, handles attachments, etc.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendMessage = React.useRef((...args: any[]) =>
        Promise.resolve((useSessionUIStore.getState().sendMessage as (...a: unknown[]) => unknown)(...args)),
    ).current;
    // Inside the chat column the composer follows the session the timeline is
    // showing (see chatColumnSession.ts); elsewhere it follows the live one.
    const liveSessionId = useSessionUIStore((s) => (chatColumnSession ? null : s.currentSessionId));
    const currentSessionId = chatColumnSession ? chatColumnSession.sessionId : liveSessionId;
    React.useEffect(() => {
        if (inputModeParentRef.current !== null && inputModeParentRef.current !== currentSessionId) {
            setInputMode('normal');
        }
        inputModeParentRef.current = currentSessionId;
    }, [currentSessionId]);
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
    const pendingForms = useScopedBlockingForms(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory ?? undefined);
    const pendingPermissions = useScopedBlockingPermissions(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory ?? undefined);
    const hasPendingPermission = pendingPermissions.length > 0;
    // A pending permission or form owns the dock; the composer is not for sending then.
    const hasPendingForm = pendingForms.length > 0 || hasPendingPermission;
    const btwSessionId = btwPanel.btwSessionId;
    const btwDirectory = btwPanel.btwDirectory;
    const btwComposerSessionId = btwPanel.pending && currentSessionId
        ? `btw-pending:${currentSessionId}`
        : btwSessionId;
    const isBtwActive = Boolean(btwComposerSessionId) && !btwPanel.collapsed;
    const isBtwPanelVisible = Boolean((btwPanel.btwSessionId && btwPanel.btwDirectory) || btwPanel.creating || btwPanel.pending);
    const immediateBtwSubmitRef = React.useRef<{ identity: ChatDraftIdentity; text: string } | null>(null);
    const draftCaretModeRef = React.useRef({ btw: isBtwActive, atEnd: isBtwActive });
    const inputMode = isBtwActive ? 'normal' : storedInputMode;
    // A session promoted out of `/btw` keeps the boundary instructions in its
    // transcript — there is no way to delete a message part — so it has to say
    // they no longer apply.
    const isPromotedBtwSession = wasPromotedBtwSession(btwPanel.parentSession);
    const activeRuntimeKey = getRuntimeKey();
    const isNewChatDraft = useSessionUIStore((s) => (
        !columnPinned && !currentSessionId && Boolean(s.newSessionDraft?.open) && s.newSessionDraft.target === 'chat'
    ));
    const chatDraftIdentity = React.useMemo(
        () => createChatDraftIdentity(
            activeRuntimeKey,
            isNewChatDraft ? NEW_CHAT_DRAFT_DIRECTORY : currentSessionDirectoryForSync ?? currentDirectory,
            isBtwActive ? btwComposerSessionId : currentSessionId,
        ),
        [activeRuntimeKey, btwComposerSessionId, currentDirectory, currentSessionDirectoryForSync, currentSessionId, isBtwActive, isNewChatDraft],
    );
    const claimAttachmentSlot = React.useCallback(() => {
        useInputStore.getState().selectAttachmentDraft(chatDraftIdentity);
    }, [chatDraftIdentity]);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    // The new-session draft is the main chat's; a pinned composer is never on it.
    const newSessionDraftOpen = !columnPinned && Boolean(newSessionDraft?.open);
    const draftPermissionMode = useSessionUIStore((s) => (
        s.newSessionDraft?.open ? s.newSessionDraft.permissionMode : undefined
    ));
    const setNewSessionDraftTarget = useSessionUIStore((s) => s.setNewSessionDraftTarget);
    const setDraftPermissionMode = useSessionUIStore((s) => s.setDraftPermissionMode);
    const prepareChatDraftDirectory = useSessionUIStore((s) => s.prepareChatDraftDirectory);
    const abortPromptSessionId = useSessionUIStore((s) => s.abortPromptSessionId);
    const clearAbortPrompt = useSessionUIStore((s) => s.clearAbortPrompt);
    const attachedFiles = useDraftAttachedFiles(chatDraftIdentity);
    const addAttachedFile = useInputStore((s) => s.addAttachedFile);
    const clearAttachedFiles = useInputStore((s) => s.clearAttachedFiles);
    const saveSessionAgentSelection = useSelectionStore((s) => s.saveSessionAgentSelection);
    const btwModelSelection = useSelectionStore(React.useCallback(
        (s) => btwComposerSessionId ? s.sessionModelSelections.get(btwComposerSessionId) ?? null : null,
        [btwComposerSessionId],
    ));
    const btwAgentSelection = useSelectionStore(React.useCallback(
        (s) => btwComposerSessionId ? s.sessionAgentSelections.get(btwComposerSessionId) ?? null : null,
        [btwComposerSessionId],
    ));
    const consumePendingBtwComposerRequest = useInputStore((s) => s.consumePendingBtwComposerRequest);
    const pendingBtwComposerRequest = useInputStore((s) => s.pendingBtwComposerRequest);
    const pendingPresetSubmit = useInputStore((s) => s.pendingPresetSubmit);
    const setPendingInputText = useInputStore((s) => s.setPendingInputText);
    const pendingGuestIssue = useInputStore((s) => s.pendingGuestIssue);
    const consumePendingGuestIssue = useInputStore((s) => s.consumePendingGuestIssue);
    const pendingComposerReferenceCount = usePendingComposerReferences((s) => s.references.length);

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

    // A pinned column's composer sends with its own selection; the app-wide
    // current model, agent and effort belong to the main chat.
    const pinnedComposerSelection = usePinnedComposerSelection({
        enabled: columnPinned,
        sessionId: currentSessionId,
        directory: currentDirectory ?? null,
    });
    // Pending text and context other parts of the app leave for "the
    // composer" are the main chat's; a pinned composer takes only what was
    // addressed to its session (see input-store `pendingInputTarget`).
    const mailboxTarget = columnPinned ? currentSessionId : null;
    const configProviderId = useConfigStore((state) => state.currentProviderId);
    const configModelId = useConfigStore((state) => state.currentModelId);
    const currentProviderId = pinnedComposerSelection?.model?.providerId ?? configProviderId;
    const currentModelId = pinnedComposerSelection?.model?.modelId ?? configModelId;
    const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
    // Subscribe to both sources read by getModelMetadata so async metadata and provider updates are observed.
    useConfigStore((state) => state.modelsMetadata);
    const providerCatalog = useConfigStore((state) => state.providers);
    const autoReady = useRoutingStore(selectAutoReady);
    const currentModelMetadata = currentProviderId && currentModelId
        ? getModelMetadata(currentProviderId, currentModelId)
        : undefined;
    const configVariant = useConfigStore((state) => state.currentVariant);
    const currentVariant = pinnedComposerSelection ? pinnedComposerSelection.variant ?? undefined : configVariant;
    const currentVariantSelection = useConfigStore((state) => state.currentVariantSelection);
    const configAgentName = useConfigStore((state) => state.currentAgentName);
    const currentAgentName = pinnedComposerSelection?.agent ?? configAgentName;
    const setAgent = useConfigStore((state) => state.setAgent);
    const getVisibleAgents = useConfigStore((state) => state.getVisibleAgents);
    const agents = getVisibleAgents();
    const btwSavedVariant = useSelectionStore(React.useCallback(
        (state) => btwComposerSessionId && btwAgentSelection && btwModelSelection
            ? state.getAgentModelVariantForSession(
                btwComposerSessionId,
                btwAgentSelection,
                btwModelSelection.providerId,
                btwModelSelection.modelId,
            )
            : undefined,
        [btwAgentSelection, btwComposerSessionId, btwModelSelection],
    ));
    const effectiveBtwSelection = resolveBtwSelection({
        agents,
        savedAgent: btwAgentSelection,
        isModelAvailable: btwModelAvailability(providerCatalog, autoReady),
        savedModel: btwModelSelection,
        savedVariant: btwSavedVariant,
        composerModel: currentProviderId && currentModelId ? { providerId: currentProviderId, modelId: currentModelId } : null,
        composerVariant: currentVariantSelection.override === null ? null : currentVariantSelection.override ?? configVariant,
    });
    React.useEffect(() => {
        const { model, agent, variant } = effectiveBtwSelection;
        if (!isBtwActive || !btwComposerSessionId || !model || !agent) return;
        const selections = useSelectionStore.getState();
        if (selections.getSessionModelSelection(btwComposerSessionId)) return;
        selections.saveSessionAgentSelection(btwComposerSessionId, agent);
        selections.saveSessionModelSelection(btwComposerSessionId, model.providerId, model.modelId);
        selections.saveAgentModelForSession(btwComposerSessionId, agent, model.providerId, model.modelId);
        selections.saveAgentModelVariantForSession(btwComposerSessionId, agent, model.providerId, model.modelId, variant);
    }, [btwComposerSessionId, effectiveBtwSelection, isBtwActive]);
    const isMobile = useUIStore((state) => state.isMobile);
    const hasHardwareKeyboard = useHardwareKeyboard();
    const enterToSend = useUIStore((state) => state.enterToSend);
    const enterToSendConfigured = useUIStore((state) => state.enterToSendConfigured);
    const { enabled: isTabletLayout } = useTabletLayout();
    const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);
    const inputBarOffset = useUIStore((state) => state.inputBarOffset);
    const persistChatDraft = useUIStore((state) => state.persistChatDraft);
    const inputSpellcheckEnabled = useUIStore((state) => state.inputSpellcheckEnabled);
    const largeTextPasteBehavior = useUIStore((state) => state.largeTextPasteBehavior);
    const largeTextPasteScope = JSON.stringify([
        activeRuntimeKey, chatDraftIdentity ? getChatDraftIdentityKey(chatDraftIdentity) : null,
        inputMode, largeTextPasteBehavior,
    ]);
    const largeTextPasteScopeRef = React.useRef(largeTextPasteScope);
    React.useLayoutEffect(() => {
        largeTextPasteScopeRef.current = largeTextPasteScope;
        largeTextPasteGesture.invalidate();
        return () => largeTextPasteGesture.invalidate();
    }, [largeTextPasteGesture, largeTextPasteScope]);
    React.useEffect(() => subscribeRuntimeEndpointWillChange(() => largeTextPasteGesture.invalidate()), [largeTextPasteGesture]);

    const getLargeTextPasteScope = React.useCallback(() => (
        JSON.stringify([getRuntimeKey(), largeTextPasteScopeRef.current, useInputStore.getState().attachmentDraftKey])
    ), []);

    const readLargeTextPasteSnapshot = React.useCallback(() => {
        const editor = composerRef.current;
        if (!editor) return null;
        return {
            value: editor.getValue(), selection: editor.getSelection(),
            scope: getLargeTextPasteScope(),
        };
    }, [getLargeTextPasteScope]);
    const { expanded: persistedExpandedInput, setExpanded: setExpandedInput } = useChatColumnExpandedInput();
    const isExpandedInput = !isBtwActive && persistedExpandedInput;
    const { git: runtimeGit, vscode: vscodeApi, linear: runtimeLinear } = useRuntimeAPIs();
    const cycleAgentShortcutOverride = useUIStore((state) => state.shortcutOverrides.cycle_agent);
    const cycleAgentShortcut = React.useMemo(() => (
        getEffectiveShortcutCombo('cycle_agent', cycleAgentShortcutOverride ? { cycle_agent: cycleAgentShortcutOverride } : undefined)
    ), [cycleAgentShortcutOverride]);
    const { currentTheme } = useThemeSystem();
    const chatSearchDirectory = useChatSearchDirectory();
    const ensureGitStatus = useGitStore((state) => state.ensureStatus);
    const fetchGitStatus = useGitStore((state) => state.fetchStatus);
    const clearGitDiffCache = useGitStore((state) => state.clearDiffCache);
    const setSessionMode = usePermissionStore((state) => state.setSessionMode);
    const pendingBtwPermissionMode = useBtwStore(React.useCallback(
        (state) => currentSessionId ? state.byParent[currentSessionId]?.pendingPermissionMode : undefined,
        [currentSessionId],
    ));
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

    // Known slash-invocations (commands + built-ins) and `$` skills, used to
    // highlight matching tokens in the composer, the same way confirmed
    // @files are.
    const availableCommands = useCommandsStore((s) => selectCommandsForDirectory(s, currentDirectory));
    const availableSkills = useSkillsStore((s) => selectSkillsForDirectory(s, currentDirectory));
    const knownSlashNames = React.useMemo(() => {
        const names = new Set<string>([
            'init', 'review', 'undo', 'redo', 'timeline', 'compact', 'fork', 'btw', 'summary', 'workspace-review', 'plan-feature', 'craft-goal', 'schedule-task', 'catch-up', 'debug', 'weigh', 'explore',
        ]);
        if (!isMobile && !isVSCodeRuntime()) names.add('handoff-review');
        for (const command of availableCommands) names.add(command.name.toLowerCase());
        return names;
    }, [availableCommands, isMobile]);
    const knownSkillNames = React.useMemo(
        () => new Set(availableSkills.map((skill) => skill.name.toLowerCase())),
        [availableSkills],
    );

    // Extension slash commands. Built-ins and OpenCode commands are reserved:
    // an extension command with one of those names is ignored.
    const guestCommands = useGuestCommands(knownSlashNames);
    const knownSlashNamesWithGuests = React.useMemo(() => {
        if (guestCommands.length === 0) return knownSlashNames;
        const names = new Set(knownSlashNames);
        for (const entry of guestCommands) names.add(entry.command.name);
        return names;
    }, [guestCommands, knownSlashNames]);

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
        knownSlashNames: knownSlashNamesWithGuests,
        knownSnippetTriggers,
        attachmentFilenames,
        pendingAttachmentFilenames: pendingPastedAttachmentFilenamesRef.current,
        knownSkillNames,
        fileIconVariant: currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
    }), [attachmentFilenames, currentTheme.metadata.variant, inputMode, knownAgentNames, knownSkillNames, knownSlashNamesWithGuests, knownSnippetTriggers]);

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

        for (const token of scanMentions(rawText, confirmedMentionsRef.current)) {
            const mention = resolveInlineFileMention(token.name);
            if (!mention || seenPaths.has(mention.serverPath)) continue;
            seenPaths.add(mention.serverPath);

            const prepared = preparedDocumentMentions?.get(mention.serverPath);
            if (prepared) {
                attachments.push(...prepared);
                continue;
            }
            attachments.push({
                id: `${INLINE_SERVER_ATTACHMENT_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
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
            for (const token of scanMentions(rawText, confirmedMentionsRef.current)) {
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
    const [referencePicker, setReferencePicker] = React.useState<ReferencePickerState>(null);
    // The paste-toast tap may need to reopen the collapsed mobile composer.
    const mobileShell = useMobileComposerShell({
        isMobile,
        editorRef: composerRef,
        formRef: composerFormRef,
        setExpandedInput,
        // Without a soft keyboard, keep the full composer up.
        alwaysExpanded: hasHardwareKeyboard || isTabletLayout,
        holders: {
            controlsPanelOpen: Boolean(mobileControlsPanel),
            attachMenuOpen: mobileAttachMenuOpen,
            draftPickerOpen: mobileDraftPicker !== null,
            referencePickerOpen: referencePicker !== null,
            isDragging,
        },
    });
    const mobileComposerExpanded = mobileShell.expanded;
    const mobileTextareaFocused = mobileShell.focused;
    // Issues, PRs and tracker items on the composer, in attach order.
    const [linkedReferences, setLinkedReferences] = React.useState<ComposerReference[]>([]);
    const [contextPreviewHost, setContextPreviewHost] = React.useState<HTMLDivElement | null>(null);
    const [attachDialogGuestId, setAttachDialogGuestId] = React.useState<string | null>(null);
    // The chip the attach dialog was opened from; null when opened from the + menu.
    const [attachDialogItem, setAttachDialogItem] = React.useState<AttachIssueRequest | null>(null);

    // Message queue
    const parentMessageQueueTarget = currentSessionId
        ? createMessageQueueTarget(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory)
        : null;
    const parentMessageQueueKey = parentMessageQueueTarget ? getMessageQueueKey(parentMessageQueueTarget) : null;
    const messageQueueTarget = !isBtwActive ? parentMessageQueueTarget : null;
    const messageQueueKey = !isBtwActive ? parentMessageQueueKey : null;
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
    const inlineDraftSessionKey = isBtwActive ? btwComposerSessionId ?? '' : currentSessionId ?? (newSessionDraftOpen ? 'draft' : '');
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

    // Mobile comment mode (see composer/comment/): read imperatively here so
    // the send/queue guards below see the live state; rendering and lifecycle
    // live in useMobileCommentComposerMode further down.
    const mobileCommentController = useMobileCommentComposerController();
    const isMobileCommentOpen = React.useCallback(
        () => isMobile && mobileCommentController?.getState().status === 'open',
        [isMobile, mobileCommentController],
    );
    const attachMobileCommentRef = React.useRef<() => void>(() => undefined);

    const inputHistoryScope = useInputHistoryStore((state) => state.scope);
    const inputHistoryIdentity = React.useMemo(
        () => createInputHistoryIdentity(
            activeRuntimeKey,
            currentSessionDirectoryForSync ?? currentDirectory ?? '',
            inlineDraftSessionKey || 'draft',
        ),
        [activeRuntimeKey, currentDirectory, currentSessionDirectoryForSync, inlineDraftSessionKey],
    );
    const inputHistoryEntries = useInputHistoryStore(React.useCallback(
        (state) => selectInputHistoryEntries(state, inputHistoryIdentity),
        [inputHistoryIdentity],
    ));
    // Session scope also reads the visible transcript, so sessions older than
    // the persisted history still recall their prompts.
    const transcriptPrompts = useUserMessageHistory((isBtwActive ? btwSessionId : currentSessionId) ?? '');
    const historyValues = React.useMemo(
        () => (inputHistoryScope === 'session'
            ? mergeSessionInputHistory(transcriptPrompts, inputHistoryEntries)
            : mapInputHistoryEntriesToValues(inputHistoryEntries)),
        [inputHistoryEntries, inputHistoryScope, transcriptPrompts],
    );
    const messageHistoryIdentity = React.useMemo(
        () => buildInputHistoryNavigatorIdentity(inputHistoryScope, inputHistoryIdentity),
        [inputHistoryIdentity, inputHistoryScope],
    );
    const messageHistory = useMessageHistory<AttachedFile>(historyValues, messageHistoryIdentity);

    // Keep messageRef in sync with message state
    React.useEffect(() => {
        messageRef.current = message;
    }, [message]);

    React.useEffect(() => {
        currentChatDraftIdentityRef.current = chatDraftIdentity;
    }, [chatDraftIdentity]);

    // Draft persistence: identity switching, debounced writes and the
    // flush-on-hide edges live in the hook.
    const {
        persistNow: persistDraftImmediately,
        handoffDraft,
        restoreDraft,
        migrateDraft,
    } = useComposerDraft({
        message,
        messageRef,
        setMessage,
        confirmedMentionsRef,
        identity: chatDraftIdentity,
        selectAttachmentsOnIdentityChange: !columnPinned,
        persistEnabled: persistChatDraft,
        initialDraft: {
            text: initialDraftRef.current ?? '',
            identity: initialDraftIdentityRef.current,
        },
        onIdentityChange: () => {
            setInputMode('normal');
            draftCaretModeRef.current.atEnd = isBtwActive || draftCaretModeRef.current.btw;
            draftCaretModeRef.current.btw = isBtwActive;
        },
        onDraftRestored: (source) => {
            const editor = composerRef.current;
            if (!editor) return;
            if (source === 'fork') editor.focus();
            if (source !== 'fork' && draftCaretModeRef.current.atEnd) {
                editor.setSelection(editor.getValue().length);
            } else {
                editor.selectAll();
            }
        },
    });

    const handleExitBtw = React.useCallback(() => {
        if (!currentSessionId) return;
        immediateBtwSubmitRef.current = null;
        const panels = useBtwStore.getState();
        const pending = panels.byParent[currentSessionId];
        if (pending?.pending && !pending.creating && !btwSessionId) {
            const pendingSessionId = `btw-pending:${currentSessionId}`;
            const identity = createChatDraftIdentity(activeRuntimeKey, currentSessionDirectoryForSync ?? currentDirectory, pendingSessionId);
            if (identity) {
                clearChatDraft(identity, true);
                useInlineCommentDraftStore.getState().clearDrafts({ directory: identity.directory, sessionKey: pendingSessionId });
            }
            useSelectionStore.getState().clearSessionSelections(pendingSessionId);
            useInputStore.getState().consumePendingBtwComposerRequest(currentSessionId);
            panels.clearPanelState(currentSessionId);
            return;
        }
        panels.setPanelState(currentSessionId, { collapsed: true });
    }, [activeRuntimeKey, btwSessionId, currentDirectory, currentSessionDirectoryForSync, currentSessionId]);

    React.useEffect(() => {
        const request = pendingBtwComposerRequest;
        if (!request || request.parentSessionId !== currentSessionId) return;
        if (!isBtwActive) {
            useBtwStore.getState().setPanelState(
                request.parentSessionId,
                btwSessionId ? { collapsed: false } : { pending: true, collapsed: false },
            );
            return;
        }
        if (!chatDraftIdentity) return;
        const consumed = consumePendingBtwComposerRequest(currentSessionId);
        if (!consumed) return;
        restoreDraft(chatDraftIdentity, consumed.text, new Set());
        queueMicrotask(() => focusColumnInput());
    }, [btwSessionId, chatDraftIdentity, consumePendingBtwComposerRequest, currentSessionId, focusColumnInput, isBtwActive, pendingBtwComposerRequest, restoreDraft]);

    // Focus textarea when new session draft is opened
    const prevNewSessionDraftOpenRef = React.useRef(newSessionDraftOpen);
    React.useEffect(() => {
        // The draft opens in the main chat; a pinned composer stays out of it.
        if (!prevNewSessionDraftOpenRef.current && newSessionDraftOpen && !columnPinned) {
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
    }, [columnPinned, newSessionDraftOpen, isMobile]);

    // Session activity for queue availability and controls. In btw mode the
    // composer controls the temporary fork, so the stop button and send-button
    // state follow the FORK's activity; the queue affordance stays tied to the
    // main session (queued messages always belong to the main chat).
    // The column's session: a chat pinned in the side panel shows its own
    // send/stop state, not the main chat's.
    const { phase: currentSessionPhase } = useSessionActivity(currentSessionId, currentSessionDirectoryForSync ?? currentDirectory ?? undefined);
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

    // Consume pending input text (e.g., from revert action). Must stay after
    // useComposerDraft: on a draft switch the incoming draft loads first and
    // the pending text lands on top of it.
    const focusComposer = React.useCallback(() => composerRef.current?.focus(), []);
    usePendingComposerText({ enabled: !isBtwActive, target: mailboxTarget, setMessage, focus: focusComposer });

    const parallel = useParallelComposer({
        enabled: !isMobile && !isBtwActive,
        draftOpen: newSessionDraftOpen && newSessionDraft?.target !== 'chat',
        draftProjectId: newSessionDraft?.selectedProjectId ?? null,
        message,
        setMessage,
    });
    const parallelProjectId = newSessionDraft?.selectedProjectId ?? null;
    const parallelProject = useProjectsStore(React.useCallback((state) => {
        const project = state.projects.find((entry) => entry.id === (parallelProjectId ?? state.activeProjectId));
        return project ? `${project.id}\n${project.path}` : null;
    }, [parallelProjectId]));
    const parallelProjectRef = React.useMemo(() => {
        if (!parallelProject) return null;
        const [id, path] = parallelProject.split('\n');
        return { id, path };
    }, [parallelProject]);
    const enterParallel = parallel.enter;
    React.useLayoutEffect(() => {
        largeTextPasteGesture.invalidate();
    }, [largeTextPasteGesture, parallel.state?.active, parallel.isActive, newSessionDraftOpen, newSessionDraft?.target, mobileComposerExpanded, isExpandedInput]);
    const handleRunInParallel = React.useCallback(() => {
        // The picker offers it everywhere; a run always starts from a new-session draft.
        if (newSessionDraftOpen && newSessionDraft?.target !== 'chat') enterParallel();
        else openParallelComposer(messageRef.current);
    }, [enterParallel, newSessionDraft?.target, newSessionDraftOpen]);

    // A linked reference is attached context, not decoration: the submission
    // builder serializes it into the outgoing message, so a composer holding
    // only one of those chips is not empty and has to be sendable on its own.
    // BTW sends strip every reference, so the gate stays out of BTW.
    const hasLinkedReferences = linkedReferences.length > 0;
    const hasContent = message.trim().length > 0 || attachedFiles.length > 0 || hasDrafts || (!isBtwActive && hasLinkedReferences);
    const composerQueuedMessages = selectComposerQueue(queuedMessages);
    const hasQueuedMessages = !isBtwActive && composerQueuedMessages.length > 0;
    const preparingBtwSend = useBtwStore((state) => Boolean(currentSessionId && state.byParent[currentSessionId]?.pendingSend));
    const canSend = (hasContent || hasQueuedMessages) && !(isBtwActive && (btwPanel.creating || preparingBtwSend));

    const canAbort = sessionPhase !== 'idle';

    const getCurrentInputSnapshot = React.useCallback(() => {
        const currentMessage = composerRef.current?.getValue() ?? message;
        return {
            message: currentMessage,
            hasContent: currentMessage.trim().length > 0 || attachedFiles.length > 0 || hasDrafts || (!isBtwActive && hasLinkedReferences),
        };
    }, [attachedFiles.length, hasDrafts, hasLinkedReferences, isBtwActive, message]);

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
        // The comment's exit paths are attach/cancel; queueing a real prompt
        // underneath comment mode must never fire.
        if (isMobileCommentOpen()) return;
        const inputSnapshot = getCurrentInputSnapshot();
        if (!inputSnapshot.hasContent || !currentSessionId || !messageQueueTarget) return;

        // A local or extension command is run, not queued: the queue delivers
        // text to the model, and `/compact`, `/btw`, or `/task` mean nothing there.
        if (planLocalSlashCommand(inputSnapshot.message, inputMode, hasDrafts, true)
            || routeGuestSlashCommand(inputSnapshot.message, inputMode, guestCommands)) {
            void handleSubmitRef.current();
            return;
        }
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
        const { attachments: extractedMentionAttachments } = extractInlineFileMentions(sanitizedText, documentMentions.prepared);
        // #3898: a queued message is delivered later without the composer, so
        // a phantom mention (`@masha.conner`) must be dropped now or the
        // delivery 400s.
        const { sendable: mentionAttachments } = await filterMissingInlineAttachments(
            extractedMentionAttachments,
            opencodeClient,
        );
        const availableSkillNames = new Set(
            selectSkillsForDirectory(useSkillsStore.getState(), currentDirectory).map((skill) => skill.name),
        );
        const skillInstruction = buildSkillMentionInstruction(collectInlineSkillMentions(sanitizedText, availableSkillNames));
        // The server and the VS Code auto-send deliver `text` as is, so its
        // snippets expand now; `content` keeps them for editing.
        const textToQueue = await useSnippetsStore.getState().expandText(sanitizedText).catch((error) => {
            console.warn('[queue] Failed to expand snippets, queueing original text:', error);
            return sanitizedText;
        });

        // Everything attached to the composer leaves with the message: the
        // chips are part of what was queued, and come back if it is edited.
        const syntheticParts = consumePendingSyntheticParts(mailboxTarget) ?? [];
        const draftTarget = inlineDraftTarget;
        const drafts = draftTarget ? consumeDrafts(draftTarget) : [];
        const linked = linkedReferences;
        // Queued context is delivered as captured, so comment snippets expand now.
        const expandedDrafts = await expandCommentSnippets(drafts, useSnippetsStore.getState().expandText);
        const context = buildComposerContext({
            inlineComments: expandedDrafts,
            syntheticTexts: syntheticParts.map((part) => part.text),
            references: linked.map(toContextReference),
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
            clearAttachedFiles(chatDraftIdentity);
        }
        setLinkedReferences([]);
        if (!isMobile) {
            composerRef.current?.focus();
        }

        try {
            await addToQueue(queueTarget, {
                content: messageToQueue,
                text: textToQueue,
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
                useInputStore.getState().setPendingInputText(messageToQueue, 'append', mailboxTarget);
            }
            if (composerAttachments.length > 0) {
                useInputStore.getState().restoreAttachedFiles(composerAttachments, chatDraftIdentity);
            }
            if (draftTarget && drafts.length > 0) {
                useInlineCommentDraftStore.getState().restoreDrafts(draftTarget, drafts);
            }
            if (syntheticParts.length > 0) {
                useInputStore.getState().setPendingSyntheticParts(syntheticParts, mailboxTarget);
            }
            // Anything attached while the queue write was out stays, after these.
            setLinkedReferences((current) => withComposerReferences(linked, current));
            return;
        }
        recordLinkedReferences(queueSessionId, queueTarget.directory, linked);
    }, [getCurrentInputSnapshot, currentSessionId, messageQueueTarget, inputMode, hasDrafts, guestCommands, attachedFiles, sanitizeAttachmentsForSend, prepareDocumentMentions, extractInlineFileMentions, agents, currentDirectory, consumePendingSyntheticParts, mailboxTarget, inlineDraftTarget, consumeDrafts, linkedReferences, scrollToLatest, clearAttachedFiles, chatDraftIdentity, isMobile, isMobileCommentOpen, addToQueue, currentProviderId, currentModelId, currentAgentName, currentVariant, t]);

    /** Put the context a queued message was captured with back on the composer chips. */
    const restoreQueuedContext = React.useCallback((context: readonly QueuedContextPart[]) => {
        const synthetic: SyntheticContextPart[] = [];
        const restored: ComposerReference[] = [];
        for (const part of context) {
            if (part.kind === 'synthetic') {
                synthetic.push({ text: part.text, synthetic: true });
                continue;
            }
            // An instruction is derived from the text, and derived again on send.
            if (part.kind !== 'context') continue;
            const payload = part.metadata[CONTEXT_METADATA_KEY];
            if (payload.kind === 'repository-issue') {
                restored.push({
                    kind: 'repository-issue',
                    ...(payload.provider ? { provider: payload.provider } : {}),
                    number: payload.number,
                    title: payload.title,
                    url: payload.url,
                    contextText: part.text,
                });
            } else if (payload.kind === 'change-request') {
                // The captured context is final: whatever diff it includes is
                // already in the text, and the branches were not captured.
                // Messages written before providers other than GitHub existed
                // carry no provider, so the reference reads as GitHub's.
                restored.push({
                    kind: 'change-request',
                    provider: payload.provider ?? 'github',
                    number: payload.number,
                    title: payload.title,
                    url: payload.url,
                    head: '',
                    base: '',
                    includeDiff: false,
                    contextText: part.text,
                });
            } else if (payload.kind === 'linear-issue') {
                restored.push({ kind: 'linear-issue', identifier: payload.identifier, title: payload.title, url: payload.url, contextText: part.text });
            } else if (payload.kind === 'guest-issue' || payload.kind === 'guest-pr') {
                restored.push({
                    kind: 'guest',
                    providerId: payload.providerId,
                    id: payload.id,
                    title: payload.title,
                    url: payload.url,
                    contextText: part.text,
                    thread: payload.kind === 'guest-pr' ? 'pull' : 'issue',
                    data: payload.data,
                });
            } else {
                const draft = draftFromContextPayload(payload);
                if (draft && inlineDraftTarget) {
                    useInlineCommentDraftStore.getState().addDraft(inlineDraftTarget, draft);
                }
            }
        }
        if (restored.length > 0) {
            setLinkedReferences((current) => withComposerReferences(current, restored));
        }
        if (synthetic.length > 0) {
            const pending = useInputStore.getState().getPendingSyntheticParts(mailboxTarget) ?? [];
            useInputStore.getState().setPendingSyntheticParts([...pending, ...synthetic], mailboxTarget);
        }
    }, [inlineDraftTarget, mailboxTarget]);

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
        if (isBtwActive) return;
        setExpandedInput(!isExpandedInput);
    }, [isBtwActive, isExpandedInput, setExpandedInput]);

    const openGitHubPicker = React.useCallback(() => {
        setReferencePicker({ source: 'github' });
    }, []);
    const referencePickerDirectory = currentSessionDirectoryForSync ?? currentDirectory ?? null;
    const repositoryProvider = useRepositoryReferenceProvider(isVSCodeRuntime() ? null : referencePickerDirectory);
    const addLinkedReferences = React.useCallback((references: ComposerReference[]) => {
        setLinkedReferences((current) => withComposerReferences(current, references));
    }, []);
    const attachReferences = useAttachReferences(referencePickerDirectory, addLinkedReferences);

    const openLinearPicker = React.useCallback(() => {
        setReferencePicker({ source: 'linear' });
    }, []);

    const getSubmitErrorMessage = (error: unknown, fallback: string) => {
        const message = error instanceof Error ? error.message : '';
        return message.toLowerCase().includes('runtime changed')
            ? t('chat.chatInput.toast.messageSendFailed')
            : message || fallback;
    };

    const handleSubmit = async (options?: SubmitOptions) => {
        // Comment mode's only submit is attach; every other send path must be
        // inert while it is open.
        if (isMobileCommentOpen()) return;
        if (isBtwActive && currentSessionId && (btwPanel.creating || useBtwStore.getState().byParent[currentSessionId]?.pendingSend)) return;
        // "Run in parallel" launches the run instead of sending a message.
        if (parallel.isActive && !options?.queuedOnly) {
            if (parallel.runCount >= 2) void parallel.launch();
            return;
        }
        const submitRuntimeKey = getRuntimeKey();
        const queuedOnly = options?.queuedOnly ?? false;
        const queuedMessageId = options?.queuedMessageId;
        const delivery = options?.delivery === 'steer' && sessionPhase !== 'idle' ? 'steer' : undefined;
        const capturedTarget = messageQueueTarget;
        // Snapshot the draft and current-session identity before the first
        // async gap so a later sidebar selection cannot reroute the send.
        const capturedDraftSnapshot = newSessionDraftOpen ? { ...newSessionDraft } : null;
        const inputSnapshot = options?.presetText != null
            ? {
                message: options.presetText,
                hasContent: options.presetText.trim().length > 0 || attachedFiles.length > 0 || hasDrafts || (!isBtwActive && hasLinkedReferences),
            }
            : getCurrentInputSnapshot();
        if (queuedOnly && autoReviewRunning) {
            return;
        }

        if (queuedOnly) {
            if (!composerQueuedMessages.some((message) => !queuedMessageId || message.id === queuedMessageId) || !currentSessionId) return;
        } else if ((!inputSnapshot.hasContent && !hasQueuedMessages) || (!currentSessionId && !newSessionDraftOpen)) {
            return;
        }

        // Local slash commands are planned before anything is taken or
        // consumed. An action command must leave the queue and the attached
        // context where they are; a prompt command must send that context with
        // the prompt it produces. A command the composer cannot run here is not
        // a local command at all and goes out as typed.
        let commandPlan = !queuedOnly && inputSnapshot.hasContent
            ? planLocalSlashCommand(inputSnapshot.message, inputMode, hasDrafts, Boolean(currentSessionId))
            : null;
        if (commandPlan?.kind === 'prompt') {
            const magicCommand = findMagicPromptCommand(commandPlan.command.name);
            const commandIsAvailable = commandPlan.command.name === 'btw'
                ? Boolean(currentSessionId)
                : magicCommand !== null && canRunCommand(magicCommand, {
                    hasSession: Boolean(currentSessionId),
                    hasDraft: newSessionDraftOpen,
                });
            if (!commandIsAvailable) commandPlan = null;
        }
        if (commandPlan?.command.name === 'handoff-review' && (isMobile || isVSCodeRuntime())) commandPlan = null;

        // Enter BTW before sending so the question uses its isolated selections.
        // A bare command waits for input; an argument requests one immediate send.
        if (commandPlan?.kind === 'prompt' && commandPlan.command.name === 'btw' && currentSessionId) {
            const targetComposerId = btwSessionId ?? `btw-pending:${currentSessionId}`;
            const targetIdentity = createChatDraftIdentity(
                activeRuntimeKey,
                btwDirectory ?? currentSessionDirectoryForSync ?? currentDirectory,
                targetComposerId,
            );
            const argument = commandPlan.command.argument.trim();
            handoffDraft(targetIdentity, isBtwActive ? argument : argument || null);
            if (argument && targetIdentity) immediateBtwSubmitRef.current = { identity: targetIdentity, text: argument };
            if (btwSessionId) {
                useBtwStore.getState().setPanelState(currentSessionId, { collapsed: false });
                return;
            }
            useBtwStore.getState().setPanelState(currentSessionId, { pending: true, creating: false, collapsed: false });
            return;
        }

        // Opening BTW is local and still works while authentication is expired.
        if (useAuthSessionStore.getState().state !== 'ok') {
            toast.error(t('sessionAuth.expired.sendBlocked'));
            return;
        }

        // A failed send returns the typed prompt no matter WHY it failed —
        // auth, network, server, anything. Losing a long prompt to a toast is
        // the one outcome this handler must never produce. The mentions are
        // snapshotted here because sending clears them before it can fail.
        const confirmedMentionsSnapshot = new Set(confirmedMentionsRef.current);
        const restoreComposerText = () => {
            if (queuedOnly || !inputSnapshot.message) return;
            restoreDraft(chatDraftIdentity, inputSnapshot.message, confirmedMentionsSnapshot);
        };

        // An extension command never reaches the model: the extension turns
        // `/name args` into a chip, which lands through the same pending slot
        // a guest panel's `attach` uses. Nothing else in the composer moves.
        const guestRoute = !queuedOnly && !isBtwActive && inputSnapshot.hasContent
            ? routeGuestSlashCommand(inputSnapshot.message, inputMode, guestCommands)
            : null;
        if (guestRoute) {
            setMessage('');
            confirmedMentionsRef.current.clear();
            persistDraftImmediately(chatDraftIdentity, '');
            messageHistory.reset();
            const outcome = await runGuestCommand(guestRoute);
            if (outcome.ok) {
                if (outcome.item) {
                    useInputStore.getState().setPendingGuestIssue(outcome.item);
                } else {
                    // Nothing matched: give the command back so the user can fix the argument.
                    restoreComposerText();
                    toast.info(t('chat.chatInput.toast.guestCommandNothing', { name: guestRoute.entry.guestName }));
                }
                return;
            }
            restoreComposerText();
            toast.error(outcome.reason === 'error'
                ? t('chat.chatInput.toast.guestCommandFailed', { command: guestRoute.entry.command.name, reason: outcome.message })
                : t('chat.chatInput.toast.guestCommandUnavailable', { name: guestRoute.entry.guestName }));
            return;
        }

        // The projection knows the captured send configuration; the full
        // messages are taken from the queue only once nothing below can still
        // bail out, so an early return leaves the queue untouched.
        const queuedProjection = queuedMessageId
            ? composerQueuedMessages.filter((message) => message.id === queuedMessageId)
            : composerQueuedMessages;
        const capturedSendConfig = queuedOnly ? queuedProjection[0]?.sendConfig : undefined;
        const providerIdToSend = capturedSendConfig?.providerID ?? (isBtwActive ? effectiveBtwSelection.model?.providerId : currentProviderId);
        const modelIdToSend = capturedSendConfig?.modelID ?? (isBtwActive ? effectiveBtwSelection.model?.modelId : currentModelId);
        const agentNameToSend = capturedSendConfig?.agent ?? (isBtwActive ? effectiveBtwSelection.agent : currentAgentName);
        const variantToSend = capturedSendConfig?.variant ?? (isBtwActive ? effectiveBtwSelection.variant : currentVariant);

        if (!providerIdToSend || !modelIdToSend) {
            console.warn('Cannot send message: provider or model not selected');
            toast.error(t('chat.chatInput.toast.noModelSelected'));
            return;
        }

        // A message to an isolated space goes only on a model the space holds a key for; otherwise
        // it stays in the input with the reason and the way to the grant dialog.
        const spaceRefusal = currentSessionId
            ? spaceModelRefusal({ requestId: null, directory: currentSessionDirectoryForSync ?? currentDirectory ?? null }, providerIdToSend)
            : newSessionDraftOpen
                ? spaceModelRefusal({ requestId: newSessionDraft?.pendingWorktreeRequestId ?? null, directory: newSessionDraft?.directoryOverride ?? null }, providerIdToSend)
                : null;
        if (spaceRefusal) {
            const provider = useConfigStore.getState().providers.find((entry) => entry.id === spaceRefusal.providerId)?.name ?? spaceRefusal.providerId;
            toast.error(spaceRefusal.reason === 'domain_blocked'
                ? t('spaces.draft.modelDomainBlocked', { domain: spaceRefusal.domain })
                : spaceRefusal.reason === 'needs_again'
                    ? t('spaces.draft.modelNeedsKeyAgain', { provider })
                    : t('spaces.draft.modelNotGranted', { provider }), {
                action: {
                    label: t('spaces.group.access.give'),
                    onClick: () => useSpacesStore.getState().openAccessDialog(spaceRefusal.spaceId, spaceRefusal.providerId, spaceRefusal.reason === 'domain_blocked' ? spaceRefusal.domain : undefined),
                },
            });
            return;
        }

        // Auto-review owns the active workflow; follow-ups wait in its queue.
        if (currentSessionId && !queuedOnly && autoReviewRunning && !isBtwActive && !commandPlan) {
            void handleQueueMessage();
            return;
        }

        // btw mode: the child fork's blocking prompts are answered inside the
        // panel; the composer send goes straight to the fork (routeMessage
        // queues if the fork's own turn is busy).
        if (currentSessionId && !queuedOnly && !isBtwActive && !commandPlan) {
            // Sending is authoritative for blocking prompts: deny pending
            // permissions and dismiss open forms for the session subtree. The
            // deny/clear vanishes the card instantly (optimistic); rejecting
            // unblocks the agent's tool but does NOT end its turn.
            const [deniedPermissions, dismissedForms] = await Promise.all([
                sessionActions.dismissOpenPermissionsForSession(currentSessionId),
                sessionActions.dismissOpenFormsForSession(currentSessionId),
            ]);
            // An explicit Steer goes straight to the session inbox, which
            // takes it while the turn is still active. Any other send would
            // race with that run, so it is queued; the queued-message auto-send
            // hook delivers it once the session returns to idle (#1740, #3369).
            if ((deniedPermissions || dismissedForms) && delivery !== 'steer') {
                void handleQueueMessage();
                return;
            }
        }

        // Action commands change session or UI state and send nothing. The
        // command text goes; the queue and whatever the composer had attached
        // stay exactly where they are.
        if (commandPlan?.kind === 'action' && currentSessionId) {
            const actionName = commandPlan.command.name;
            setMessage('');
            confirmedMentionsRef.current.clear();
            persistDraftImmediately(chatDraftIdentity, '');
            messageHistory.reset();
            if (!isBtwActive) setExpandedInput(false);
            if (isMobile) composerRef.current?.blur();
            try {
                if (actionName === 'undo') {
                    await useSessionUIStore.getState().handleSlashUndo(currentSessionId);
                    scrollToBottom?.();
                } else if (actionName === 'redo') {
                    await useSessionUIStore.getState().handleSlashRedo(currentSessionId);
                    scrollToBottom?.();
                } else if (actionName === 'timeline') {
                    openTimelineDialog();
                } else if (actionName === 'handoff-review') {
                    setReviewDialogOpen(true);
                } else if (actionName === 'fork') {
                    const forkOutcome = await runForkCommand(currentSessionId, commandPlan.command.argument, {
                        // The fork branches the main session, so it keeps that session's
                        // selection even while the btw panel owns the composer.
                        providerID: capturedSendConfig?.providerID ?? currentProviderId,
                        modelID: capturedSendConfig?.modelID ?? currentModelId,
                        agent: capturedSendConfig?.agent ?? currentAgentName,
                        variant: capturedSendConfig?.variant ?? currentVariant ?? undefined,
                    }, {
                        fork: sessionActions.forkFromLastCompletedTurn,
                        directoryFor: (session) => useSessionUIStore.getState().getDirectoryForSession(session.id) || session.directory || null,
                        send: (text, selection, target) => useSessionUIStore.getState().sendMessage(
                            text,
                            selection.providerID,
                            selection.modelID,
                            selection.agent,
                            undefined,
                            undefined,
                            undefined,
                            selection.variant,
                            'normal',
                            target,
                        ),
                        draftIdentity: (directory, sessionId) => createChatDraftIdentity(getRuntimeKey(), directory, sessionId),
                        restoreText: (target, text) => useInputStore.setState({ pendingComposerRestore: { target, text, files: [] } }),
                    });
                    if (forkOutcome === 'send-failed') toast.error(t('chat.chatInput.toast.forkSendFailed'));
                } else if (actionName === 'compact') {
                    await sessionActions.waitForConnectionOrThrow();
                    const compactDirectory = useSessionUIStore.getState().getDirectoryForSession(currentSessionId) || currentDirectory || undefined;
                    await opencodeClient.compactSession(currentSessionId, compactDirectory);
                }
            } catch (error) {
                restoreComposerText();
                if (actionName === 'fork') {
                    toast.error(error instanceof sessionActions.NothingToForkError
                        ? t('chat.chatInput.toast.forkNothingToFork')
                        : getSubmitErrorMessage(error, t('chat.chatInput.toast.forkFailed')));
                    return;
                }
                if (actionName !== 'compact') throw error;
                toast.error(getSubmitErrorMessage(error, t('chat.chatInput.toast.compactFailed')));
            }
            return;
        }

        let sendMessageOptions: {
            target?: NonNullable<typeof capturedTarget>;
            sessionId?: string;
            directory?: string;
            draftSnapshot?: NonNullable<typeof capturedDraftSnapshot>;
            historySubmissions?: InputHistorySubmission[];
            delivery?: 'steer';
            skills?: SkillMentions;
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
            !isBtwActive && !queuedOnly && inputSnapshot.hasContent ? [inputSnapshot.message] : [],
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
        if (capturedTarget && hasQueuedMessages && !commandPlan) {
            try {
                queuedMessagesToSend = await takeForSend(capturedTarget, queuedMessageId);
            } catch (error) {
                console.warn('[queue] failed to take queued messages for sending:', error);
                toast.error(t('chat.queuedMessage.toast.takeFailed'));
                return;
            }
            if (queuedOnly && queuedMessagesToSend.length === 0) return;
        }

        const historySubmissions = buildChatInputHistorySubmissions({
            inputMode,
            // Server-owned items were recorded on acceptance. VS Code records
            // the full items actually taken, never the metadata projection.
            queuedMessages: isServerOwnedMessageQueue() ? [] : queuedMessagesToSend,
            composerText: inputSnapshot.message,
            composerAttachments: attachedFiles,
            includeComposer: !queuedOnly && inputSnapshot.hasContent,
        });
        if (historySubmissions?.length) {
            sendMessageOptions = { ...sendMessageOptions, historySubmissions };
        }

        // Inline review comments and synthetic context are consumed before
        // assembly so a failed send can restore exactly what it took. What is
        // here belongs to this send: queueing took its own context with it.
        const syntheticParts = isBtwActive ? [] : consumePendingSyntheticParts(mailboxTarget);
        const consumedDraftTarget = inlineDraftTarget;
        const drafts: InlineCommentDraft[] = consumedDraftTarget
            ? consumeDrafts(consumedDraftTarget)
            : [];
        const restoreConsumedDrafts = () => {
            if (consumedDraftTarget && drafts.length > 0) {
                useInlineCommentDraftStore.getState().restoreDrafts(consumedDraftTarget, drafts);
            }
        };
        // Everything a prompt command consumed comes back if it fails: the
        // attached context, the typed text, and the files.
        const restoreConsumedInput = () => {
            restoreConsumedDrafts();
            if (syntheticParts?.length) {
                const inputState = useInputStore.getState();
                inputState.setPendingSyntheticParts([...syntheticParts, ...(inputState.getPendingSyntheticParts(mailboxTarget) ?? [])], mailboxTarget);
            }
            restoreComposerText();
            if (!queuedOnly && attachedFiles.length > 0) {
                useInputStore.getState().restoreAttachedFiles(attachedFiles, chatDraftIdentity);
            }
        };

        const availableSkillNames = new Set(
            selectSkillsForDirectory(useSkillsStore.getState(), currentDirectory).map((skill) => skill.name),
        );

        // Comments become synthetic context, which the send-time expansion
        // below skips, so their own words expand here.
        const expandedDrafts = await expandCommentSnippets(drafts, useSnippetsStore.getState().expandText);

        const outgoing = buildOutgoingMessage({
            queued: queuedMessagesToSend,
            composerText: !queuedOnly && inputSnapshot.hasContent ? inputSnapshot.message : null,
            composerAttachments: attachedFiles,
            inlineComments: expandedDrafts,
            syntheticTexts: [
                ...buildBtwSyntheticTexts({ isBtwActive, isPromotedBtwSession }),
                ...(syntheticParts?.map((part) => part.text) ?? []),
            ],
            references: isBtwActive ? [] : linkedReferences.map(toContextReference),
        }, {
            parseAgentMention: (text) => {
                if (isBtwActive) return { text };
                const { sanitizedText, mention } = parseAgentMentions(text, agents);
                return { text: sanitizedText, agentName: mention?.name };
            },
            extractFileMentions: (text) => {
                if (isBtwActive) return { text, attachments: [] };
                const { sanitizedText, attachments } = extractInlineFileMentions(text, preparedDocumentMentions);
                return { text: sanitizedText, attachments };
            },
            sanitizeAttachments: sanitizeAttachmentsForSend,
            collectSkillNames: (text) => collectInlineSkillMentions(text, availableSkillNames),
        });

        let primaryText = outgoing.primaryText;
        const { primaryAttachments, additionalParts, agentMentionName, skillNames } = outgoing;

        if (outgoing.isEmpty) return;

        // Skills named inline are attached to the prompt so OpenCode loads
        // them with the message, rather than hoping the model follows a hint.
        if (skillNames.length > 0) {
            sendMessageOptions = {
                ...sendMessageOptions,
                skills: { names: skillNames, instructionFor: buildSkillMentionInstruction },
            };
        }

        // #3898: inline @-mentions resolve to server paths without checking
        // the file exists, and OpenCode 400s the whole prompt on a missing
        // file. Silently drop the unresolvable ones and submit the rest;
        // the prompt text itself is untouched. Filtered once here so every
        // send path below (magic-prompt, btw fork, optimistic row, main send)
        // carries the same list.
        const { sendable: sendableAttachments } = await filterMissingInlineAttachments(
            primaryAttachments,
            opencodeClient,
        );

        // Clear input (the queue was taken above)
        if (!queuedOnly) {
            setMessage('');
            messageRef.current = '';
            confirmedMentionsRef.current.clear();
            // Clear per-session draft on submit
            persistDraftImmediately(chatDraftIdentity, '');
            messageHistory.reset();
            if (attachedFiles.length > 0) {
                clearAttachedFiles(chatDraftIdentity);
            }
            // Close expanded input overlay when submitting
            if (!isBtwActive) setExpandedInput(false);
        }

        if (isMobile) {
            composerRef.current?.blur();
        }

        // Prompt commands render a visible prompt and send it with everything
        // the composer had attached. `/btw` was handled above as a composer
        // transition and never reaches this sending path.
        if (commandPlan?.kind === 'prompt') {
            const { name: commandName, argument } = commandPlan.command;

            // The rest render a visible prompt plus synthetic instructions and
            // send them as one message, the attached context riding along.
            const command = findMagicPromptCommand(commandName);
            if (command) {
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
                        sendableAttachments,
                        agentMentionName,
                        [...additionalParts, { text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    scrollToBottom?.();
                } catch (error) {
                    restoreConsumedInput();
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

        const expandOutgoingSnippets = async () => {
            try {
                const expandText = useSnippetsStore.getState().expandText;
                primaryText = await expandText(primaryText);
                for (const part of additionalParts) {
                    if (!part.synthetic) part.text = await expandText(part.text);
                }
            } catch (error) {
                console.warn('[ChatInput] Failed to expand snippets, sending original text:', error);
            }
        };
        let pendingBtwSend: symbol | null = null;
        if (isBtwActive && btwPanel.pending && currentSessionId) {
            pendingBtwSend = await preparePendingBtwSend(currentSessionId, submitRuntimeKey, expandOutgoingSnippets);
            if (!pendingBtwSend) {
                if (getRuntimeKey() !== submitRuntimeKey) restoreComposerText();
                return;
            }
        } else {
            await expandOutgoingSnippets();
        }
        const ownsPendingBtwSend = () => Boolean(pendingBtwSend && currentSessionId
            && useBtwStore.getState().byParent[currentSessionId]?.pendingSend === pendingBtwSend);

        // Collect all attachments for error recovery
        const allAttachments = [
            ...sendableAttachments,
            ...additionalParts.flatMap(p => p.attachments ?? []),
        ];

        // Arm the timeline anchor BEFORE the optimistic user row can commit;
        // arming after (or a frame later) races the commit and the anchor
        // never claims the new message.
        scrollToBottom?.();

        if (isBtwActive && btwPanel.pending && currentSessionId && btwComposerSessionId) {
            const targetDirectory = useSessionUIStore.getState().getDirectoryForSession(currentSessionId)
                || currentDirectory
                || null;
            if (!targetDirectory) {
                useBtwStore.getState().setPanelState(currentSessionId, { pendingSend: undefined });
                restoreConsumedInput();
                toast.error(t('chat.btw.toast.createFailed'));
                return;
            }
            try {
                const fork = await startBtwSession({
                    parentSessionId: currentSessionId,
                    expectedRuntimeKey: submitRuntimeKey,
                    question: primaryText,
                    directory: targetDirectory,
                    providerID: providerIdToSend,
                    modelID: modelIdToSend,
                    agent: agentNameToSend,
                    variant: variantToSend,
                    attachments: sendableAttachments,
                    additionalParts,
                    skills: sendMessageOptions?.skills,
                    permissionMode: pendingBtwPermissionMode,
                });
                if (!ownsPendingBtwSend()) return;
                if (getRuntimeKey() !== submitRuntimeKey) {
                    useBtwStore.getState().clearPanelState(currentSessionId);
                    return;
                }
                const forkDirectory = fork.directory ?? targetDirectory;
                migrateDraft(chatDraftIdentity, createChatDraftIdentity(activeRuntimeKey, forkDirectory, fork.id));
                if (inlineDraftTarget) {
                    const drafts = useInlineCommentDraftStore.getState();
                    drafts.restoreDrafts({ directory: forkDirectory, sessionKey: fork.id }, drafts.consumeDrafts(inlineDraftTarget));
                }
                useBtwStore.getState().setPanelState(currentSessionId, { pending: false, creating: false, pendingSend: undefined });
                scrollToBottom?.();
            } catch (error) {
                if (!ownsPendingBtwSend()) return;
                if (getRuntimeKey() !== submitRuntimeKey) {
                    useBtwStore.getState().clearPanelState(currentSessionId);
                    restoreComposerText();
                    return;
                }
                // Preserve the pending owner before restoring text so a failed
                // first send never drops back into the parent draft.
                useBtwStore.getState().setPanelState(currentSessionId, { pending: true, creating: false, collapsed: false, pendingSend: undefined });
                restoreConsumedInput();
                toast.error(getSubmitErrorMessage(error, t('chat.btw.toast.createFailed')));
            }
            return;
        }

        const sendPromise = sendMessage(
            primaryText,
            providerIdToSend,
            modelIdToSend,
            agentNameToSend,
            sendableAttachments,
            agentMentionName,
            additionalParts.length > 0 ? additionalParts : undefined,
            variantToSend,
            inputMode,
            sendMessageOptions,
        );
        void sendPromise.then(() => {
            if (isBtwActive) return;
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
                recordLinkedReferences(linkTargetSessionId, linkTargetDirectory, linkedReferences);
            }
            // A session that starts with a Linear issue attached reports itself
            // on that issue (the Linear card's Session comments), however it
            // was started: a draft, a worktree made from the issue.
            if (!currentSessionId && linkTargetSessionId) {
                for (const reference of linkedReferences) {
                    if (reference.kind !== 'linear-issue') continue;
                    postLinearSessionStarted(runtimeLinear, { sessionId: linkTargetSessionId, issueIdentifier: reference.identifier });
                }
            }

            // The sent references leave the composer; one attached while the
            // send was out stays for the next message.
            const sentKeys = new Set(linkedReferences.map(composerReferenceKey));
            setLinkedReferences((current) => current.filter((reference) => !sentKeys.has(composerReferenceKey(reference))));
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
            restoreComposerText();

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
                    useInputStore.getState().restoreAttachedFiles(allAttachments, chatDraftIdentity);
                }
                return;
            }

            if (isSoftNetworkError) {
                if (allAttachments.length > 0) {
                    useInputStore.getState().restoreAttachedFiles(allAttachments, chatDraftIdentity);
                    toast.error(t('chat.chatInput.toast.sendAttachmentsFailed'));
                }
                return;
            }

            if (normalized.includes('runtime changed')) {
                if (allAttachments.length > 0) {
                    useInputStore.getState().restoreAttachedFiles(allAttachments, chatDraftIdentity);
                }
                toast.error(t('chat.chatInput.toast.messageSendFailed'));
                return;
            }

            if (allAttachments.length > 0) {
                useInputStore.getState().restoreAttachedFiles(allAttachments, chatDraftIdentity);
            }

            if (normalized.includes('returned a web page instead of an api response') || normalized.includes('runtime_unavailable')) {
                toast.error(t('chat.chatInput.toast.messageSendFailed'));
                return;
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
        // Comment mode owns the composer; its only primary action is attach.
        if (isMobileCommentOpen()) return;
        const inputSnapshot = getCurrentInputSnapshot();
        const canQueue = !isBtwActive && inputMode === 'normal' && inputSnapshot.hasContent && currentSessionId && (currentSessionPhase !== 'idle' || autoReviewRunning);
        if (followUpBehavior === 'queue' && canQueue) {
            void handleQueueMessage();
        } else if (followUpBehavior === 'steer' && canQueue) {
            void handleSubmitRef.current({ delivery: 'steer' });
        } else {
            void handleSubmitRef.current();
        }
    }, [inputMode, getCurrentInputSnapshot, currentSessionId, currentSessionPhase, autoReviewRunning, followUpBehavior, handleQueueMessage, isBtwActive, isMobileCommentOpen]);

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

    const { markDictationStart, keepTranscriptForOrigin } = useDictationOrigin({
        identityRef: currentChatDraftIdentityRef,
        restoreDraft,
        onKeptForOrigin: () => {
            toast.info(t('chat.chatInput.toast.dictationKeptForOriginalSession'));
        },
    });

    // Dictation: insert the transcript inline; optionally submit immediately.
    // getCurrentInputSnapshot reads composerRef.current.getValue() first, so setting
    // it synchronously lets handleSubmit pick up the text in the same tick.
    // A transcript belongs to the draft that was on screen when recording
    // started. After a session switch it is kept for that draft and must not
    // be inserted or sent here.
    const handleDictationInsert = React.useCallback((text: string) => {
        if (keepTranscriptForOrigin(text)) return;
        dictationSendEndRef.current?.();
        setMessage((prev) => {
            // The editor is controlled by this state; getCurrentInputSnapshot
            // reads it back, so no imperative write is needed.
            return appendInlineText(prev, text);
        });
        setTimeout(() => {
            composerRef.current?.focus();
        }, 0);
    }, [keepTranscriptForOrigin]);

    const handleDictationInsertAndSend = React.useCallback((text: string) => {
        if (keepTranscriptForOrigin(text)) return;
        // Read the pending draft from the ref, NOT from the editor: the
        // transcript resolves asynchronously, and on mobile the shell may have
        // already collapsed into the pill by then, so the editor is unmounted
        // and getValue() returns '' — which silently dropped the user's typed
        // text and (once the composer cleared) the transcript with it.
        const next = appendInlineText(messageRef.current, text);
        // Land the composed text in the composer state first, so a failed send
        // restores exactly what the user dictated, then submit it as an
        // explicit override (the textarea may be unmounted at this point).
        setMessage(next);
        dictationSendInFlightRef.current = true;
        void handleSubmitRef.current({ presetText: next }).finally(() => {
            dictationSendEndRef.current?.();
        });
    }, [keepTranscriptForOrigin]);

    // A command with an argument sends once the isolated composer owns its draft.
    React.useEffect(() => {
        const pending = immediateBtwSubmitRef.current;
        if (!pending || !isBtwActive || !chatDraftIdentity) return;
        if (getChatDraftIdentityKey(pending.identity) !== getChatDraftIdentityKey(chatDraftIdentity)) {
            immediateBtwSubmitRef.current = null;
            return;
        }
        immediateBtwSubmitRef.current = null;
        void handleSubmit({ presetText: pending.text });
    });

    // Preset chips rendered outside this component (e.g. under the welcome
    // message on narrow surfaces) request a submit via the input store; consume
    // it here so it routes through the same command-aware submit path.
    React.useEffect(() => {
        if (pendingPresetSubmit == null || columnPinned) return;
        const text = useInputStore.getState().consumePendingPresetSubmit();
        if (text) submitPresetPrompt(text.text, text.type);
    }, [columnPinned, pendingPresetSubmit, submitPresetPrompt]);

    const handleKeyDown = (e: KeyboardEvent) => {
        // Early return during IME composition to prevent interference with autocomplete.
        // Uses keyCode === 229 fallback for WebKit where compositionend fires before keydown.
        if (isIMECompositionEvent(e)) {
            largeTextPasteGesture.invalidate();
            return;
        }
        if (largeTextPasteBehavior === 'inline-double-paste') largeTextPasteGesture.keyDown(e);

        // Enter shell mode before CodeMirror inserts the trigger. Keeping the
        // document unchanged also keeps the caret at the start for the first
        // command character.
        if (!isBtwActive && inputMode === 'normal' && e.key === '!') {
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

        const autocomplete = openAutocomplete === 'command' ? commandRef.current
            : openAutocomplete === 'skill' ? skillRef.current
                : openAutocomplete === 'snippet' ? snippetRef.current
                    : openAutocomplete === 'mention' ? mentionRef.current
                        : null;
        const autocompleteKey = getDropdownNavigationKey(e) ?? e.key;
        if (autocomplete && (autocompleteKey === 'Enter' || autocompleteKey === 'ArrowUp' || autocompleteKey === 'ArrowDown' || autocompleteKey === 'Escape' || autocompleteKey === 'Tab')) {
            e.preventDefault();
            e.stopPropagation();
            autocomplete.handleKeyDown(autocompleteKey);
            return;
        }

        if (isBtwActive && currentSessionId && e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            handleExitBtw();
            return;
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

        if (!isBtwActive && cycleAgentDirection !== 0 && openAutocomplete === null) {
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
            const recalled = messageHistory.older({ text: message, attachments: attachedFiles });
            if (recalled !== null) {
                setMessage(recalled.text);
                useInputStore.getState().setAttachedFiles([...recalled.attachments]);
                // Caret to the start, so the recalled message reads from its
                // beginning rather than from wherever the draft's caret was.
                requestAnimationFrame(() => composerRef.current?.setSelection(0, 0));
            }
            return;
        }

        if (e.key === 'ArrowDown' && canNavigateHistoryDown) {
            e.preventDefault();
            const recalled = messageHistory.newer({ text: message, attachments: attachedFiles });
            if (recalled !== null) {
                setMessage(recalled.text);
                useInputStore.getState().setAttachedFiles([...recalled.attachments]);
                requestAnimationFrame(() => composerRef.current?.setSelection(recalled.text.length, recalled.text.length));
            }
            return;
        }

        // Mobile and expanded desktop require Ctrl/Cmd+Enter to send from the
        // keyboard. The standard desktop composer follows the setting.
        const isCtrlEnter = e.ctrlKey || e.metaKey;
        if (e.key === 'Enter' && shouldSubmitEnter({
            isMobile,
            isDesktopExpanded,
            enterToSend,
            enterToSendConfigured,
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
        })) {
            e.preventDefault();

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
        // Auto hides the agent control, so the shortcut must not change a
        // choice the user cannot see.
        if (isAutoModel(currentProviderId, currentModelId)) return;
        const nextAgentName = getCycledPrimaryAgentName(agents, currentAgentName, direction, useUIStore.getState().favoriteAgents);
        if (!nextAgentName) return;

        // A pinned column's agent is its own session's choice only.
        if (!columnPinned) setAgent(nextAgentName);

        if (currentSessionId) {
            saveSessionAgentSelection(currentSessionId, nextAgentName);
        }
    }, [agents, columnPinned, currentAgentName, currentModelId, currentProviderId, currentSessionId, setAgent, saveSessionAgentSelection]);

    // Height the failed-dictation salvage text needs. Its overlay sits
    // absolutely over the composer, so the composer must be able to grow for
    // it. Apply the editor's line and screen bounds before using that height as
    // a floor, otherwise long salvage text can push the action row off-screen.
    const dictationHeightHostRef = React.useRef<HTMLDivElement | null>(null);
    const [dictationContentHeight, setDictationContentHeight] = React.useState<number | null>(null);
    const handleDictationContentHeightChange = React.useCallback((height: number | null) => {
        setDictationContentHeight((prev) => (prev === height ? prev : height));
    }, []);
    const dictationHeightLimit = useComposerHeightLimit({
        active: dictationContentHeight !== null,
        disabled: isComposerExpanded,
        hostRef: dictationHeightHostRef,
        maxLines: isMobile ? MAX_MOBILE_COMPOSER_LINES : MAX_VISIBLE_COMPOSER_LINES,
        boundSelector: isMobile ? '[data-composer-bound]' : undefined,
        boundGapPx: isMobile ? MOBILE_COMPOSER_BOUND_GAP_PX : 0,
    });

    const updateAutocompleteState = React.useCallback((
        value: string,
        cursorPosition: number,
        inputSource: FileMentionAutocompleteInputSource = 'manual',
        insertedText?: string,
    ) => {
        const trigger = resolveAutocompleteTrigger(value, cursorPosition, {
            inputMode,
            mentionsEnabled: !isBtwActive,
            inputSource,
            insertedText,
        });
        setOpenAutocomplete(trigger?.kind ?? null);
        setAutocompleteQuery(trigger?.query ?? '');
    }, [inputMode, isBtwActive]);

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
        if (largeTextPasteBehavior === 'inline-double-paste') {
            largeTextPasteGesture.change({
                value, selection, fromPaste, insertedText,
                scope: getLargeTextPasteScope(),
            });
        }
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
        if (!isBtwActive && inputMode === 'normal' && value.startsWith('!')) {
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

    /**
     * Attach files that arrived by paste or drop and cite each one in the
     * draft as `[name]`, the same way pasted images are cited. Images get a
     * generated unique name up front; other files keep their own name and are
     * cited only once they attached, so a rejected file leaves no dangling
     * citation.
     */
    const attachFilesWithCitation = React.useCallback(async (
        files: File[],
        leadingText: string = '',
    ): Promise<void> => {
        const attachmentDraftKey = useInputStore.getState().attachmentDraftKey;
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        const otherFiles = files.filter((file) => !file.type.startsWith('image/'));

        const insertCitation = (filenames: string[], text: string) => {
            if (filenames.length === 0 && !text) return;
            const citationText = buildAttachmentCitationText(filenames);
            const editor = composerRef.current;
            const currentMessage = editor?.getValue() ?? messageRef.current;
            const selectionStart = editor?.getSelection().start ?? currentMessage.length;
            const selectionEnd = editor?.getSelection().end ?? currentMessage.length;
            const insertionText = withInlineInsertionBoundaries(
                buildImagePasteInsertion(text, citationText),
                currentMessage.slice(0, selectionStart),
                currentMessage.slice(selectionEnd),
            );
            insertTextAtSelection(insertionText, getFileMentionInputSourceForInsertedText(insertionText));
        };

        const assignedImageNames = assignImageAttachmentFilenames(
            imageFiles,
            [
                ...useInputStore.getState().attachedFiles.map((file) => file.filename),
                ...pendingPastedAttachmentFilenamesRef.current,
            ],
        );
        // Pending before the text lands, so the editor draws the citation as a
        // chip in the same transaction that inserts it.
        for (const filename of assignedImageNames) pendingPastedAttachmentFilenamesRef.current.add(filename);
        insertCitation(assignedImageNames, leadingText);

        let attached = false;
        for (let index = 0; index < imageFiles.length; index += 1) {
            const filename = assignedImageNames[index];
            const file = renameFileForAttachmentCitation(imageFiles[index], filename);
            try {
                attached = (await addAttachedFile(file)) || attached;
            } catch (error) {
                console.error('Clipboard image attach failed', error);
                toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.clipboardAttachFailed'));
            } finally {
                pendingPastedAttachmentFilenamesRef.current.delete(filename);
            }
            if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) {
                // The draft changed under the paste: the rest never attach here.
                for (const rest of assignedImageNames.slice(index + 1)) pendingPastedAttachmentFilenamesRef.current.delete(rest);
                return;
            }
        }

        const attachedOtherNames: string[] = [];
        for (const file of otherFiles) {
            try {
                if (await addAttachedFile(file)) {
                    attached = true;
                    attachedOtherNames.push(file.name);
                }
            } catch (error) {
                console.error('File attach failed', error);
            }
            if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) return;
        }
        insertCitation(attachedOtherNames, '');

        if (files.length > 0 && !attached) {
            toast.error(t('chat.chatInput.toast.attachFileFailed'));
        }
    }, [addAttachedFile, insertTextAtSelection, t]);

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
                    largeTextPasteGesture.invalidate();
                    return;
                }
            }
        }

        // Images get a citation and a generated name; every other clipboard
        // file (Finder/Explorer copy, a saved document) attaches as picked.
        const imageMap = new Map<string, File>();
        const otherFileMap = new Map<string, File>();
        const collectClipboardFile = (file: File) => {
            const target = file.type.startsWith('image/') ? imageMap : otherFileMap;
            target.set(`${file.name}-${file.size}`, file);
        };

        Array.from(e.clipboardData.files || []).forEach(collectClipboardFile);

        Array.from(e.clipboardData.items || []).forEach(item => {
            if (item.kind !== 'file') return;
            const file = item.getAsFile();
            if (file) collectClipboardFile(file);
        });

        const imageFiles = Array.from(imageMap.values());
        const otherFiles = Array.from(otherFileMap.values());
        const pastedText = e.clipboardData.getData('text');
        const sessionReady = Boolean(currentSessionId || newSessionDraftOpen);

        let conversion: LargeTextPasteCandidate | null = null;
        if (largeTextPasteBehavior === 'inline-double-paste') {
            const snapshot = readLargeTextPasteSnapshot();
            if (snapshot && sessionReady && inputMode === 'normal' && imageFiles.length === 0 && otherFiles.length === 0) {
                conversion = largeTextPasteGesture.beginPaste(pastedText, snapshot);
            } else {
                largeTextPasteGesture.invalidate();
            }
        }

        if (imageFiles.length === 0 && otherFiles.length > 0) {
            // A copied file also carries its name as text; keep it out of the draft.
            e.preventDefault();
            if (!sessionReady) return;
            await attachFilesWithCitation(otherFiles);
            return;
        }

        if (imageFiles.length === 0) {
            const behavior: LargeTextPasteBehavior = largeTextPasteBehavior;
            const shouldOfferLargePaste = sessionReady
                && inputMode === 'normal'
                && behavior !== 'inline'
                && (behavior !== 'inline-double-paste' || conversion !== null)
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

            const attachAsFile = async (candidate: LargeTextPasteCandidate | null = null) => {
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
                    currentMessage.slice(0, candidate?.from ?? selectionStart),
                    currentMessage.slice(candidate?.to ?? selectionEnd),
                );

                const file = createPastedContextFile(pastedText, filename);
                // Pending before the citation lands, so it shows as a chip at once.
                pendingPastedAttachmentFilenamesRef.current.add(filename);
                try {
                    if (!candidate) {
                        insertTextAtSelection(
                            insertionText,
                            getFileMentionInputSourceForInsertedText(insertionText),
                        );
                    }

                    if (candidate) {
                        await largeTextPasteGesture.convert(
                            candidate, async () => {
                                const accepted = await addAttachedFile(file);
                                if (!accepted && readLargeTextPasteSnapshot()?.scope === candidate.scope) {
                                    toast.error(t('chat.chatInput.toast.clipboardTextAttachFailed'));
                                }
                                return accepted;
                            }, readLargeTextPasteSnapshot,
                            (from, to, citation) => composerRef.current?.replaceRange(from, to, citation),
                            insertionText,
                        );
                    } else {
                        await addAttachedFile(file);
                    }
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

            if (conversion) {
                await attachAsFile(conversion);
                return;
            }

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

            const resolveLargePaste = (action: 'attach' | 'inline', explicitlyChosen: boolean) => {
                const resolution = resolveLargeTextPasteOffer(
                    largeTextPasteOfferIdRef.current,
                    offerId,
                    { isMobile, explicitlyChosen },
                );
                largeTextPasteOfferIdRef.current = resolution.nextOfferId;
                if (!resolution.accepted) {
                    return;
                }
                largeTextPasteToastIdRef.current = null;
                if (action === 'attach') {
                    void attachAsFile();
                } else {
                    pasteInline();
                }
                // Keep this in the toast tap's gesture: iOS won't raise the
                // keyboard when focus is restored after the attachment awaits.
                if (resolution.restoreFocus) {
                    if (composerRef.current) {
                        composerRef.current.focus({ preventScroll: isCapacitorApp() });
                    } else {
                        // The toast captures the paste-time shell state, but
                        // the editor may have collapsed since then. The
                        // insertion above appends to its draft; expand mounts
                        // and focuses the editor with the platform's keyboard timing.
                        mobileShell.expand();
                    }
                }
            };

            largeTextPasteToastIdRef.current = toast.info(
                t('chat.chatInput.toast.largeTextPaste.title'),
                {
                    duration: Infinity,
                    className: LARGE_TEXT_PASTE_TOAST_CLASSNAME,
                    action: {
                        label: t('chat.chatInput.toast.largeTextPaste.attach'),
                        onClick: () => resolveLargePaste('attach', true),
                    },
                    cancel: {
                        label: t('chat.chatInput.toast.largeTextPaste.inline'),
                        onClick: () => resolveLargePaste('inline', true),
                    },
                    onDismiss: () => {
                        // Dismissing without a choice keeps the paste — insert inline
                        // so clipboard content is not lost.
                        resolveLargePaste('inline', false);
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
        await attachFilesWithCitation([...imageFiles, ...otherFiles], pastedText);
    }, [addAttachedFile, attachFilesWithCitation, currentSessionId, inputMode, isMobile, largeTextPasteBehavior, largeTextPasteGesture, readLargeTextPasteSnapshot, markFileMentionPasteSuppression, message, mobileShell, newSessionDraftOpen, insertTextAtSelection, setMessage, t, updateAutocompleteState]);

    // Android commits an image through the IME instead of the page (see nativeImagePaste).
    React.useEffect(() => {
        setNativeImagePasteEnabled(mobileShell.focused);
    }, [mobileShell.focused]);

    // A composer unmounted while focused must not leave image commits enabled
    // for whatever field gets the keyboard next.
    React.useEffect(() => () => setNativeImagePasteEnabled(false), []);

    React.useEffect(() => subscribeToNativeImagePastes((paste) => {
        // Backstop for the window around the shell re-reading the declaration.
        if (!mobileShell.focused) return;
        if (!paste.ok) {
            toast.error(t('chat.chatInput.toast.clipboardAttachFailed'));
            return;
        }
        if (!currentSessionId && !newSessionDraftOpen) return;
        void attachFilesWithCitation([paste.file]);
    }), [attachFilesWithCitation, currentSessionId, mobileShell.focused, newSessionDraftOpen, t]);

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
        const lastDollarSymbol = textBeforeCursor.lastIndexOf('$');

        if (lastDollarSymbol !== -1) {
            const newMessage =
                message.substring(0, lastDollarSymbol) +
                `$${skillName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = lastDollarSymbol + skillName.length + 2;
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
        if (command.name === 'btw' && currentSessionId) {
            closeAutocomplete();
            void handleSubmitRef.current({ presetText: '/btw' });
            return;
        }
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
            // A chat pinned in the side panel opens on its own time, often
            // while the user already types in the main chat; focusing then
            // would pull the keystrokes into the panel. It takes focus only
            // when the user is already working inside its column (e.g. opened
            // a subtask from there).
            if (columnPinned && !composerFormRef.current?.closest('[data-chat-column]')?.contains(document.activeElement)) return;
            composerRef.current?.focus();
        });
        return () => window.cancelAnimationFrame(frame);
    }, [active, columnPinned, currentSessionId, isMobile]);

    React.useEffect(() => {
        if (!isMobile) {
            setMobileControlsPanel(null);
        }
    }, [isMobile]);

    // A prompt armed for the session this composer leaves goes with it. Only
    // that one: another chat open beside this one arms prompts of its own.
    const abortPromptOwnerRef = React.useRef(currentSessionId);
    React.useEffect(() => {
        const previous = abortPromptOwnerRef.current;
        abortPromptOwnerRef.current = currentSessionId;
        if (previous !== currentSessionId && previous && useSessionUIStore.getState().abortPromptSessionId === previous) {
            clearAbortPrompt();
        }
    }, [currentSessionId, clearAbortPrompt]);

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

        setPendingInputText(mentions.join(' '), 'append-inline', mailboxTarget);
        toast.success(t('chat.chatInput.toast.addedFileMentions', { count: mentions.length }));
    }, [mailboxTarget, setPendingInputText, t, toMentionPath]);

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
            await attachFilesWithCitation(files);
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
        const attachmentDraftKey = useInputStore.getState().attachmentDraftKey;
        const list = Array.isArray(files) ? files : Array.from(files);
        let attached = false;

        for (const file of list) {
            try {
                attached = (await addAttachedFile(file)) || attached;
            } catch (error) {
                console.error('File attach failed', error);
            }
            if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) return;
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
    const guestAttachItems = useGuestAttachItems();
    const openGuestAttach = React.useCallback((guestId: string) => {
        const item = guestAttachItems.find((guest) => guest.id === guestId);
        if (item?.mode === 'dialog') {
            setAttachDialogItem(null);
            setAttachDialogGuestId(guestId);
            return;
        }
        useUIStore.getState().openContextSurface(currentDirectory || '', pluginModeFromId(guestId));
    }, [currentDirectory, guestAttachItems]);
    // Clicking the guest chip reopens that guest with the chip as `ready.item`,
    // so it can show the item's details instead of its whole list. A panel
    // guest gets it through the rail hand-off store; a dialog guest as a prop.
    const reopenGuestItem = React.useCallback((reference: Extract<ComposerReference, { kind: 'guest' }>) => {
        const issue: AttachIssueRequest = {
            providerId: reference.providerId,
            id: reference.id,
            title: reference.title,
            url: reference.url,
            text: reference.contextText,
            kind: reference.thread,
        };
        if (reference.author) issue.author = reference.author;
        if (reference.head && reference.base) {
            issue.branches = { head: reference.head, base: reference.base };
        }
        if (reference.data !== undefined) issue.data = reference.data;
        // A chip can outlive the place it was attached in: the session may be
        // open on mobile or VS Code, where extensions never load, or the
        // extension may be paused or removed here. Say so instead of opening
        // an empty surface.
        const installed = useGuestsStore.getState().guests.find((entry) => entry.id === issue.providerId);
        if (!installed || !isGuestActive(installed)) {
            toast.info(t('chat.chatInput.toast.guestUnavailableHere'));
            return;
        }
        if (!installed.entry) {
            toast.info(t('chat.chatInput.toast.guestHasNoPanel'));
            return;
        }
        const guest = guestAttachItems.find((entry) => entry.id === issue.providerId);
        // Only an extension that declared a dialog gets one; everything else
        // (panel mode, no attach declared) opens the rail with the item.
        if (guest?.mode !== 'dialog') {
            useGuestItemStore.getState().setPendingItem(issue.providerId, issue);
            useUIStore.getState().openContextSurface(currentDirectory || '', pluginModeFromId(issue.providerId));
            return;
        }
        setAttachDialogItem(issue);
        setAttachDialogGuestId(issue.providerId);
    }, [currentDirectory, guestAttachItems, t]);
    const handleGuestAttach = React.useCallback((issue: AttachIssueRequest) => {
        const contextText = issue.text
            ?? `Attached ${issue.providerId} ${issue.id}: ${issue.title}\n${issue.url}`;
        const reference: ComposerReference = {
            kind: 'guest',
            providerId: issue.providerId,
            id: issue.id,
            title: issue.title,
            url: issue.url,
            contextText,
            thread: issue.kind === 'pull' ? 'pull' : 'issue',
            author: issue.author,
            head: issue.branches?.head,
            base: issue.branches?.base,
            data: issue.data,
        };
        setLinkedReferences((current) => withComposerReferences(current, [reference]));
        setAttachDialogGuestId(null);
        setAttachDialogItem(null);
        // A message or session action may have opened the guest in the
        // layout-level dialog; attaching from there closes it the same way.
        useGuestDialogStore.getState().close();
    }, []);
    React.useEffect(() => {
        if (!pendingGuestIssue || columnPinned) {
            return;
        }
        const issue = consumePendingGuestIssue();
        if (issue) {
            handleGuestAttach(issue);
        }
    }, [columnPinned, consumePendingGuestIssue, handleGuestAttach, pendingGuestIssue]);
    React.useEffect(() => {
        if (pendingComposerReferenceCount === 0 || columnPinned) return;
        const references = usePendingComposerReferences.getState().consume();
        if (references.length > 0) {
            setLinkedReferences((current) => withComposerReferences(current, references));
        }
    }, [columnPinned, pendingComposerReferenceCount]);
    const showLinearPicker = Boolean(runtimeLinear) && !isVSCode;
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

    // The one entry to an isolated space: while the feature's switch is on, for a project the
    // branch selector serves, never in VS Code (decision 16). The dialog keeps the project it
    // was opened for, whatever the draft picks after.
    const isolatedSpacesEnabled = useUIStore((state) => state.isolatedSpacesEnabled);
    const [newSpaceProject, setNewSpaceProject] = React.useState<{ id: string; path: string } | null>(null);
    // A message sent while the space is still being made waits for it; the composer is empty
    // then, so this line is the only sign that the message was not lost.
    const draftRequestId = newSessionDraft?.pendingWorktreeRequestId ?? null;
    const messageWaitsForSpace = React.useSyncExternalStore(
        subscribeDraftSendWaiting,
        () => isDraftSendWaiting(draftRequestId) && isSpaceCreationRequest(draftRequestId),
    );
    const handleCreateSpace = React.useMemo(() => {
        if (!isolatedSpacesEnabled || isVSCode || !selectedDraftProject || selectedDraftProject.kind === 'chat') return undefined;
        const project = { id: selectedDraftProject.id, path: selectedDraftProject.path };
        return () => setNewSpaceProject(project);
    }, [isVSCode, isolatedSpacesEnabled, selectedDraftProject]);

    // The full New Worktree dialog for the draft's project, so a named worktree, an existing
    // branch or a PR branch can be made where the sidebar has no project headers (Timeline).
    const [newWorktreeProject, setNewWorktreeProject] = React.useState<{ id: string; path: string } | null>(null);
    const handleCreateCustomWorktree = React.useMemo(() => {
        if (!selectedDraftProject || selectedDraftProject.kind === 'chat') return undefined;
        const project = { id: selectedDraftProject.id, path: selectedDraftProject.path };
        return () => setNewWorktreeProject(project);
    }, [selectedDraftProject]);
    const handleCustomWorktreeCreated = React.useCallback((worktreePath: string) => {
        const project = newWorktreeProject;
        if (!project) return;
        // Pin the draft to the new directory: until the worktree list refreshes,
        // the draft's validity check would otherwise reset it to the project root.
        const sessionStore = useSessionUIStore.getState();
        if (sessionStore.newSessionDraft.open) {
            sessionStore.overrideNewSessionDraftTarget({
                projectId: project.id,
                directoryOverride: worktreePath,
                pendingWorktreeRequestId: null,
                bootstrapPendingDirectory: worktreePath,
                preserveDirectoryOverride: true,
            });
        } else {
            sessionStore.openNewSessionDraft({
                selectedProjectId: project.id,
                directoryOverride: worktreePath,
                bootstrapPendingDirectory: worktreePath,
                preserveDirectoryOverride: true,
            });
        }
        useDirectoryStore.getState().setDirectory(worktreePath, { showOverlay: false });
    }, [newWorktreeProject]);

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


    // The record-and-send overlay holds the composer open until its submit
    // settles; the hold is released here (both handlers cover every exit).
    const dictationSendEndRef = React.useRef<(() => void) | null>(null);
    dictationSendEndRef.current = () => {
        dictationSendInFlightRef.current = false;
        mobileShell.holdDictationSend(false);
    };
    const handleDictationSendStart = React.useCallback(() => {
        // Only the mobile shell collapses on dictation end, and only its
        // dictation reports when it ends, which is what releases a hold
        // that never reaches a submit.
        if (isMobile) mobileShell.holdDictationSend(true);
    }, [isMobile, mobileShell]);
    // A record-and-send that never reaches a submit (failed or empty
    // transcript, cancel, a transcript kept for another draft) still releases
    // the hold once dictation ends. The transcript callback runs in the same
    // tick the status turns idle, so a real send is already in flight here.
    const { onDictationActiveChange } = mobileShell;
    const handleDictationActiveChange = React.useCallback((active: boolean) => {
        onDictationActiveChange(active);
        if (!active && !dictationSendInFlightRef.current) dictationSendEndRef.current?.();
    }, [onDictationActiveChange]);

    // Mobile comment mode: subscription, scope ownership and the attach/cancel
    // transitions live in the hook; ChatInput only renders from it.
    const mobileComment = useMobileCommentComposerMode({
        isMobile,
        runtimeKey: activeRuntimeKey,
        directory: inlineDraftDirectory,
        sessionKey: inlineDraftSessionKey,
        mobileShell,
    });
    const mobileCommentActive = mobileComment.active;
    attachMobileCommentRef.current = mobileComment.submit;


    const applyAssistSuggestion = React.useCallback((text: string) => {
        setMessage(text);
        if (isMobile && !mobileComposerExpanded) {
            mobileShell.expand();
        } else {
            requestAnimationFrame(() => composerRef.current?.focus());
        }
    }, [isMobile, mobileComposerExpanded, mobileShell]);

    // Linked references render as chips beside the attached files, inside the
    // composer box and inside the mobile pill.
    const linkedReferenceChips = !isVSCode && hasLinkedReferences ? (
        <div className="flex flex-wrap items-center gap-2 pt-2">
            {linkedReferences.map((reference) => {
                const key = composerReferenceKey(reference);
                const remove = () => setLinkedReferences((current) => withoutComposerReference(current, key));
                switch (reference.kind) {
                    case 'repository-issue':
                        return (
                            <LinkedReferenceRow
                                key={key}
                                numberLabel={`#${reference.number}`}
                                title={reference.title}
                                url={reference.url}
                                author={reference.author}
                                openInBrowserLabel={t('chat.chatInput.linked.issue.openInBrowserAria')}
                                removeLabel={t('chat.chatInput.linked.issue.removeAria')}
                                onReopenPicker={() => setReferencePicker({ source: 'github', kind: 'issue' })}
                                onRemove={remove}
                            />
                        );
                    case 'change-request':
                        return (
                            <LinkedReferenceRow
                                key={key}
                                numberLabel={reference.provider === 'github'
                                    ? t('chat.chatInput.linked.pr.number', { number: reference.number })
                                    : formatChangeRequestReference(reference.provider, reference.number)}
                                title={reference.title}
                                url={reference.url}
                                author={reference.author}
                                branches={reference.head && reference.base ? { head: reference.head, base: reference.base } : undefined}
                                openInBrowserLabel={t(changeRequestCopy('chat.chatInput.linked.pr.openInBrowserAria', reference.provider))}
                                removeLabel={t(changeRequestCopy('chat.chatInput.linked.pr.removeAria', reference.provider))}
                                onReopenPicker={() => setReferencePicker({ source: 'github', kind: 'pull' })}
                                onRemove={remove}
                            />
                        );
                    case 'linear-issue':
                        return (
                            <LinkedReferenceRow
                                key={key}
                                numberLabel={reference.identifier}
                                title={reference.title}
                                url={reference.url}
                                author={reference.author}
                                openInBrowserLabel={t('chat.chatInput.linked.linearIssue.openInBrowserAria')}
                                removeLabel={t('chat.chatInput.linked.linearIssue.removeAria')}
                                onReopenPicker={() => setReferencePicker({ source: 'linear' })}
                                onRemove={remove}
                            />
                        );
                    case 'guest':
                        return (
                            <LinkedReferenceRow
                                key={key}
                                numberLabel={reference.thread === 'pull'
                                    ? t('chat.chatInput.linked.guest.pr.number', { id: reference.id })
                                    : reference.id}
                                title={reference.title}
                                url={reference.url}
                                author={reference.author ? { login: reference.author } : undefined}
                                branches={reference.thread === 'pull' && reference.head && reference.base
                                    ? { head: reference.head, base: reference.base }
                                    : undefined}
                                openInBrowserLabel={t('chat.chatInput.linked.guest.openInBrowserAria', { id: reference.id })}
                                removeLabel={t('chat.chatInput.linked.guest.removeAria', { id: reference.id })}
                                onReopenPicker={() => reopenGuestItem(reference)}
                                onRemove={remove}
                            />
                        );
                }
            })}
        </div>
    ) : null;
    // Pending context (review comments, quotes, terminal selections) sits in
    // the attachment row like any attachment; its preview opens above the
    // composer, outside the clipping glass box.
    const contextChips = hasDrafts ? (
        <ComposerContextChips
            draftTarget={inlineDraftTarget}
            colors={currentTheme.colors}
            previewHost={contextPreviewHost}
        />
    ) : null;
    // The suggested follow-up is the composer's own top row on every surface
    // (inside the mobile pill and the box alike); on mobile the model and
    // agent are its bottom row too, so the surface stays one shape.
    const suggestionHidden = hasContent || newSessionDraftOpen || isBtwActive || isBtwPanelVisible || queuedMessages.length > 0 || hasPendingForm;
    const suggestionRow = !isBtwActive ? (
        <SessionSuggestionChip
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
            hidden={suggestionHidden}
            onApply={applyAssistSuggestion}
        />
    ) : null;
    // Jev's "looks done" hint shares the composer's top row slot, above the
    // suggestion, so nothing below the input moves.
    const doneHintRow = !isBtwActive && !newSessionDraftOpen ? (
        <SessionDoneHintRow
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
        />
    ) : null;
    // The offer to look over what the last turn changed takes the same slot;
    // the server writes either it or the done hint, never both. Neither the
    // AI review nor the walkthrough is offered on a mobile layout.
    const openReviewDialog = React.useCallback(() => setReviewDialogOpen(true), []);
    const reviewHintRow = !isBtwActive && !newSessionDraftOpen && !isMobile ? (
        <SessionReviewHintRow
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
            onAIReview={openReviewDialog}
        />
    ) : null;
    // Commands the agent left running sit in the same slot, first, so a
    // forgotten dev server is visible without scrolling the chat. Keyed by
    // session so an expanded list collapses on a session switch.
    const backgroundShellsRow = !isBtwActive && !newSessionDraftOpen ? (
        <BackgroundShellsStrip
            key={currentSessionId ?? ''}
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
        />
    ) : null;
    // A new worktree still running its setup commands, first of all: until it
    // ends, a first prompt can wait with nothing else saying why.
    const worktreeSetupDirectory = currentSessionDirectoryForSync ?? currentDirectory ?? null;
    const worktreeSetupPending = useWorktreeBootstrapPending(isBtwActive ? null : worktreeSetupDirectory);
    const worktreeSetupRow = worktreeSetupPending ? <WorktreeSetupStrip /> : null;
    // Null exactly when the suggestion row alone would have been: the mobile
    // pill picks its shape from whether a top row exists.
    const composerTopRows = worktreeSetupRow || backgroundShellsRow || doneHintRow || reviewHintRow || suggestionRow ? (
        <>
            {worktreeSetupRow}
            {backgroundShellsRow}
            {doneHintRow}
            {reviewHintRow}
            {suggestionRow}
        </>
    ) : null;
    const mobileModelAgentRow = isMobile && !isBtwActive ? (
        // px-3.5 lines the model logo and the agent label up with the attach
        // and mic icons above them; the buttons drop their own padding so the
        // row alone owns the inset.
        <div className="flex items-center justify-between gap-x-2 px-3.5 pb-2 pt-0.5">
            <MemoMobileModelButton onOpenModel={() => handleOpenMobilePanel('model')} className="min-w-0 px-0" />
            <MemoMobileAgentButton
                onOpenAgentPanel={handleOpenAgentPanel}
                onCycleAgent={handleCycleAgent}
                className="flex-shrink-0 px-0"
            />
        </div>
    ) : null;

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
    const permissionScopeSessionId = isBtwActive ? btwSessionId : currentSessionId ?? currentManagementSessionId;
    const safetyNetAvailable = useRoutingStore(selectSafetyNetAvailable);
    // A session not created yet (a draft, an unsent btw fork) shows its own
    // choice, else the mode the server will give it: the Settings default.
    // VS Code has no server to apply one.
    const defaultPermissionMode = useUIStore((state) => (isVSCode ? 'ask' : state.permissionDefaultMode));
    const permissionMode = usePermissionStore((state) => {
        if (isBtwActive && !btwSessionId) return pendingBtwPermissionMode ?? defaultPermissionMode;
        if (!permissionScopeSessionId) {
            return draftPermissionMode ?? defaultPermissionMode;
        }
        return state.getSessionMode(permissionScopeSessionId);
    });
    const shownPermissionMode = displayedPermissionMode(permissionMode, safetyNetAvailable);
    const isPermissionAutoAcceptInteractive = Boolean(permissionScopeSessionId || newSessionDraftOpen);

    const handlePermissionModeCycle = React.useCallback(() => {
        if (isBtwActive && !btwSessionId && currentSessionId) {
            useBtwStore.getState().setPanelState(currentSessionId, {
                pendingPermissionMode: nextPermissionMode(permissionMode, safetyNetAvailable),
            });
            return;
        }
        cyclePermissionMode({
            permissionScopeSessionId,
            newSessionDraftOpen,
            currentMode: permissionMode,
            safetyAvailable: safetyNetAvailable,
            setDraftPermissionMode,
            setSessionMode,
            onOpenSessionFirst: () => toast.error(t('chat.chatInput.toast.openSessionFirst')),
            onToggleFailed: () => toast.error(t('chat.chatInput.toast.togglePermissionAutoAcceptFailed')),
        });
    }, [
        newSessionDraftOpen,
        permissionMode,
        permissionScopeSessionId,
        safetyNetAvailable,
        isBtwActive,
        btwSessionId,
        currentSessionId,
        setDraftPermissionMode,
        setSessionMode,
        t,
    ]);

    useKeybind('toggle_permission_auto_accept', () => {
        if (!isPermissionAutoAcceptInteractive) return false;
        handlePermissionModeCycle();
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
            data-btw-composer={isBtwActive ? 'true' : undefined}
            onContextMenuCapture={() => largeTextPasteGesture.invalidate()}
            // Whichever composer the user works in holds the selected
            // attachment slot, so its paste, drop, picker and remove act on
            // its own files when a second chat is open beside it.
            onPointerDownCapture={claimAttachmentSlot}
            onFocusCapture={claimAttachmentSlot}
            onDragEnterCapture={claimAttachmentSlot}
            onKeyDownCapture={(event) => {
                if (!isBtwActive || event.key !== 'Escape' || isIMECompositionEvent(event) || hasOpenDropdown()) return;
                if (!(event.target instanceof Element) || !event.target.closest('[data-chat-input-footer]')) return;
                // Footer tooltips must not consume the only exit key for a pending BTW.
                event.preventDefault();
                event.stopPropagation();
                handleExitBtw();
            }}
            onSubmit={(e) => {
                e.preventDefault();
                // Comment mode owns the form: submit attaches the comment and
                // must never reach the send path.
                if (mobileCommentActive) {
                    attachMobileCommentRef.current();
                    return;
                }
                handlePrimaryAction();
            }}
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
                {/* Comment mode shows only its own shell: the normal composer's
                    furniture (chips, banners, draft selectors) stays in state
                    and returns unchanged when the comment exits. */}
                {!mobileCommentActive ? (<>
                <AutoReviewBanner />

                <RevertedMessageDock
                    sessionId={currentSessionId}
                    directory={currentSessionDirectoryForSync ?? currentDirectory}
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
                            onCreateSpace={handleCreateSpace}
                            onCreateCustomWorktree={handleCreateCustomWorktree}
                            theme={currentTheme}
                        />
                    </div>
                ) : null}
                {showDraftTargetSelectors && messageWaitsForSpace ? (
                    <p className="mb-1.5 flex items-center gap-1.5 px-0.5 typography-meta text-muted-foreground" role="status">
                        <Icon name="time" className="size-3.5 shrink-0" />
                        {t('spaces.draft.queued')}
                    </p>
                ) : null}
                {isMobile && showDraftTargetSelectors && selectedDraftProject ? (
                    <MobileDraftTargetTriggers
                        selectedProject={selectedDraftProject}
                        selectedBranchLabel={selectedDraftBranchLabel}
                        showBranchSelector={shouldShowDraftBranchSelector}
                        theme={currentTheme}
                        onOpenPicker={setMobileDraftPicker}
                    />
                ) : null}
                </>) : null}
                <div
                    // Desktop: layout-transparent. Mobile: positioning host for
                    // the wrapper-level dictation overlay across pill/full states.
                    data-dictation-host="true"
                    // Mobile: the context-chip preview opens above this host.
                    ref={isMobile ? setContextPreviewHost : undefined}
                    className={cn(
                        !isMobile && 'contents',
                        isMobile && 'relative',
                        isMobileExpanded && 'flex min-h-0 flex-1 flex-col',
                    )}
                >
                {mobileCommentActive && mobileComment.draft.status === 'open' ? (
                    // Keyed by generation: a replaced open remounts the shell
                    // so its dictation callbacks can never target the
                    // previous quote.
                    <MobileCommentComposer
                        key={mobileComment.draft.generation}
                        draft={mobileComment.draft}
                        theme={currentTheme}
                        handlers={mobileComment.handlers}
                    />
                ) : isMobile && !mobileComposerExpanded && !isBtwActive ? (
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
                        sendIconSizeClass={sendIconSizeClass}
                        stopIconSizeClass={stopIconSizeClass}
                        topRow={composerTopRows}
                        attachments={(
                            <div className="px-3 pt-1">
                                <AttachedFilesList draftIdentity={chatDraftIdentity} onShowPopup={handleShowAttachmentPreview} className="pt-2" />
                                {linkedReferenceChips}
                                {contextChips}
                            </div>
                        )}
                        bottomRow={mobileModelAgentRow}
                        onExpand={mobileShell.expand}
                        onPrimaryAction={handlePrimaryAction}
                        onQueueMessage={() => { void handleQueueMessage(); }}
                        onPickLocalFiles={handlePickLocalFiles}
                        onOpenGitHubPicker={openGitHubPicker}
                        repositoryProvider={repositoryProvider}
                        showLinearPicker={showLinearPicker}
                        onOpenLinearPicker={openLinearPicker}
                        onOpenAttachSheet={openMobileAttachSheet}
                        onStartDictation={toggleDictation}
                        onAbort={handleAbort}
                    />
                ) : (
                <>
                {!isBtwActive ? <SessionGoalRow
                    sessionId={currentSessionId}
                    directory={currentSessionDirectoryForSync ?? currentDirectory}
                    className="mb-1.5"
                /> : null}
                {/* The autocomplete popups anchor to this wrapper, not to the
                    glass box: a backdrop-filter ancestor is a backdrop root,
                    so a glass popup inside the box would only blur the box's
                    own contents and read as a flat tint over the transcript. */}
                <div
                    ref={isMobile ? undefined : setContextPreviewHost}
                    className={cn('relative', isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}
                >
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
                {/* The lift shadow lives on this wrapper, away from the glass
                    box's backdrop-filter: on the same element Chromium grows
                    the glass layer by the shadow's blur, and that band painted
                    a flat grey strip over the bottom of the goal row above. */}
                <div
                    className={cn(
                        'flex flex-col',
                        isComposerExpanded && 'flex-1 min-h-0',
                        'shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]',
                    )}
                    style={{ borderRadius: chatInputRadius }}
                >
                <div
                    className={cn(
                        "flex flex-col relative overflow-visible",
                        isComposerExpanded && 'flex-1 min-h-0',
                        "border border-border/80 focus-within:border-interactive-selection-foreground/35",
                        // The box floats over the transcript, so it is glass.
                        'oc-glass-composer',
                        isDragging && "ring-2 ring-primary ring-offset-2"
                    )}
                    style={{ borderRadius: chatInputRadius }}
                    ref={dropZoneRef}
                    // The mobile pill morph measures and animates this box.
                    data-composer-box={isMobile ? 'true' : undefined}
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

                    {/* Positioning context for the dictation overlay: covers the
                        text area + footer exactly. */}
                    <div className={cn('relative flex flex-col', isComposerExpanded && 'flex-1 min-h-0')}>
                    <div className={cn("overflow-hidden", isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}>
                        {parallel.isActive ? <ParallelComposerStrip parallel={parallel} project={parallelProjectRef} /> : null}
                        {composerTopRows}
                        {isMobile && isBtwActive ? (
                            <div className="scrollbar-none relative z-10 flex items-center gap-x-2 overflow-x-auto px-3 pb-0.5 pt-1.5">
                                <ModelControls
                                    className="flex-1 min-w-0"
                                    sessionId={btwComposerSessionId}
                                    selection={effectiveBtwSelection}
                                />
                            </div>
                        ) : null}
                        <div className="flex items-center gap-1 px-3 pt-1 flex-wrap relative z-10">
                            <AttachedFilesList draftIdentity={chatDraftIdentity} onShowPopup={handleShowAttachmentPreview} className="pt-2" />
                            {!isBtwActive ? linkedReferenceChips : null}
                            {contextChips}
                            <AttachedVSCodeFileChips draftIdentity={chatDraftIdentity} onShowPopup={handleShowAttachmentPreview} />
                            {!isBtwActive ? <ActiveEditorFileSuggestion /> : null}
                        </div>
                        <div
                            ref={dictationHeightHostRef}
                            className={cn("relative overflow-hidden", isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}
                            // The mobile pill morph moves this block from the
                            // pill's text line and unfurls it.
                            data-composer-morph-prompt={isMobile ? 'true' : undefined}
                            onDragEnter={handleDragEnter}
                            onDragOver={handleDragOver}
                            onDropCapture={handleDropCapture}
                            onDrop={handleDrop}
                            onDragEnd={handleDragEnd}
                            style={dictationContentHeight !== null && !isComposerExpanded
                                ? {
                                    minHeight: `${Math.min(
                                        dictationContentHeight,
                                        dictationHeightLimit ?? dictationContentHeight,
                                    )}px`,
                                }
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
                                onKeyUp={(event) => largeTextPasteGesture.keyUp(event)}
                                onSelectionChange={(selection) => {
                                    largeTextPasteGesture.invalidate();
                                    cursorPosRef.current = selection.start;
                                    updateAutocompleteOverlayPosition();
                                }}
                                onFocus={mobileShell.onEditorFocus}
                                onBlur={() => {
                                    largeTextPasteGesture.invalidate();
                                    mobileShell.onEditorBlur();
                                }}
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
                                preserveDeferredEnterShift={!enterToSendConfigured || !isMobile}
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
                                            ? 'pt-4 pb-2.5'
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
                        permissionMode={shownPermissionMode}
                        isPermissionAutoAcceptInteractive={isPermissionAutoAcceptInteractive}
                        dictationActive={mobileShell.dictationActive}
                        onOpenSettings={onOpenSettings}
                        onPickLocalFiles={handlePickLocalFiles}
                        onOpenGitHubPicker={openGitHubPicker}
                        repositoryProvider={repositoryProvider}
                        showLinearPicker={showLinearPicker}
                        onOpenLinearPicker={openLinearPicker}
                        attachGuests={isMobile ? [] : guestAttachItems}
                        onOpenGuestAttach={openGuestAttach}
                        onOpenAttachSheet={openMobileAttachSheet}
                        onToggleExpandedInput={handleToggleExpandedInput}
                        onCyclePermissionMode={handlePermissionModeCycle}
                        onPrimaryAction={handlePrimaryAction}
                        onQueueMessage={handleQueueMessage}
                        onAbort={handleAbort}
                        onStartDictation={toggleDictation}
                        onDictationInsert={handleDictationInsert}
                        onDictationInsertAndSend={handleDictationInsertAndSend}
                        onDictationSendStart={handleDictationSendStart}
                        onDictationStart={markDictationStart}
                        onDictationContentHeightChange={handleDictationContentHeightChange}
                        isBtw={isBtwActive}
                        modelSessionId={btwComposerSessionId}
                        btwSelection={effectiveBtwSelection}
                        pinnedSelection={pinnedComposerSelection}
                        onRunInParallel={!isMobile && !isBtwActive && !columnPinned ? handleRunInParallel : undefined}
                        parallelRun={parallel.isActive ? {
                            runCount: parallel.runCount,
                            launching: parallel.isLaunching,
                            onLaunch: () => { void parallel.launch(); },
                        } : null}
                    />
                    {mobileModelAgentRow}
                    </div>

                </div>
                </div>
                </div>
                </>
                )}
                {/* Wrapper-level dictation engine + overlay: stays mounted across
                    the pill ↔ composer swap so a recording started from the pill
                    survives the morph. Its absolute overlay covers whichever
                    shape the wrapper currently has. NOT mounted during comment
                    mode: the comment shell runs its own comment-scoped engine,
                    and two engines would both answer the global dictation
                    toggle (an in-flight recording is discarded by the swap —
                    its transcript must never reach the normal draft). */}
                {isMobile && !isBtwActive && !mobileCommentActive ? (
                    <MemoComposerDictation
                        radius={chatInputRadius}
                        isMobile={isMobile}
                        footerIconButtonClass={footerIconButtonClass}
                        footerPaddingClass={footerPaddingClass}
                        iconSizeClass={iconSizeClass}
                        sendIconSizeClass={sendIconSizeClass}
                        onInsert={handleDictationInsert}
                        onInsertAndSend={handleDictationInsertAndSend}
                        onSendStart={handleDictationSendStart}
                        onStart={markDictationStart}
                        onActiveChange={handleDictationActiveChange}
                        onContentHeightChange={handleDictationContentHeightChange}
                        renderTrigger={false}
                    />
                ) : null}
                </div>
                {/* Hidden host for the model/agent/variant bottom sheets. Kept
                    outside the pill conditional so an open panel survives (and
                    stays visible over) the collapsed composer. */}
                {isMobile && !isBtwActive ? (
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
            {/* The agent's requests outrank the queue: BTW, then a permission,
                then the form, then the queue, then the suggestion. */}
            <PermissionDock
                sessionId={currentSessionId}
                directory={currentSessionDirectoryForSync ?? currentDirectory ?? undefined}
                hidden={newSessionDraftOpen || isBtwActive || isBtwPanelVisible}
            />
            <FormDock
                sessionId={currentSessionId}
                directory={currentSessionDirectoryForSync ?? currentDirectory ?? undefined}
                hidden={newSessionDraftOpen || isBtwActive || isBtwPanelVisible || hasPendingPermission}
            />
            <QueuedMessageChips
                key={parentMessageQueueKey}
                target={parentMessageQueueTarget}
                hidden={newSessionDraftOpen || isBtwActive || isBtwPanelVisible || hasPendingForm || mobileCommentActive}
                onEditMessage={handleQueuedMessageEdit}
                onSendMessage={handleQueuedMessageSend}
            />
            {currentSessionId ? <BtwPanel parentSessionId={currentSessionId} panel={btwPanel} onExit={handleExitBtw} /> : null}
        </form>

        {referencePicker ? (
            <ReferencePickerDialog
                open
                onOpenChange={(open) => {
                    if (!open) setReferencePicker(null);
                }}
                source={referencePicker.source}
                purpose="attach"
                selection="multiple"
                directory={referencePickerDirectory}
                initialGitHubKind={referencePicker.source === 'github' ? referencePicker.kind : undefined}
                onConfirm={attachReferences}
            />
        ) : null}
        {attachDialogGuestId && !isMobile ? (
            <React.Suspense fallback={null}>
                <GuestAttachDialog
                    guestId={attachDialogGuestId}
                    item={attachDialogItem}
                    onOpenChange={(open) => {
                        if (!open) {
                            setAttachDialogGuestId(null);
                            setAttachDialogItem(null);
                        }
                    }}
                />
            </React.Suspense>
        ) : null}
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
                            requestAnimationFrame(openGitHubPicker);
                        }}
                    >
                        <Icon name={repositoryProvider === 'gitlab' ? 'gitlab' : 'github'} className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                        {t(repositoryProvider === 'gitlab' ? 'chat.chatInput.actions.linkGitlab' : 'chat.chatInput.actions.linkGithub')}
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
                onCreateSpace={handleCreateSpace}
                onCreateCustomWorktree={handleCreateCustomWorktree}
                theme={currentTheme}
                openPicker={mobileDraftPicker}
                onOpenPickerChange={setMobileDraftPicker}
            />
        ) : null}
        {newSpaceProject ? (
            <NewSpaceDialog open onOpenChange={(open) => { if (!open) setNewSpaceProject(null); }} project={newSpaceProject} />
        ) : null}
        {newWorktreeProject ? (
            <NewWorktreeDialog
                open
                onOpenChange={(open) => { if (!open) setNewWorktreeProject(null); }}
                project={newWorktreeProject}
                onWorktreeCreated={handleCustomWorktreeCreated}
            />
        ) : null}
        </>
    );
};

ChatInputComponent.displayName = 'ChatInput';

export const ChatInput = React.memo(ChatInputComponent);

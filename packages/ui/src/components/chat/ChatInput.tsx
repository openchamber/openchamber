import React from 'react';
import { DraftProjectName } from '@/components/chat/DraftProjectName';
import { formatChangeRequestLabel } from '@/lib/source-control/providers/terminology';
import { useSourceControlDescriptorOf, useSourceControlProvider } from '@/lib/source-control/providers/registry';
import { ProviderIcon } from '@/components/sourceControl/ProviderIcon';
import { ComposerDictation } from '@/components/dictation/ComposerDictation';
// sessionStore removed — currentSessionId comes from useSessionUIStore
import { useConfigStore } from '@/stores/useConfigStore';
import { filterVisibleAgents } from '@/stores/useAgentsStore';
import { useUIStore } from '@/stores/useUIStore';
import { isServerOwnedMessageQueue, createMessageQueueTarget, getMessageQueueKey, useMessageQueueStore, type QueuedContextPart, type QueuedMessage, type QueuedMessageGoal } from '@/stores/messageQueueStore';
import { selectAutoReviewRunning, useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { DraftSendError, useSessionUIStore, type NewSessionDraftState } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { prepareUserMessageResume } from '@/sync/user-message-resume';
import { prepareLocalAttachments, useDraftAttachedFiles, useInputStore, type ComposerAddress, type SyntheticContextPart } from '@/sync/input-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { openParallelComposer } from '@/lib/multirun/openParallelComposer';
import { useParallelComposer } from './composer/parallel/useParallelComposer';
import { ParallelComposerStrip } from './composer/parallel/ParallelComposerStrip';
import {
    ACCEPTED_ATTACHMENT_EXTENSIONS,
    ATTACHMENT_ACCEPT,
    getUnsupportedAttachmentInputs,
    isReadOnSendMentionFilename,
    prepareAttachmentFile,
    type AttachmentInputModality,
} from '@/sync/attachment-files';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { RepositoryReferenceKind } from '@/lib/api/types';
import * as sessionActions from '@/sync/session-actions';
// Guest surfaces load on demand: VS Code and mobile never mount them, and the
// composer must not pay for the guest bridge before an extension is installed.
const GuestAttachDialog = React.lazy(() => import('@/components/layout/GuestAttachDialog').then((module) => ({ default: module.GuestAttachDialog })));
import type { AttachIssueRequest } from '@openchamber/sdk';
import { getInlineCommentDraftKey, useInlineCommentDraftStore, type InlineCommentDraft, type InlineCommentDraftTarget } from '@/stores/useInlineCommentDraftStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { loadMagicPrompts } from '@/lib/magicPrompts';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
    createChatDraftIdentity,
    readChatDraft,
    readChatDraftClaimingFolderDraft,
    workDraftComposerKey,
    getChatDraftIdentityKey,
    clearChatDraft,
    type ChatDraftIdentity,
    type ChatDraftSnapshot,
} from '@/lib/chatDraftPersistence';
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { ReviewFlowDialog } from '@/components/session/ReviewFlowDialog';
import { useReviewFlowStart } from '@/components/session/useReviewFlowStart';
import { BtwPanel } from './btw/BtwPanel';
import { btwHoldsDock, useBtwPanelState } from './btw/useBtwPanelState';
import { btwModelAvailability, resolveBtwSelection, useBtwStore } from '@/stores/useBtwStore';
import { buildBtwSyntheticTexts, btwPendingComposerKey, preparePendingBtwSend, startBtwSession } from '@/lib/btw';
import { AttachedFilesList, AttachedVSCodeFileChips, ActiveEditorFileSuggestion } from './FileAttachment';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import type { ToolPopupContent } from './message/types';
import { QueuedMessagesStrip } from './QueuedMessagesStrip';
import { AutoReviewStrip } from './AutoReviewStrip';
import { PullRequestWatchStrip } from './PullRequestWatchStrip';
import type { FileMentionHandle } from './FileMentionAutocomplete';
import type { CommandAutocompleteHandle, CommandInfo } from './CommandAutocomplete';
import type { SkillAutocompleteHandle } from './SkillAutocomplete';
import type { SnippetAutocompleteHandle } from './SnippetAutocomplete';
import { withoutSnippetToken } from '@/lib/snippetNames';
import type { EmojiAutocompleteHandle } from '@/components/emoji/EmojiAutocomplete';
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
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { toast } from '@/components/ui';
// useMessageStore removed — messages now come from sync system
import { getSettingsSurface } from '@/lib/settings/surface';
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
import {
    loadSessionLinkReference,
    sessionLinkText,
    sessionReference,
    sessionReferenceKey,
    sessionReferencesInText,
    type SessionReference,
} from './composer/sessionReferences';
import { findSessionLinks, sessionLinkKey, type SessionLinkTarget } from '@/lib/sessionLinks';
import { sessionMentionChip } from '@/lib/messages/sessionMentionChip';
import { appOwnOrigins } from '@/lib/router/appOrigins';
import type { Session } from '@/lib/opencode/model';
import { usePendingComposerReferences } from './composer/pendingComposerReferences';
import { postTrackerSessionStarted } from '@/lib/trackers/sessionStatus';
import { trackerPresentation } from '@/lib/trackers/presentation';
import { useTrackerDescriptors } from '@/lib/trackers/registry';
import { useTrackerSources } from '@/lib/trackers/sources';
import { trackerReferenceSource, type TrackerReferenceSource } from '@/components/references/referencePickerItems';
import type { ComposerTrackerPicker } from './composer/ui/ComposerAttachmentControls';
import { Icon } from "@/components/icon/Icon";
import { DraftPresetChips } from './DraftPresetChips';
import type { ResolvedStarter } from './useDraftStarters';
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
import { selectAvailableSkillsForDirectory, useSkillsStore } from '@/stores/useSkillsStore';
import { selectCommandsForComposer, useCommandsStore } from '@/stores/useCommandsStore';
import { useComposerConfigDirectory } from '@/hooks/useComposerConfigDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { usePermissionStore } from '@/stores/permissionStore';
import { cyclePermissionMode } from './permissionAutoAccept';
import { displayedPermissionMode, nextPermissionMode } from '@/stores/utils/permissionAutoAccept';
import { selectAutoReady, selectSafetyNetAvailable, useRoutingStore } from '@/stores/useRoutingStore';
import { useKeybind, useKeybinds } from '@/hooks/useKeybind';
import { getNextFavoriteModel } from '@/lib/modelRefs';
import { hasOpenDropdown } from '@/hooks/keyboard-shortcut-dom';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { useI18n } from '@/lib/i18n';
import { useDraftHeading } from './useDraftHeading';
import { sessionEvents } from '@/lib/sessionEvents';
import { useOpenCodeStartupStore } from '@/sync/opencode-startup-gate';
import { eventMatchesShortcut, getEffectiveShortcutCombo, normalizeCombo, shortcutRegistry } from '@/lib/shortcuts';
import {
    assignImageAttachmentFilenames,
    buildAttachmentCitationText,
    buildImagePathCitationText,
    findImagePathCitationNames,
    imageSaveModeForModel,
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
    beginLargeTextPasteOffer,
    resolveLargeTextPasteOffer,
} from './composer/largeTextPasteOffer';
import type { LargeTextPasteBehavior } from '@/stores/useUIStore';
import type { FileMentionAutocompleteInputSource } from './fileMentionAutocompleteState';
import {
    classifyMention,
    scanMentions,
} from './composer/language/mentions';
import { collectKnownTokenNames, lastPrefixSigilIndex } from './composer/language/prefixTokens';
import { resolveAutocompleteTrigger, type AutocompleteKind } from './composer/language/triggers';
import { hasSessionMention } from './sessionMentionResults';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { type ComposerLanguageContext } from './composer/language/tokenize';
import {
    ComposerEditor,
    type ComposerChange,
    type ComposerEditorHandle,
    type ComposerSelection,
} from './composer/editor/ComposerEditor';
import { useComposerHeightLimit } from './composer/editor/useComposerHeightLimit';
import { usePendingComposerText } from './composer/state/usePendingComposerText';
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
import { useMessageHistory, type MessageHistoryValue } from './composer/state/useMessageHistory';
import type { PromptHistoryCandidate } from './composer/state/promptHistorySearch';
import { registerPromptHistorySearchRoute } from './composer/state/promptHistorySearchRoute';
import { useComposerDraft } from './composer/state/useComposerDraft';
import { MentionCompletionState } from './composer/state/mentionCompletion';
import { useSessionDraftPublishing } from './composer/state/useSessionDraftPublishing';
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
import { isSpaceCreationRequest } from '@/lib/spaces/space-creation-requests';
import { spaceModelRefusal, stoppedSpaceOfTarget } from '@/lib/spaces/space-model-access';
import { runSpaceAction } from '@/lib/spaces/space-repair';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { isDraftSendWaiting, subscribeDraftSendWaiting } from '@/lib/worktrees/pendingDraftWorktree';
import { ComposerAutocompletePopups } from './composer/ui/ComposerAutocompletePopups';
import { ComposerFooter } from './composer/ui/ComposerFooter';
import { MobilePillComposer } from './composer/ui/MobilePillComposer';
import { PromptHistorySearchPanel } from './composer/ui/PromptHistorySearchPanel';
import { ComposerContextChips } from './composer/ui/ComposerContextChips';
import { LargeTextPasteChoice, type LargeTextPasteChoiceAction } from './composer/ui/LargeTextPasteChoice';
import { LinkedReferenceRow } from './composer/ui/LinkedReferenceRow';
import { usePlaceholderFitsOneLine } from './composer/ui/usePlaceholderFitsOneLine';
import { RevertedMessagesStrip } from './RevertedMessagesStrip';
import { SessionSuggestionChip } from '@/components/chat/SessionSuggestionChip';
import { SessionDoneHintRow } from '@/components/chat/SessionDoneHintRow';
import { SessionReviewHintRow } from '@/components/chat/SessionReviewHintRow';
import { BackgroundShellsStrip } from '@/components/chat/BackgroundShellsStrip';
import { ComposerStatusStrip } from '@/components/chat/ComposerStatusStrip';
import { useWorktreeBootstrapPending } from '@/hooks/useWorktreeBootstrapPending';
import { useShownAfter } from '@/hooks/useShownAfter';
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
const EMPTY_COMPOSER_SKILLS: [] = [];
const NO_ATTACH_GUESTS: [] = [];

const getFileMentionInputSourceForInsertedText = (insertedText: string): FileMentionAutocompleteInputSource => (
    insertedText.includes('@') ? 'paste' : 'manual'
);

// Asks the snapshot the `@` picker ranks, which it loads when it opens, with
// the same session left out, so the picker never stays open over nothing.
const continuesSessionMention = (query: string, currentSessionId: string | null): boolean => {
    const { hasLoaded, activeSessions, archivedSessions } = useGlobalSessionsStore.getState();
    if (!hasLoaded) return false;
    return hasSessionMention(activeSessions, query, currentSessionId)
        || hasSessionMention(archivedSessions, query, currentSessionId);
};

/**
 * Skills the user named with `$name`. Matched against the registry's exact
 * casing, since the name is echoed back to the model as a skill to load.
 */
const collectInlineSkillMentions = (text: string, skillNames: Set<string>): string[] =>
    collectKnownTokenNames(text, '$', skillNames, 'exact');

/** Which reference picker is open, and for the repository on which tab. */
type ReferencePickerState = { source: 'repository'; kind?: RepositoryReferenceKind } | { source: TrackerReferenceSource } | null;

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
    const linkedAt = Date.now();
    // Another session or message attached here links nothing to this one.
    const linked = references.flatMap((reference) => toLinkedIssue(reference, linkedAt) ?? []);
    if (linked.length === 0) return;
    void sessionActions.addLinkedIssues(sessionId, directory, linked).catch(() => undefined);
};

const renderDraftTitle = (title: string, projectLabel: string | null): React.ReactNode => {
    if (!projectLabel) return title;
    const projectIndex = title.indexOf(projectLabel);
    if (projectIndex === -1) return title;

    return (
        <>
            {title.slice(0, projectIndex)}
            <DraftProjectName label={projectLabel} />
            {title.slice(projectIndex + projectLabel.length)}
        </>
    );
};

/**
 * An event handler with one identity for the composer's lifetime that runs the
 * latest render's closure. Handlers that read the draft text would otherwise
 * be new on every keystroke and re-render every memoized child they reach.
 * Event handlers only: calling the result during render runs a stale closure.
 */
function useStableHandler<Args extends readonly unknown[], Result>(
    handler: (...args: Args) => Result,
): (...args: Args) => Result {
    const handlerRef = React.useRef(handler);
    React.useLayoutEffect(() => {
        handlerRef.current = handler;
    });
    return React.useCallback((...args: Args) => handlerRef.current(...args), []);
}

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
// A session the server creates within this is never announced as being created.
const CREATING_SESSION_LINE_DELAY_MS = 300;

/**
 * The composer key of the open project draft (see `workDraftComposerKey`), or
 * null for a new Chat. The sidebars of the desktop, the web and the phone list
 * drafts; VS Code has no shared drafts, so it keeps the per-folder key, where
 * a new draft finds the text left in that folder.
 */
const resolveWorkDraftComposerKey = (draft: NewSessionDraftState | null | undefined): string | null => {
    return draft?.open && draft.target === 'project' && draft.workDraftId && getSettingsSurface() !== 'vscode'
        ? workDraftComposerKey(draft.workDraftId)
        : null;
};

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
    return createChatDraftIdentity(getRuntimeKey(), directory, sessionId ?? resolveWorkDraftComposerKey(draft));
};

type AttachmentPickerInputProps = {
    ref: React.Ref<HTMLInputElement>;
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

// Memoized because React re-applies an input's `name` and `type` on every
// commit that reaches it (it clears `name` while setting `type`), and the
// composer renders on streamed updates while these props never change.
const AttachmentPickerInput = React.memo(function AttachmentPickerInput({ ref, onChange }: AttachmentPickerInputProps) {
    return (
        <input
            ref={ref}
            type="file"
            multiple
            className="hidden"
            onChange={onChange}
            accept={ATTACHMENT_ACCEPT}
        />
    );
});

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
        const snapshot = readChatDraftClaimingFolderDraft(identity);
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
    const [mentionCompletion] = React.useState(() => new MentionCompletionState());
    const completingMentionRef = React.useRef(false);
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
    const [promptHistorySearch, setPromptHistorySearch] = React.useState<{
        identity: string;
        initialQuery: string;
        olderRequest: number;
    } | null>(null);
    const [promptHistorySearchOwner, setPromptHistorySearchOwner] = React.useState<HTMLFormElement | null>(null);
    const [historyFocusPending, setHistoryFocusPending] = React.useState(false);
    const setPromptHistorySearchForm = React.useCallback((node: HTMLFormElement | null) => {
        composerFormRef.current = node;
        setPromptHistorySearchOwner(node);
    }, []);
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
    const emojiRef = React.useRef<EmojiAutocompleteHandle>(null);
    // Ref to track current message value without triggering re-renders in effects
    const messageRef = React.useRef(message);
    const dictationSendInFlightRef = React.useRef(false);
    const currentChatDraftIdentityRef = React.useRef<ChatDraftIdentity | null>(initialDraftIdentityRef.current);
    const pendingPastedAttachmentFilenamesRef = React.useRef<Set<string>>(new Set());
    // The unanswered large-paste choice; `resolve` applies the answer once.
    const [largeTextPasteOffer, setLargeTextPasteOffer] = React.useState<{
        id: number;
        resolve: (action: LargeTextPasteChoiceAction, explicitlyChosen: boolean, typedText?: string) => void;
    } | null>(null);
    const largeTextPasteOfferIdRef = React.useRef(0);
    const [largeTextPasteGesture] = React.useState(() => new LargeTextPasteGesture());

    // TODO: port sendMessage to session-actions (complex — creates sessions, handles attachments, etc.)
    // oxlint-disable-next-line typescript/no-explicit-any
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
    const currentDirectory = liveEffectiveDirectory ?? fallbackDirectory;
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
        ? btwPendingComposerKey(currentSessionId)
        : btwSessionId;
    const isBtwActive = Boolean(btwComposerSessionId) && !btwPanel.collapsed;
    const isBtwPanelVisible = btwHoldsDock(btwPanel, hasPendingForm);
    const immediateBtwSubmitRef = React.useRef<{ identity: ChatDraftIdentity; text: string } | null>(null);
    const draftCaretModeRef = React.useRef({ btw: isBtwActive, atEnd: isBtwActive });
    const inputMode = isBtwActive ? 'normal' : storedInputMode;
    // A session promoted out of `/btw` keeps the boundary instructions in its
    // transcript — there is no way to delete a message part — so it has to say
    // they no longer apply.
    const isPromotedBtwSession = btwPanel.parentPromoted;
    const activeRuntimeKey = getRuntimeKey();
    const isNewChatDraft = useSessionUIStore((s) => (
        !columnPinned && !currentSessionId && Boolean(s.newSessionDraft?.open) && s.newSessionDraft.target === 'chat'
    ));
    const workDraftKey = useSessionUIStore((s) => (columnPinned || currentSessionId ? null : resolveWorkDraftComposerKey(s.newSessionDraft)));
    const chatDraftIdentity = React.useMemo(
        () => createChatDraftIdentity(
            activeRuntimeKey,
            isNewChatDraft ? NEW_CHAT_DRAFT_DIRECTORY : currentSessionDirectoryForSync ?? currentDirectory,
            isBtwActive ? btwComposerSessionId : currentSessionId ?? workDraftKey,
        ),
        [activeRuntimeKey, btwComposerSessionId, currentDirectory, currentSessionDirectoryForSync, currentSessionId, isBtwActive, isNewChatDraft, workDraftKey],
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
    const pendingDraftSubmit = useInputStore((s) => s.pendingDraftSubmit);
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
    // Mounted from the first open on, so it costs nothing until then and its
    // close animation still plays afterwards.
    const [reviewDialogMounted, setReviewDialogMounted] = React.useState(false);
    if (reviewDialogOpen && !reviewDialogMounted) setReviewDialogMounted(true);
    const closeReviewDialog = React.useCallback(() => setReviewDialogOpen(false), []);

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
    // The session this composer is talking to, which `/btw` changes. Text
    // addressed to a session (a revert of that session's message) belongs here
    // only while this composer is the one showing it.
    const shownSessionId = isBtwActive ? btwComposerSessionId : currentSessionId;
    const configProviderId = useConfigStore((state) => state.currentProviderId);
    const configModelId = useConfigStore((state) => state.currentModelId);
    const configCatalogLoaded = useConfigStore((state) => state.providersLoaded && state.agentsLoaded);
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
    // Filtered here rather than through `getVisibleAgents()`, which returns a
    // new array on every call: that identity would rebuild the language
    // context, and with it re-tokenize the editor, on every keystroke.
    const allAgents = useConfigStore((state) => state.agents);
    const agents = React.useMemo(() => filterVisibleAgents(allAgents), [allAgents]);
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
    const btwComposerVariant = currentVariantSelection.override === null ? null : currentVariantSelection.override ?? configVariant;
    // Memoized: the footer and its model controls compare this selection by
    // identity, and nothing in it changes while the user types.
    const effectiveBtwSelection = React.useMemo(() => resolveBtwSelection({
        agents,
        savedAgent: btwAgentSelection,
        isModelAvailable: btwModelAvailability(providerCatalog, autoReady),
        savedModel: btwModelSelection,
        savedVariant: btwSavedVariant,
        composerModel: currentProviderId && currentModelId ? { providerId: currentProviderId, modelId: currentModelId } : null,
        composerVariant: btwComposerVariant,
    }), [agents, autoReady, btwAgentSelection, btwComposerVariant, btwModelSelection, btwSavedVariant, currentModelId, currentProviderId, providerCatalog]);
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
    // While BTW is open the app-wide favorite-model handlers decline, so the
    // parent's model never moves; these step the BTW model from the one its
    // chip shows and save it the way the BTW model picker does (#5914). As
    // with permission keys, a key pressed in a chat pinned in the side panel
    // is that chat's and a key pressed anywhere else is the main chat's.
    const cycleBtwFavoriteModel = (event: KeyboardEvent, delta: number): boolean | void => {
        const keyColumn = event.target instanceof Element ? event.target.closest('[data-chat-column="pinned"]') : null;
        if (columnPinned ? !keyColumn?.contains(composerFormRef.current) : keyColumn) return false;
        const ui = useUIStore.getState();
        const hasOverlay = ui.isSettingsDialogOpen
            || ui.isCommandPaletteOpen
            || ui.isHelpDialogOpen
            || ui.isSessionSwitcherOpen
            || ui.isAboutDialogOpen;
        if (hasOverlay || !btwComposerSessionId) return false;
        const { model, agent } = effectiveBtwSelection;
        const next = getNextFavoriteModel(
            ui.favoriteModels,
            providerCatalog,
            ui.hiddenModels,
            { providerID: model?.providerId ?? '', modelID: model?.modelId ?? '' },
            delta,
        );
        if (!next) return false;
        const selections = useSelectionStore.getState();
        selections.saveSessionModelSelection(btwComposerSessionId, next.providerID, next.modelID);
        if (agent) selections.saveAgentModelForSession(btwComposerSessionId, agent, next.providerID, next.modelID);
    };
    useKeybinds(isBtwActive ? {
        cycle_favorite_model_forward: (event) => cycleBtwFavoriteModel(event, 1),
        cycle_favorite_model_backward: (event) => cycleBtwFavoriteModel(event, -1),
    } : {});
    const isMobile = useUIStore((state) => state.isMobile);
    const hasHardwareKeyboard = useHardwareKeyboard();
    const enterToSend = useUIStore((state) => state.enterToSend);
    const enterToSendConfigured = useUIStore((state) => state.enterToSendConfigured);
    const mobileReturnKeySends = useUIStore((state) => state.mobileReturnKeySends);
    const { enabled: isTabletLayout } = useTabletLayout();
    const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);
    const inputBarOffset = useUIStore((state) => state.inputBarOffset);
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
        // An unanswered choice belongs to the draft it was pasted into; it
        // must not land in another one. The text is still on the clipboard.
        largeTextPasteOfferIdRef.current += 1;
        setLargeTextPasteOffer(null);
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
    const { git: runtimeGit, vscode: vscodeApi, trackers: runtimeTrackers } = useRuntimeAPIs();
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

    const { submitting: reviewFlowSubmitting, start: handleStartReviewFlow } = useReviewFlowStart(currentSessionId, currentDirectory, closeReviewDialog);

    const isDesktopExpanded = isExpandedInput && !isMobile;
    // Mobile fullscreen composer (entered via the drag handle's swipe-up).
    const isMobileExpanded = isExpandedInput && isMobile;
    const isComposerExpanded = isDesktopExpanded || isMobileExpanded;
    // Rounder composer on mobile (touch UI reads better with a softer corner).
    const chatInputRadius = isMobile ? '1.25rem' : 'var(--radius-xl)';

    const knownAgentNames = React.useMemo(
        () => new Set(agents.map((agent) => agent.name.toLowerCase())),
        [agents]
    );
    const knownAgentNamesRef = React.useRef(knownAgentNames);
    knownAgentNamesRef.current = knownAgentNames;

    // Known slash-invocations (commands + built-ins) and `$` skills, used to
    // highlight matching tokens in the composer, the same way confirmed
    // @files are.
    const commandsTarget = useComposerConfigDirectory(currentDirectory);
    const availableCommands = useCommandsStore((s) => selectCommandsForComposer(s, commandsTarget));
    const commandsDirectory = commandsTarget.status === 'resolved' ? commandsTarget.directory : null;
    const preloadDraftCatalogs = !columnPinned && !currentSessionId && newSessionDraftOpen
        && Boolean(newSessionDraft.worktreeStartDirectory);
    React.useEffect(() => {
        if (!preloadDraftCatalogs || !commandsDirectory) return;
        void useCommandsStore.getState().loadCommands(commandsDirectory);
        void useSkillsStore.getState().loadSkills(commandsDirectory);
    }, [commandsDirectory, preloadDraftCatalogs]);
    const availableSkills = useSkillsStore((s) => commandsTarget.status === 'pending'
        ? EMPTY_COMPOSER_SKILLS
        : selectAvailableSkillsForDirectory(s, commandsTarget.directory));
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

    // Sessions and messages mentioned in the text, by `sessionLinkKey`. The
    // text decides what goes out: a mention deleted from it is not sent.
    const [sessionMentions, setSessionMentions] = React.useState<ReadonlyMap<string, SessionReference>>(() => new Map());
    const sessionMentionsRef = React.useRef(sessionMentions);
    React.useLayoutEffect(() => {
        sessionMentionsRef.current = sessionMentions;
    }, [sessionMentions]);
    // The ref moves at once, so a send right after a read sees what it found.
    const rememberSessionMentions = React.useCallback((references: readonly SessionReference[]) => {
        if (references.length === 0) return;
        const next = new Map(sessionMentionsRef.current);
        for (const reference of references) next.set(sessionReferenceKey(reference), reference);
        sessionMentionsRef.current = next;
        setSessionMentions(next);
    }, []);
    const sessionLinkOrigins = React.useMemo(() => appOwnOrigins(), []);
    // Links read once already, found or not: text typed or restored is read
    // quietly, and a link that failed is not read again on every keystroke.
    const attemptedSessionLinksRef = React.useRef(new Set<string>());
    // A mentioned session or message draws as a chip once read; one this
    // server cannot resolve stays a plain link. `announce` says so: a paste
    // and a send do, text typed or restored does not.
    const resolveSessionLinks = React.useCallback(async (targets: readonly SessionLinkTarget[], announce: boolean) => {
        const pending = targets.filter((target) => !sessionMentionsRef.current.has(sessionLinkKey(target)));
        if (pending.length === 0) return;
        for (const target of pending) attemptedSessionLinksRef.current.add(sessionLinkKey(target));
        const results = await Promise.allSettled(pending.map((target) => loadSessionLinkReference(target)));
        const resolved = results.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []));
        rememberSessionMentions(resolved);
        if (announce && resolved.length < pending.length) toast.error(t('chat.sessionReference.unavailable'));
    }, [rememberSessionMentions, t]);
    // Text that comes back without a paste (a revert, a fork, a restored
    // draft, a link typed by hand) gets its chips too.
    React.useEffect(() => {
        if (isVSCodeRuntime()) return;
        const pending = findSessionLinks(message, sessionLinkOrigins)
            .map((range) => range.target)
            .filter((target) => !attemptedSessionLinksRef.current.has(sessionLinkKey(target)));
        if (pending.length > 0) void resolveSessionLinks(pending, false);
    }, [message, resolveSessionLinks, sessionLinkOrigins]);
    // Read before a send consumes anything: a second Enter while the read is
    // out does nothing, and a link the read cannot resolve goes as the text it is.
    const sessionMentionReadRef = React.useRef(false);
    const readSessionMentionsBeforeSend = React.useCallback(async (text: string): Promise<boolean> => {
        if (isVSCodeRuntime()) return true;
        const pending = findSessionLinks(text, sessionLinkOrigins)
            .map((range) => range.target)
            .filter((target) => !sessionMentionsRef.current.has(sessionLinkKey(target)));
        if (pending.length === 0) return true;
        if (sessionMentionReadRef.current) return false;
        sessionMentionReadRef.current = true;
        try {
            await resolveSessionLinks(pending, true);
        } finally {
            sessionMentionReadRef.current = false;
        }
        return true;
    }, [resolveSessionLinks, sessionLinkOrigins]);
    // What the text mentions, once each, in order.
    const sessionMentionsIn = React.useCallback((text: string): SessionReference[] => (
        isVSCodeRuntime() ? [] : sessionReferencesInText(text, sessionLinkOrigins, sessionMentionsRef.current).references
    ), [sessionLinkOrigins]);
    const sessionLinkChips = React.useMemo(() => new Map([...sessionMentions].map(([key, reference]) => {
        const chip = sessionMentionChip(reference);
        return [key, { label: chip.label, title: chip.title, iconHref: `#oc-${chip.icon}` }] as const;
    })), [sessionMentions]);

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
        sessionLinkChips,
        sessionLinkOrigins,
    }), [attachmentFilenames, currentTheme.metadata.variant, inputMode, knownAgentNames, knownSkillNames, knownSlashNamesWithGuests, knownSnippetTriggers, sessionLinkChips, sessionLinkOrigins]);

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

    const resolveInlineFileMention = React.useCallback((mentionPath: string): { serverPath: string; filename: string; root: string } | null => {
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
            root,
        };
    }, [chatSearchDirectory]);

    const extractInlineFileMentions = React.useCallback((
        rawText: string,
        preparedMentions?: ReadonlyMap<string, AttachedFile[]>,
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

            const prepared = preparedMentions?.get(mention.serverPath);
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

    type ReadOnSendMentionPreparation =
        | { status: 'ready'; prepared: Map<string, AttachedFile[]> }
        | { status: 'failed'; filename: string }
        | { status: 'runtime-changed' };

    /**
     * Document and image mentions (`@notes.docx`, `@shot.png`) are sent as
     * converted attachments with their real type, like a picked file. Their
     * sources are fetched up front — by the send, or by queueing, since the
     * server that later delivers a queued message cannot read them.
     */
    const prepareReadOnSendMentions = React.useCallback(async (
        texts: readonly string[],
        reservedFilenames: Set<string>,
        runtimeKey: string,
    ): Promise<ReadOnSendMentionPreparation> => {
        const prepared = new Map<string, AttachedFile[]>();
        for (const rawText of texts) {
            for (const token of scanMentions(rawText, confirmedMentionsRef.current)) {
                const mention = resolveInlineFileMention(token.name);
                if (
                    !mention
                    || !isReadOnSendMentionFilename(mention.filename)
                    || prepared.has(mention.serverPath)
                ) {
                    continue;
                }
                try {
                    // The directory bounds the read, and sends it to the space that holds the file.
                    const response = await runtimeFetch('/api/fs/raw', {
                        query: { path: mention.serverPath, directory: mention.root || undefined },
                    });
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
            // Keep the editor mounted until the closing search hands focus back.
            promptHistorySearchOpen: promptHistorySearch !== null || historyFocusPending,
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
    const messageQueueDirectory = currentSessionDirectoryForSync ?? currentDirectory;
    const parentMessageQueueTarget = React.useMemo(() => (currentSessionId
        ? createMessageQueueTarget(currentSessionId, messageQueueDirectory, activeRuntimeKey)
        : null), [activeRuntimeKey, currentSessionId, messageQueueDirectory]);
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
    const popQueuedToInput = useMessageQueueStore((state) => state.popToInput);

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
    // Publish where the composer on screen files what other surfaces hand it:
    // inline drafts (file, diff, plan, terminal, PR and browser comments) and
    // attachments (a comment's image, an annotation's screenshot).
    const composerAddress = React.useMemo<ComposerAddress | null>(
        () => ({ inline: inlineDraftTarget, attachments: chatDraftIdentity }),
        [chatDraftIdentity, inlineDraftTarget],
    );
    React.useLayoutEffect(() => {
        if (columnPinned) return;
        useInputStore.getState().setComposerAddress(composerAddress);
        return () => useInputStore.getState().setComposerAddress(null);
    }, [columnPinned, composerAddress]);
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
    const promptHistorySearchIdentity = `${chatDraftIdentity ? getChatDraftIdentityKey(chatDraftIdentity) : 'none'}:${messageHistoryIdentity}:${inputMode}:${isBtwActive}:${isBtwPanelVisible}`;
    const isPromptHistorySearchOpen = promptHistorySearch?.identity === promptHistorySearchIdentity;
    const promptHistorySearchIdentityRef = React.useRef(promptHistorySearchIdentity);
    promptHistorySearchIdentityRef.current = promptHistorySearchIdentity;

    React.useEffect(() => {
        if (!isPromptHistorySearchOpen && promptHistorySearch) setPromptHistorySearch(null);
    }, [isPromptHistorySearchOpen, promptHistorySearch]);

    // The one deferred composer focus that history work may have pending. A
    // newer schedule replaces it; opening the search or unmounting cancels it,
    // so a stale frame cannot pull focus out of a search that opened since.
    const historyFocusFrameRef = React.useRef<number | null>(null);
    const cancelHistoryFocusFrame = React.useCallback(() => {
        if (historyFocusFrameRef.current === null) return;
        window.cancelAnimationFrame(historyFocusFrameRef.current);
        historyFocusFrameRef.current = null;
        setHistoryFocusPending(false);
    }, []);
    const scheduleHistoryFocusFrame = React.useCallback((run: () => void) => {
        cancelHistoryFocusFrame();
        setHistoryFocusPending(true);
        historyFocusFrameRef.current = window.requestAnimationFrame(() => {
            historyFocusFrameRef.current = null;
            run();
            setHistoryFocusPending(false);
        });
    }, [cancelHistoryFocusFrame]);
    React.useEffect(() => cancelHistoryFocusFrame, [cancelHistoryFocusFrame]);

    const applyHistoryValue = React.useCallback((value: MessageHistoryValue<AttachedFile>, selection: 'start' | 'end') => {
        const identity = promptHistorySearchIdentityRef.current;
        setMessage(value.text);
        messageRef.current = value.text;
        useInputStore.getState().setAttachedFiles([...value.attachments], chatDraftIdentity);
        scheduleHistoryFocusFrame(() => {
            if (promptHistorySearchIdentityRef.current !== identity) return;
            const editor = composerRef.current;
            if (!editor) return;
            const position = selection === 'start' ? 0 : editor.getValue().length;
            editor.focus();
            editor.setSelection(position, position);
        });
    }, [chatDraftIdentity, scheduleHistoryFocusFrame]);

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
        initialDraft: {
            text: initialDraftRef.current ?? '',
            identity: initialDraftIdentityRef.current,
        },
        newSessionDraftId: newSessionDraftOpen ? newSessionDraft.draftId : null,
        onIdentityChange: () => {
            mentionCompletion.clear();
            closeAutocomplete();
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

    // A project's new draft is shared with the server, which lists it in the
    // sidebar once the user leaves it (the chat identity carries its key only
    // while it is the one on screen).
    useSessionDraftPublishing({
        identity: isBtwActive ? null : chatDraftIdentity,
        message,
        confirmedMentionsRef,
        projectId: newSessionDraftOpen ? newSessionDraft.selectedProjectId ?? null : null,
        enabled: newSessionDraftOpen && !currentSessionId,
    });

    const handleExitBtw = React.useCallback(() => {
        if (!currentSessionId) return;
        immediateBtwSubmitRef.current = null;
        const panels = useBtwStore.getState();
        const pending = panels.byParent[currentSessionId];
        if (pending?.pending && !pending.creating && !btwSessionId) {
            const pendingSessionId = btwPendingComposerKey(currentSessionId);
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
    const autoReviewDirectory = currentSessionDirectoryForSync ?? currentDirectory;
    const autoReviewRunning = useAutoReviewStore(React.useMemo(
        () => selectAutoReviewRunning(currentSessionId, autoReviewDirectory),
        [currentSessionId, autoReviewDirectory],
    ));

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
    usePendingComposerText({ target: mailboxTarget, sessionId: shownSessionId, setMessage, focus: focusComposer });

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
    const { isActive: parallelActive, runCount: parallelRunCount, isLaunching: parallelLaunching, launch: launchParallel } = parallel;
    const parallelRun = React.useMemo(() => (parallelActive ? {
        runCount: parallelRunCount,
        launching: parallelLaunching,
        onLaunch: () => { void launchParallel(); },
    } : null), [launchParallel, parallelActive, parallelLaunching, parallelRunCount]);
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
    // The session's first message is still on its way (its session being
    // created, its request about to leave): the composer keeps what is typed
    // and sends nothing until then, so a second message cannot overtake it.
    const pendingFirstSend = useSessionUIStore((s) => (currentSessionId ? s.pendingDraftSends.get(currentSessionId) ?? null : null));
    const canSend = (hasContent || hasQueuedMessages) && !(isBtwActive && (btwPanel.creating || preparingBtwSend)) && !pendingFirstSend;

    const canAbort = sessionPhase !== 'idle' && !pendingFirstSend;
    // While a page the agent showed waits for the user's answer, the turn
    // cannot end, so a queued message would never go out. The message is sent
    // at once instead: OpenCode hands it to the agent's plugin, which ends the
    // wait, and the agent reads the message next.
    const isPageWaiting = useGlobalBlockingRequestsStore(React.useCallback(
        (state) => Boolean(currentSessionId && state.bySession.get(currentSessionId)?.pages.length),
        [currentSessionId],
    ));

    // Reads the text through refs, so the send and queue callbacks built on
    // it keep their identity while the user types.
    const getCurrentInputSnapshot = React.useCallback(() => {
        const currentMessage = composerRef.current?.getValue() ?? messageRef.current;
        return {
            message: currentMessage,
            hasContent: currentMessage.trim().length > 0 || attachedFiles.length > 0 || hasDrafts || (!isBtwActive && hasLinkedReferences),
        };
    }, [attachedFiles.length, hasDrafts, hasLinkedReferences, isBtwActive]);

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
        // Queueing is the same user intent as sending, so an archived session
        // comes back once the queue accepts the message, not at delivery.
        const resumeAfterQueue = prepareUserMessageResume(queueSessionId, queueRuntimeKey);
        const messageToQueue = inputSnapshot.message.replace(/^\n+|\n+$/g, '');
        if (!(await readSessionMentionsBeforeSend(messageToQueue))) return;
        const composerAttachments = sanitizeAttachmentsForSend(attachedFiles);

        // A queued message is resolved now, not at delivery: the server that
        // sends it has no agent list, no confirmed mentions, and no way to read
        // a file the user named — and the mention must match what was
        // visible when the user typed it.
        const readOnSendMentions = await prepareReadOnSendMentions(
            [messageToQueue],
            new Set(composerAttachments.map((attachment) => attachment.filename)),
            queueRuntimeKey,
        );
        if (readOnSendMentions.status === 'runtime-changed') return;
        if (readOnSendMentions.status === 'failed') {
            toast.error(t('chat.chatInput.toast.attachNamedFailed', { name: readOnSendMentions.filename }));
            return;
        }
        const { sanitizedText, mention } = parseAgentMentions(messageToQueue, agents);
        const { attachments: extractedMentionAttachments } = extractInlineFileMentions(sanitizedText, readOnSendMentions.prepared);
        // #3898: a queued message is delivered later without the composer, so
        // a phantom mention (`@masha.conner`) must be dropped now or the
        // delivery 400s.
        const { sendable: mentionAttachments } = await filterMissingInlineAttachments(
            extractedMentionAttachments,
            opencodeClient,
        );
        const availableSkillNames = new Set(
            availableSkills.map((skill) => skill.name),
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
            references: [...linked.map(toContextReference), ...sessionMentionsIn(messageToQueue)],
        }, skillInstruction);
        const attachmentsToQueue = [...composerAttachments, ...mentionAttachments];
        // An armed goal belongs to this message: it leaves with it and starts
        // when this message is delivered, whatever is sent in between.
        const goalArm = textToQueue.trim()
            ? useSessionGoalArmStore.getState().consume()
            : { armed: false, objectiveOverride: null };
        const goalSettings = useUIStore.getState();
        const goal: QueuedMessageGoal | undefined = goalArm.armed ? {
            tokenBudget: goalSettings.sessionGoalDefaultBudgetEnabled ? goalSettings.sessionGoalDefaultBudget : null,
        } : undefined;
        if (goal && goalArm.objectiveOverride?.trim()) goal.objective = goalArm.objectiveOverride;

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
                goal,
            });
        } catch (error) {
            console.warn('[queue] failed to queue message:', error);
            toast.error(t('chat.queuedMessage.toast.queueFailed'));
            if (goalArm.armed) useSessionGoalArmStore.getState().setArmed(true, goalArm.objectiveOverride);
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
        void resumeAfterQueue().catch(console.warn);
        recordLinkedReferences(queueSessionId, queueTarget.directory, linked);
    }, [getCurrentInputSnapshot, currentSessionId, messageQueueTarget, inputMode, hasDrafts, guestCommands, attachedFiles, sanitizeAttachmentsForSend, prepareReadOnSendMentions, extractInlineFileMentions, agents, availableSkills, consumePendingSyntheticParts, mailboxTarget, inlineDraftTarget, consumeDrafts, linkedReferences, scrollToLatest, clearAttachedFiles, chatDraftIdentity, isMobile, isMobileCommentOpen, addToQueue, currentProviderId, currentModelId, currentAgentName, currentVariant, t, readSessionMentionsBeforeSend, sessionMentionsIn]);

    /** Put the context a queued message was captured with back on the composer chips. */
    const restoreQueuedContext = React.useCallback((context: readonly QueuedContextPart[]) => {
        const synthetic: SyntheticContextPart[] = [];
        const restored: ComposerReference[] = [];
        const mentions: SessionReference[] = [];
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
            } else if (payload.kind === 'repository-discussion') {
                restored.push({
                    kind: 'repository-discussion',
                    provider: payload.provider,
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
            } else if (payload.kind === 'tracker-item') {
                restored.push({ kind: 'tracker-item', provider: payload.provider, identifier: payload.identifier, title: payload.title, url: payload.url, contextText: part.text });
            } else if (payload.kind === 'session') {
                // The restored text still carries the link; it draws as a chip again.
                mentions.push({ kind: 'session', sessionId: payload.sessionId, title: payload.title, contextText: part.text });
            } else if (payload.kind === 'session-message') {
                mentions.push({
                    kind: 'session-message',
                    sessionId: payload.sessionId,
                    messageId: payload.messageId,
                    sessionTitle: payload.sessionTitle,
                    excerpt: payload.excerpt,
                    contextText: part.text,
                });
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
        rememberSessionMentions(mentions);
        if (synthetic.length > 0) {
            const pending = useInputStore.getState().getPendingSyntheticParts(mailboxTarget) ?? [];
            useInputStore.getState().setPendingSyntheticParts([...pending, ...synthetic], mailboxTarget);
        }
    }, [inlineDraftTarget, mailboxTarget, rememberSessionMentions]);

    // Editing takes the message out of the queue, so sending it again queues
    // one message, not a copy.
    const handleQueuedMessageEdit = React.useCallback((messageId: string) => {
        if (!messageQueueTarget) return;
        // The full message (attachments included) comes back from the queue's
        // owner; the queue row only knows the summary.
        void popQueuedToInput(messageQueueTarget, messageId).then((queued) => {
            if (!queued) return;
            if (queued.attachments && queued.attachments.length > 0) {
                const currentAttachments = useInputStore.getState().attachedFiles;
                useInputStore.getState().setAttachedFiles([...currentAttachments, ...queued.attachments]);
            }
            setMessage(queued.content);
            // Back in the composer, the message is armed again as it was queued.
            if (queued.goal) useSessionGoalArmStore.getState().setArmed(true, queued.goal.objective ?? null);
            restoreQueuedContext(queued.context ?? []);
            setTimeout(() => {
                composerRef.current?.focus();
            }, 0);
        }).catch((error) => {
            console.warn('[queue] failed to take queued message for editing:', error);
            toast.error(t('chat.queuedMessage.toast.takeFailed'));
        });
    }, [messageQueueTarget, popQueuedToInput, restoreQueuedContext, t]);

    const handleQueuedMessageSend = React.useCallback((messageId: string) => {
        // Force-sending from the queue during a busy session counts as steer
        void handleSubmitRef.current({ queuedOnly: true, queuedMessageId: messageId, delivery: 'steer' });
    }, []);

    const handleOpenAgentPanel = React.useCallback(() => {
        setMobileControlsPanel('agent');
    }, []);

    const openGitHubPicker = React.useCallback(() => {
        setReferencePicker({ source: 'repository' });
    }, []);
    const referencePickerDirectory = currentSessionDirectoryForSync ?? currentDirectory ?? null;
    const repositoryProvider = useRepositoryReferenceProvider(isVSCodeRuntime() ? null : referencePickerDirectory);
    const repositoryDescriptor = useSourceControlProvider(repositoryProvider);
    const descriptorOf = useSourceControlDescriptorOf();
    const addLinkedReferences = React.useCallback((references: ComposerReference[]) => {
        setLinkedReferences((current) => withComposerReferences(current, references));
    }, []);
    const attachReferences = useAttachReferences(referencePickerDirectory, addLinkedReferences);

    const trackerDescriptors = useTrackerDescriptors();
    const trackerSources = useTrackerSources();

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
        if (pendingFirstSend) return;
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
        // Magic prompts come from the directory this send lands in, routed the
        // way sendMessage routes it: the /btw fork, the session, else the
        // draft. A new chat has no folder yet and reads the global prompts.
        const magicPromptDirectory = isBtwActive
            ? btwDirectory ?? currentSessionDirectoryForSync ?? currentDirectory
            : capturedTarget || !capturedDraftSnapshot
                ? capturedTarget?.directory ?? currentDirectory
                : capturedDraftSnapshot.target === 'chat'
                    ? null
                    : capturedDraftSnapshot.bootstrapPendingDirectory ?? capturedDraftSnapshot.directoryOverride ?? currentDirectory;
        const inputSnapshot = options?.presetText != null
            ? {
                message: options.presetText,
                hasContent: options.presetText.trim().length > 0 || attachedFiles.length > 0 || hasDrafts || (!isBtwActive && hasLinkedReferences),
            }
            : getCurrentInputSnapshot();
        if (queuedOnly && autoReviewRunning) {
            return;
        }
        if (!queuedOnly && !(await readSessionMentionsBeforeSend(inputSnapshot.message))) return;

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
            const targetComposerId = btwSessionId ?? btwPendingComposerKey(currentSessionId);
            const targetIdentity = createChatDraftIdentity(
                activeRuntimeKey,
                btwDirectory ?? currentSessionDirectoryForSync ?? currentDirectory,
                targetComposerId,
            );
            const argument = commandPlan.command.argument.trim();
            handoffDraft(targetIdentity, isBtwActive ? argument : argument || null);
            // Files pasted with the question go with it; their `[image-1.png]` citations moved above.
            useInputStore.getState().moveAttachedFiles(chatDraftIdentity, targetIdentity);
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
        const restoreComposerText = (target: ChatDraftIdentity | null = chatDraftIdentity) => {
            if (queuedOnly || !inputSnapshot.message) return;
            restoreDraft(target, inputSnapshot.message, confirmedMentionsSnapshot);
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
            setPromptHistorySearch(null);
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

        // The isolated space the message targets, if any: a session by its directory, a draft by
        // the creation request it still waits on or by its directory.
        const spaceTarget = currentSessionId
            ? { requestId: null, directory: currentSessionDirectoryForSync ?? currentDirectory ?? null }
            : newSessionDraftOpen
                ? { requestId: newSessionDraft?.pendingWorktreeRequestId ?? null, directory: newSessionDraft?.directoryOverride ?? null }
                : null;
        // A stopped space takes no message on any model, and its catalog does not load while it is
        // stopped, so this comes before the model check. The message stays in the composer;
        // "Start", where the group's menu offers it, brings the space back and the user sends again.
        const stoppedSpace = spaceTarget ? stoppedSpaceOfTarget(spaceTarget) : null;
        if (stoppedSpace) {
            toast.error(t(stoppedSpace.reason === 'gone' ? 'spaces.draft.spaceGone' : stoppedSpace.reason === 'unreachable' ? 'spaces.draft.spaceUnreachable' : 'spaces.draft.spaceStopped'), stoppedSpace.start ? {
                action: {
                    label: t('spaces.actions.start'),
                    onClick: () => void runSpaceAction(stoppedSpace.spaceId, 'start'),
                },
            } : undefined);
            return;
        }

        if (!providerIdToSend || !modelIdToSend) {
            console.warn('Cannot send message: provider or model not selected');
            toast.error(t('chat.chatInput.toast.noModelSelected'));
            return;
        }

        // A message to an isolated space goes only on a model the space holds a key for; otherwise
        // it stays in the input with the reason and the way to the grant dialog.
        const spaceRefusal = spaceTarget ? spaceModelRefusal(spaceTarget, providerIdToSend) : null;
        if (spaceRefusal) {
            const provider = useConfigStore.getState().providers.find((entry) => entry.id === spaceRefusal.providerId)?.name ?? spaceRefusal.providerId;
            // No grant gives a space OpenCode's models, so that dialog opens on no provider.
            toast.error(spaceRefusal.reason === 'opencode'
                ? t('spaces.draft.modelOpenCode')
                : spaceRefusal.reason === 'needs_again'
                    ? t('spaces.draft.modelNeedsKeyAgain', { provider })
                    : t('spaces.draft.modelNotGranted', { provider }), {
                action: {
                    label: t('spaces.group.access.give'),
                    onClick: () => useSpacesStore.getState().openAccessDialog(spaceRefusal.spaceId, spaceRefusal.reason === 'opencode' ? null : spaceRefusal.providerId),
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
            setPromptHistorySearch(null);
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
            userInitiated?: boolean;
            target?: NonNullable<typeof capturedTarget>;
            sessionId?: string;
            directory?: string;
            draftSnapshot?: NonNullable<typeof capturedDraftSnapshot>;
            historySubmissions?: InputHistorySubmission[];
            delivery?: 'steer';
            skills?: SkillMentions;
            queuedGoal?: QueuedMessageGoal | null;
        } | undefined;
        if (isBtwActive && btwSessionId && btwDirectory) {
            sendMessageOptions = {
                target: { runtimeKey: submitRuntimeKey, sessionId: btwSessionId, directory: btwDirectory },
                sessionId: btwSessionId,
                directory: btwDirectory,
            };
        } else if (capturedTarget || capturedDraftSnapshot || delivery) {
            sendMessageOptions = {};
            if (capturedTarget) sendMessageOptions.target = capturedTarget;
            if (capturedDraftSnapshot) sendMessageOptions.draftSnapshot = capturedDraftSnapshot;
        }
        if (delivery && sendMessageOptions) sendMessageOptions.delivery = delivery;
        sendMessageOptions = { ...sendMessageOptions, userInitiated: true };

        // Queued messages resolved their mentions when they were queued; only
        // the composer's own text can still name a file to read.
        const reservedFilenames = new Set([
            ...attachedFiles.map((attachment) => attachment.filename),
            ...queuedProjection.flatMap((queued) => queued.attachments?.map((attachment) => attachment.filename) ?? []),
        ]);
        const readOnSendMentions = await prepareReadOnSendMentions(
            !isBtwActive && !queuedOnly && inputSnapshot.hasContent ? [inputSnapshot.message] : [],
            reservedFilenames,
            submitRuntimeKey,
        );
        if (readOnSendMentions.status === 'runtime-changed') return;
        if (readOnSendMentions.status === 'failed') {
            toast.error(t('chat.chatInput.toast.attachNamedFailed', { name: readOnSendMentions.filename }));
            return;
        }
        const preparedMentions = readOnSendMentions.prepared;

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
            // A taken message brings the goal it was queued with. Without one,
            // the composer's armed goal is for the composer text: a queued-only
            // send leaves it alone.
            const queuedGoal = queuedMessagesToSend.find((queued) => queued.goal)?.goal;
            if (queuedGoal || queuedOnly) {
                sendMessageOptions = { ...sendMessageOptions, queuedGoal: queuedGoal ?? null };
            }
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
            availableSkills.map((skill) => skill.name),
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
            references: isBtwActive ? [] : linkedReferences.map(toContextReference).concat(
                !queuedOnly && inputSnapshot.hasContent ? sessionMentionsIn(inputSnapshot.message) : [],
            ),
        }, {
            parseAgentMention: (text) => {
                if (isBtwActive) return { text };
                const { sanitizedText, mention } = parseAgentMentions(text, agents);
                return { text: sanitizedText, agentName: mention?.name };
            },
            extractFileMentions: (text) => {
                if (isBtwActive) return { text, attachments: [] };
                const { sanitizedText, attachments } = extractInlineFileMentions(text, preparedMentions);
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
            setPromptHistorySearch(null);
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
                    const prompts = await loadMagicPrompts(magicPromptDirectory);
                    const visibleText = prompts.render(command.visiblePrompt, variables.visible);
                    const instructionsText = prompts.render(command.instructionsPrompt, variables.instructions);
                    // Before the sent row commits, as for a plain send below.
                    scrollToBottom?.();
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
                } catch (error) {
                    restoreConsumedInput();
                    toast.error(getSubmitErrorMessage(error, t(command.errorToastKey)));
                }
                return;
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
                const forkIdentity = createChatDraftIdentity(activeRuntimeKey, forkDirectory, fork.id);
                migrateDraft(chatDraftIdentity, forkIdentity);
                // The files pasted while the fork was being created are this composer's.
                useInputStore.getState().moveAttachedFiles(chatDraftIdentity, forkIdentity);
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
            // A session that starts with a tracker item attached reports itself
            // on that item (the tracker's Session comments, where it has them),
            // however it was started: a draft, a worktree made from the item.
            if (!currentSessionId && linkTargetSessionId) {
                for (const reference of linkedReferences) {
                    if (reference.kind !== 'tracker-item') continue;
                    void postTrackerSessionStarted(runtimeTrackers, reference.provider, {
                        sessionId: linkTargetSessionId,
                        identifier: reference.identifier,
                    });
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
            // A first send failed. Its session exists: the text goes to that
            // composer, below what was typed meanwhile. It does not: the draft
            // is open again, and what was typed meanwhile goes back to it,
            // with the sent text below.
            const failedDraftSend = error instanceof DraftSendError ? error : null;
            const failedSessionIdentity = failedDraftSend
                ? createChatDraftIdentity(submitRuntimeKey, failedDraftSend.directory, failedDraftSend.sessionId)
                : null;
            if (failedDraftSend && failedSessionIdentity && !failedDraftSend.sessionCreated) {
                const shown = currentChatDraftIdentityRef.current;
                if (shown && getChatDraftIdentityKey(shown) === getChatDraftIdentityKey(failedSessionIdentity)) {
                    // The composer still shows the session that never was: its text moves to the draft.
                    handoffDraft(chatDraftIdentity, messageRef.current);
                } else {
                    // The user moved on (the draft is back, or another session is
                    // open): the text typed in the session that never was joins
                    // the draft's without touching what is on screen.
                    const typedMeanwhile = readChatDraft(failedSessionIdentity).text;
                    if (typedMeanwhile) restoreDraft(chatDraftIdentity, typedMeanwhile, new Set());
                }
                clearChatDraft(failedSessionIdentity);
            }
            const restoreTarget = (failedDraftSend?.sessionCreated ? failedSessionIdentity : null) ?? chatDraftIdentity;
            restoreComposerText(restoreTarget);

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
                    useInputStore.getState().restoreAttachedFiles(allAttachments, restoreTarget);
                }
                return;
            }

            if (isSoftNetworkError) {
                if (allAttachments.length > 0) {
                    useInputStore.getState().restoreAttachedFiles(allAttachments, restoreTarget);
                    toast.error(t('chat.chatInput.toast.sendAttachmentsFailed'));
                }
                return;
            }

            if (normalized.includes('runtime changed')) {
                if (allAttachments.length > 0) {
                    useInputStore.getState().restoreAttachedFiles(allAttachments, restoreTarget);
                }
                toast.error(t('chat.chatInput.toast.messageSendFailed'));
                return;
            }

            if (allAttachments.length > 0) {
                useInputStore.getState().restoreAttachedFiles(allAttachments, restoreTarget);
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
        if (pendingFirstSend) return;
        const inputSnapshot = getCurrentInputSnapshot();
        const canQueue = !isBtwActive && !isPageWaiting && inputMode === 'normal' && inputSnapshot.hasContent && currentSessionId && (currentSessionPhase !== 'idle' || autoReviewRunning);
        if (followUpBehavior === 'queue' && canQueue) {
            void handleQueueMessage();
        } else if (followUpBehavior === 'steer' && canQueue) {
            void handleSubmitRef.current({ delivery: 'steer' });
        } else {
            void handleSubmitRef.current();
        }
    }, [inputMode, getCurrentInputSnapshot, currentSessionId, currentSessionPhase, autoReviewRunning, followUpBehavior, handleQueueMessage, isBtwActive, isPageWaiting, isMobileCommentOpen, pendingFirstSend]);

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
    const handlePresetChipSubmit = React.useCallback((starter: ResolvedStarter) => {
        submitPresetPrompt(starter.submitText, starter.ref.type);
    }, [submitPresetPrompt]);

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

    // A first message a native Shortcuts request left for this draft goes out
    // once the draft's project has its models and agents and one is selected,
    // so it is sent with the project's defaults, the way a typed first message
    // would be. A request for another draft is dropped, never sent from here.
    // The text goes into the composer before the send, so a send that stops
    // early (a stopped space, no model) leaves it there. A draft that already
    // holds something (text, files, comments, references, context) gets the
    // text appended and nothing is sent: the shortcut never sends or clears
    // what the user put there.
    const draftSubmitDraftId = newSessionDraftOpen ? newSessionDraft.draftId : null;
    React.useEffect(() => {
        if (pendingDraftSubmit == null || columnPinned) return;
        if (draftSubmitDraftId === pendingDraftSubmit.draftId && (!configCatalogLoaded || !currentProviderId || !currentModelId)) return;
        const text = useInputStore.getState().consumePendingDraftSubmit(draftSubmitDraftId);
        if (!text) return;
        const composerHolds = getCurrentInputSnapshot().hasContent
            || (useInputStore.getState().getPendingSyntheticParts(mailboxTarget)?.length ?? 0) > 0;
        if (composerHolds) {
            setMessage((prev) => appendWithLineBreaks(prev, text));
            return;
        }
        setMessage(text);
        messageRef.current = text;
        void handleSubmitRef.current({ presetText: text });
    }, [columnPinned, configCatalogLoaded, currentModelId, currentProviderId, draftSubmitDraftId, getCurrentInputSnapshot, mailboxTarget, pendingDraftSubmit]);

    const handleKeyDown = (e: KeyboardEvent) => {
        // Early return during IME composition to prevent interference with autocomplete.
        // Uses keyCode === 229 fallback for WebKit where compositionend fires before keydown.
        if (isIMECompositionEvent(e)) {
            largeTextPasteGesture.invalidate();
            return;
        }
        if (largeTextPasteBehavior === 'inline-double-paste') largeTextPasteGesture.keyDown(e);

        const promptHistoryShortcut = getEffectiveShortcutCombo('search_prompt_history', useUIStore.getState().shortcutOverrides);
        if (
            promptHistoryShortcut
            && !promptHistoryShortcut.includes(' ')
            && eventMatchesShortcut(e, promptHistoryShortcut)
            && handlePromptHistoryShortcut(e)
        ) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }

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
                        // An emoji list takes keys only once it shows something.
                        : openAutocomplete === 'emoji' && emojiRef.current?.hasResults?.() ? emojiRef.current
                            : null;
        const autocompleteKey = getDropdownNavigationKey(e) ?? e.key;
        if (autocomplete && (autocompleteKey === 'Enter' || autocompleteKey === 'ArrowUp' || autocompleteKey === 'ArrowDown' || autocompleteKey === 'Escape' || autocompleteKey === 'Tab')) {
            e.preventDefault();
            e.stopPropagation();
            autocomplete.handleKeyDown(autocompleteKey);
            return;
        }

        if (e.key === 'Enter' && e.altKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            composerRef.current?.insertText('\n');
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
            // An empty composer over a queue edits the newest queued message, as
            // its Edit button does; recalling its text from history and sending
            // it would queue a duplicate.
            const lastQueued = queuedMessages[queuedMessages.length - 1];
            if (lastQueued && message.length === 0 && attachedFiles.length === 0) {
                handleQueuedMessageEdit(lastQueued.id);
                return;
            }
            const recalled = messageHistory.older({ text: message, attachments: attachedFiles });
            if (recalled !== null) {
                // Caret to the start, so the recalled message reads from its
                // beginning rather than from wherever the draft's caret was.
                applyHistoryValue(recalled, 'start');
            }
            return;
        }

        if (e.key === 'ArrowDown' && canNavigateHistoryDown) {
            e.preventDefault();
            const recalled = messageHistory.newer({ text: message, attachments: attachedFiles });
            if (recalled !== null) {
                applyHistoryValue(recalled, 'end');
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
            returnKeySends: mobileReturnKeySends,
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            altKey: e.altKey,
        })) {
            e.preventDefault();
            if (pendingFirstSend) return;

            // An empty composer with a queue sends the whole queue now. While
            // a turn runs Stop replaces the send button, so only Enter does it.

            // Queueing / steering only works when there's an existing busy
            // session (or an active auto-review run).
            const canQueue = !isBtwActive && !isPageWaiting && inputMode === 'normal' && hasContent && currentSessionId && (currentSessionPhase !== 'idle' || autoReviewRunning);

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

    // The open picker sits at the caret, right above the line being typed.
    const {
        position: autocompleteOverlayPosition,
        update: updateAutocompleteOverlayPosition,
    } = useAutocompletePosition({
        fullWidth: isMobile,
        openAutocomplete,
        query: autocompleteQuery,
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
    // The short hint drops the @, $ and / pointers, so it only replaces the
    // full one when that would wrap.
    const fullChatPlaceholderFits = usePlaceholderFitsOneLine(dictationHeightHostRef, t('chat.chatInput.placeholder.chat'));
    const useCompactChatPlaceholder = isMobile || !fullChatPlaceholderFits;
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
            mentionIsCompleted: (start) => mentionCompletion.isCompleted(start),
            // Session titles hold spaces, so `@release notes` keeps looking.
            // VS Code lists no sessions under `@`.
            mentionContinuesPastSpace: isVSCodeRuntime()
                ? undefined
                : (query) => continuesSessionMention(query, currentSessionId),
        });
        setOpenAutocomplete(trigger?.kind ?? null);
        setAutocompleteQuery(trigger?.query ?? '');
    }, [currentSessionId, inputMode, isBtwActive, mentionCompletion]);

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

    const handleComposerChange = ({ value, selection, changes, fromPaste, insertedText, fromValueProp }: ComposerChange) => {
        if (fromValueProp) {
            mentionCompletion.clear();
        } else {
            mentionCompletion.applyChange(changes, completingMentionRef.current);
        }
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
        // Text the app set (a restored draft, a prepared prompt) is not a
        // trigger being typed: a `#` line in it must not open the snippet list.
        if (fromValueProp) {
            closeAutocomplete();
            return;
        }
        updateAutocompleteState(value, selection.start, inputSource, pastedInsertedText);
    };

    React.useEffect(() => {
        return () => {
            clearDropTextSuppression();
            clearFileMentionPasteSuppression();
        };
    }, [clearDropTextSuppression, clearFileMentionPasteSuppression]);

    const insertCitationAtSelection = React.useCallback((citationText: string, leadingText: string) => {
        if (!citationText && !leadingText) return;
        const editor = composerRef.current;
        const currentMessage = editor?.getValue() ?? messageRef.current;
        const selectionStart = editor?.getSelection().start ?? currentMessage.length;
        const selectionEnd = editor?.getSelection().end ?? currentMessage.length;
        const insertionText = withInlineInsertionBoundaries(
            buildImagePasteInsertion(leadingText, citationText),
            currentMessage.slice(0, selectionStart),
            currentMessage.slice(selectionEnd),
        );
        insertTextAtSelection(insertionText, getFileMentionInputSourceForInsertedText(insertionText));
    }, [insertTextAtSelection]);

    const savePastedImagesAsFiles = useUIStore((state) => state.savePastedImagesAsFiles);
    const imageSaveMode = imageSaveModeForModel(savePastedImagesAsFiles, currentModelMetadata?.modalities?.input);
    const currentModelName = currentModelMetadata?.name ?? currentModelId ?? '';
    const currentModelKey = `${currentProviderId ?? ''}/${currentModelId ?? ''}`;

    /**
     * Saves the images where OpenCode runs and cites each saved one in the
     * draft as `[name](path)`, so the model, a subagent or a tool opens it by
     * path: in place of the attachment for a model that takes no images
     * (#5087), next to it for one that does (#5218). Each image gets a name no
     * attachment or link in the draft uses yet. Answers both groups under
     * those names; the caller attaches the unsaved ones as before, and in
     * `alongside` the saved ones too.
     */
    const saveImagesWithPathCitation = React.useCallback(async (
        files: File[],
        leadingText: string,
        reservedNames: string[],
        mode: 'instead' | 'alongside',
    ): Promise<{ saved: File[]; unsaved: File[] }> => {
        const attachmentDraftKey = useInputStore.getState().attachmentDraftKey;
        const names = assignImageAttachmentFilenames(files, [
            ...reservedNames,
            ...findImagePathCitationNames(composerRef.current?.getValue() ?? messageRef.current),
        ]);
        const images = files.map((file, index) => renameFileForAttachmentCitation(file, names[index]));
        // A cold or remote OpenCode can take seconds; this toast says what is going on.
        const savingToastId = toast.loading(t('chat.chatInput.toast.imagesSaving', { files: images.map((file) => file.name).join(', ') }));
        const prepared = await Promise.all(images.map(async (file) => {
            const output = await prepareAttachmentFile(file);
            return output ? { file, filename: output.file.name, bytes: new Uint8Array(await output.file.arrayBuffer()) } : null;
        }).map((entry) => entry.catch(() => null)));
        const readable = prepared.filter((entry) => entry !== null);
        let results: Awaited<ReturnType<typeof opencodeClient.writeOpenCodeTempFiles>>;
        try {
            results = readable.length > 0
                ? await opencodeClient.writeOpenCodeTempFiles(currentDirectory, readable.map(({ filename, bytes }) => ({ filename, bytes })))
                : [];
        } catch (error) {
            results = readable.map(({ filename }) => ({ filename, error: error instanceof Error ? error : new Error(String(error)) }));
        }
        toast.dismiss(savingToastId);
        if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) return { saved: [], unsaved: [] };

        const saved = results.flatMap((result) => 'path' in result ? [result] : []);
        const savedNames = new Set(saved.map((result) => result.filename));
        const isSaved = (index: number) => {
            const entry = prepared[index];
            return Boolean(entry && savedNames.has(entry.filename));
        };
        const unsaved = images.filter((_file, index) => !isSaved(index));
        if (results.some((result) => 'error' in result)) {
            // The error text can carry the path; the name says what failed.
            console.warn('[chat] Saving an image failed', results.flatMap((result) => 'error' in result ? [result.error.name] : []));
        }

        if (saved.length > 0) {
            insertCitationAtSelection(buildImagePathCitationText(saved), leadingText);
            const firstPath = saved[0].path.replace(/\\/g, '/');
            const savedFiles = saved.map((result) => result.filename).join(', ');
            const folder = firstPath.slice(0, firstPath.lastIndexOf('/'));
            if (mode === 'alongside') {
                // One toast for a run of pastes; the newest names the latest folder.
                toast.info(t('chat.chatInput.toast.imagesSaved', { files: savedFiles, folder }), { id: `images-saved:${currentModelKey}` });
            } else {
                // When some failed, the modality warning for those (attached next)
                // takes the shared id, so this toast keeps its own.
                toast.info(t('chat.chatInput.toast.imagesSavedForTextModel', {
                    model: currentModelName,
                    files: savedFiles,
                    folder,
                }), unsaved.length > 0 ? undefined : { id: `attachment-modalities:${currentModelKey}` });
            }
        }
        if (unsaved.length > 0) {
            const files = unsaved.map((file) => file.name).join(', ');
            toast.error(mode === 'alongside'
                ? t('chat.chatInput.toast.imageCopySaveFailed', { files })
                : t('chat.chatInput.toast.imageSaveFailed', { files }));
        }
        return { saved: images.filter((_file, index) => isSaved(index)), unsaved };
    }, [currentDirectory, currentModelKey, currentModelName, insertCitationAtSelection, t]);

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
        let imageFiles = files.filter((file) => file.type.startsWith('image/'));
        const otherFiles = files.filter((file) => !file.type.startsWith('image/'));

        const insertCitation = (filenames: string[], text: string) => {
            insertCitationAtSelection(filenames.length > 0 ? buildAttachmentCitationText(filenames) : '', text);
        };

        // With the setting on, links to saved images keep their names too, so an
        // attachment after a failed save never repeats one.
        const usedNames = () => [
            ...useInputStore.getState().attachedFiles.map((file) => file.filename),
            ...pendingPastedAttachmentFilenamesRef.current,
            ...(savePastedImagesAsFiles ? findImagePathCitationNames(composerRef.current?.getValue() ?? messageRef.current) : []),
        ];

        let savedAny = false;
        let attached = false;
        if (imageSaveMode !== 'attach' && imageFiles.length > 0) {
            const { saved, unsaved } = await saveImagesWithPathCitation(imageFiles, leadingText, usedNames(), imageSaveMode);
            if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) return;
            if (saved.length > 0) {
                savedAny = true;
                leadingText = '';
            }
            if (imageSaveMode === 'alongside') {
                // The links already name these, so they attach without a second citation.
                for (const file of saved) {
                    try {
                        attached = (await addAttachedFile(file)) || attached;
                    } catch (error) {
                        console.error('Clipboard image attach failed', error);
                        toast.error(error instanceof Error ? error.message : t('chat.chatInput.toast.clipboardAttachFailed'));
                    }
                    if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) return;
                }
            }
            imageFiles = unsaved;
        }

        const assignedImageNames = assignImageAttachmentFilenames(imageFiles, usedNames());
        // Pending before the text lands, so the editor draws the citation as a
        // chip in the same transaction that inserts it.
        for (const filename of assignedImageNames) pendingPastedAttachmentFilenamesRef.current.add(filename);
        insertCitation(assignedImageNames, leadingText);

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
        let reported = false;
        for (const file of otherFiles) {
            try {
                if (await addAttachedFile(file)) {
                    attached = true;
                    attachedOtherNames.push(file.name);
                }
            } catch (error) {
                console.error('File attach failed', error);
                // The store names the cause (a file too large to attach).
                if (error instanceof Error) {
                    toast.error(error.message);
                    reported = true;
                }
            }
            if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) return;
        }
        insertCitation(attachedOtherNames, '');

        if (files.length > 0 && !attached && !savedAny && !reported) {
            toast.error(t('chat.chatInput.toast.attachFileFailed'));
        }
    }, [addAttachedFile, imageSaveMode, insertCitationAtSelection, savePastedImagesAsFiles, saveImagesWithPathCitation, t]);

    const handlePaste = React.useCallback(async (event: ClipboardEvent) => {
        const clipboardData = event.clipboardData;
        if (!clipboardData) return;
        // Narrowed alias so the rest of the handler reads as it did when this
        // was a React synthetic event, whose clipboardData is never null.
        const e = { ...event, clipboardData, preventDefault: () => event.preventDefault() };

        // A pasted link to another session or one of its messages pastes as
        // usual and draws as a chip once resolved.
        if (!isVSCodeRuntime() && inputMode === 'normal') {
            const links = findSessionLinks(e.clipboardData.getData('text'), sessionLinkOrigins);
            if (links.length > 0) void resolveSessionLinks(links.map((range) => range.target), true);
        }

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

            // A newer large paste replaces an unanswered choice.
            const offerId = beginLargeTextPasteOffer(largeTextPasteOfferIdRef.current);
            largeTextPasteOfferIdRef.current = offerId;

            const resolveLargePaste = (action: LargeTextPasteChoiceAction, explicitlyChosen: boolean, typedText?: string) => {
                const resolution = resolveLargeTextPasteOffer(
                    largeTextPasteOfferIdRef.current,
                    offerId,
                    { explicitlyChosen },
                );
                largeTextPasteOfferIdRef.current = resolution.nextOfferId;
                if (!resolution.accepted) {
                    return;
                }
                setLargeTextPasteOffer(null);
                if (action === 'attach') {
                    void attachAsFile();
                } else {
                    pasteInline();
                }
                if (typedText) {
                    insertTextAtSelection(typedText);
                }
                // Keep this in the tap's gesture: iOS won't raise the
                // keyboard when focus is restored after the attachment awaits.
                if (resolution.restoreFocus) {
                    if (composerRef.current) {
                        composerRef.current.focus({ preventScroll: isCapacitorApp() });
                    } else {
                        // The editor may have collapsed since the paste. The
                        // insertion above appends to its draft; expand mounts
                        // and focuses the editor with the platform's keyboard timing.
                        mobileShell.expand();
                    }
                }
            };

            setLargeTextPasteOffer({ id: offerId, resolve: resolveLargePaste });
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
    }, [addAttachedFile, attachFilesWithCitation, currentSessionId, inputMode, largeTextPasteBehavior, largeTextPasteGesture, readLargeTextPasteSnapshot, markFileMentionPasteSuppression, message, mobileShell, newSessionDraftOpen, insertTextAtSelection, setMessage, t, updateAutocompleteState, resolveSessionLinks, sessionLinkOrigins]);

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

    const completeMentionSelection = useStableHandler((name: string) => {
        const editor = composerRef.current;
        if (!editor) return;
        const value = editor.getValue();
        const cursorPosition = editor.getSelection().start;
        const lastAtSymbol = value.substring(0, cursorPosition).lastIndexOf('@');
        const start = lastAtSymbol === -1 ? cursorPosition : lastAtSymbol;

        // replaceRange reports the edit synchronously. Mark the inserted
        // occurrence before its change callback resolves the next trigger.
        completingMentionRef.current = true;
        try {
            editor.replaceRange(start, cursorPosition, `@${name} `);
        } finally {
            completingMentionRef.current = false;
        }
        closeAutocomplete();
        editor.focus();
    });

    const handleFileSelect = useStableHandler((file: { name: string; path: string; relativePath?: string }) => {
        const mentionPath = (file.relativePath && file.relativePath.trim().length > 0)
            ? file.relativePath.trim()
            : (toMentionPath(file.path) || file.name);
        confirmedMentionsRef.current.add(mentionPath);
        completeMentionSelection(mentionPath);
    });

    // A session is written as its link, which draws as a chip with its title.
    const handleSessionSelect = useStableHandler((session: Session) => {
        const cursorPosition = composerRef.current?.getSelection().start ?? message.length;
        const lastAtSymbol = message.substring(0, cursorPosition).lastIndexOf('@');
        const start = lastAtSymbol === -1 ? cursorPosition : lastAtSymbol;
        const inserted = `${sessionLinkText(session.id)} `;
        rememberSessionMentions([sessionReference(session)]);
        const newMessage = message.substring(0, start) + inserted + message.substring(cursorPosition);
        setMessage(newMessage);
        const nextCursor = start + inserted.length;
        requestAnimationFrame(() => {
            composerRef.current?.setSelection(nextCursor);
            updateAutocompleteState(newMessage, nextCursor);
        });
        closeAutocomplete();
        composerRef.current?.focus();
    });

    const handleSkillSelect = useStableHandler((skillName: string) => {
        const textarea = composerRef.current;
        const cursorPosition = textarea?.getSelection().start ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const skillSigilIndex = lastPrefixSigilIndex(textBeforeCursor, '$');

        if (skillSigilIndex !== -1) {
            const newMessage =
                message.substring(0, skillSigilIndex) +
                `$${skillName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = skillSigilIndex + skillName.length + 2;
            requestAnimationFrame(() => {
                if (composerRef.current) {
                    composerRef.current.setSelection(nextCursor);
                }
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        closeAutocomplete();

        composerRef.current?.focus();
    });

    const handleSnippetSelect = useStableHandler((_snippet: unknown, trigger: string) => {
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
    });

    // "Save draft as #name": the draft goes into the snippet without the
    // `#name` being typed, and once saved that token leaves the composer.
    const snippetDraftText = openAutocomplete === 'snippet' ? withoutSnippetToken(message, autocompleteQuery) : undefined;
    const handleSnippetDraftSaved = useStableHandler((typedName: string) => {
        setMessage(withoutSnippetToken(messageRef.current, typedName));
    });

    const handleEmojiSelect = useStableHandler((emoji: string) => {
        const cursorPosition = composerRef.current?.getSelection().start ?? message.length;
        const startIndex = Math.max(0, cursorPosition - autocompleteQuery.length - 1);
        const inserted = `${emoji} `;
        const newMessage = `${message.substring(0, startIndex)}${inserted}${message.substring(cursorPosition)}`;
        setMessage(newMessage);
        const nextCursor = startIndex + inserted.length;
        requestAnimationFrame(() => {
            composerRef.current?.setSelection(nextCursor);
            updateAutocompleteState(newMessage, nextCursor);
        });
        closeAutocomplete();
        composerRef.current?.focus();
    });

    const handleCommandSelect = useStableHandler((command: CommandInfo) => {
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
    });

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
        let list = Array.isArray(files) ? files : Array.from(files);
        let attached = false;

        const images = list.filter((file) => file.type.startsWith('image/'));
        if (imageSaveMode !== 'attach' && images.length > 0) {
            const { saved, unsaved } = await saveImagesWithPathCitation(
                images,
                '',
                useInputStore.getState().attachedFiles.map((file) => file.filename),
                imageSaveMode,
            );
            if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) return;
            const others = list.filter((file) => !file.type.startsWith('image/'));
            if (imageSaveMode === 'alongside') {
                list = [...others, ...saved, ...unsaved];
            } else {
                attached = saved.length > 0;
                list = [...others, ...unsaved];
            }
        }

        let reported = false;
        for (const file of list) {
            try {
                attached = (await addAttachedFile(file)) || attached;
            } catch (error) {
                console.error('File attach failed', error);
                // The store names the cause (a file too large to attach).
                if (error instanceof Error) {
                    toast.error(error.message);
                    reported = true;
                }
            }
            if (useInputStore.getState().attachmentDraftKey !== attachmentDraftKey) return;
        }
        if (list.length > 0 && !attached && !reported) {
            toast.error(t('chat.chatInput.toast.attachFileFailed'));
        }
    }, [addAttachedFile, imageSaveMode, saveImagesWithPathCitation, t]);

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
    // Only signed-in trackers are offered; connecting one happens in Settings.
    const trackerPickers = React.useMemo<readonly ComposerTrackerPicker[]>(() => (
        !isVSCode
            ? trackerSources.map((descriptor) => {
                const presentation = trackerPresentation(descriptor.id);
                return {
                    provider: descriptor.id,
                    icon: presentation.icon,
                    label: t('chat.chatInput.actions.linkTrackerItem', { provider: descriptor.name }),
                    open: () => setReferencePicker({ source: trackerReferenceSource(descriptor.id) }),
                };
            })
            : []
    ), [isVSCode, t, trackerSources]);
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
        spaceBranchOptions,
        draftBranchItems,
        shouldShowDraftBranchSelector,
        handleDraftProjectChange,
        handleDraftDirectoryChange,
        refreshDraftTarget,
    } = useDraftTarget(showDraftTargetSelectors);
    const draftHeading = useDraftHeading(draftProjectLabel);

    const handleMobileDraftPickerChange = React.useCallback((picker: 'project' | 'branch' | null) => {
        if (picker === 'branch') {
            refreshDraftTarget();
        }
        setMobileDraftPicker(picker);
    }, [refreshDraftTarget]);

    // The one entry to an isolated space: while the feature's switch is on, for a project the
    // branch selector serves, never in VS Code (decision 16). The dialog keeps the project it
    // was opened for, whatever the draft picks after.
    const isolatedSpacesEnabled = useUIStore((state) => state.isolatedSpacesEnabled);
    const [newSpaceProject, setNewSpaceProject] = React.useState<{ id: string; path: string } | null>(null);
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
    const handlePromptHistoryShortcut = React.useCallback((event: KeyboardEvent) => {
        if (
            shortcutRegistry.isSuspended()
            || event.defaultPrevented
            || inputMode !== 'normal'
            || isBtwActive
            || isBtwPanelVisible
            || openAutocomplete !== null
            || mobileCommentActive
            || largeTextPasteOffer !== null
        ) return false;

        if (isPromptHistorySearchOpen) {
            setPromptHistorySearch((current) => current && current.identity === promptHistorySearchIdentity
                ? { ...current, olderRequest: current.olderRequest + 1 }
                : current);
            return true;
        }

        const target = event.target;
        if (!(target instanceof Element) || !target.closest('[data-chat-input="true"], [data-prompt-history-search-input]')) return false;
        const editor = composerRef.current;
        const selection = editor?.getSelection();
        const initialQuery = editor && selection && selection.start !== selection.end
            ? editor.getValue().slice(selection.start, selection.end)
            : '';
        cancelHistoryFocusFrame();
        setPromptHistorySearch({ identity: promptHistorySearchIdentity, initialQuery, olderRequest: 0 });
        return true;
    }, [cancelHistoryFocusFrame, inputMode, isBtwActive, isBtwPanelVisible, isPromptHistorySearchOpen, largeTextPasteOffer, mobileCommentActive, openAutocomplete, promptHistorySearchIdentity]);

    React.useEffect(() => {
        if (!promptHistorySearchOwner) return;
        return registerPromptHistorySearchRoute(promptHistorySearchOwner, handlePromptHistoryShortcut);
    }, [handlePromptHistoryShortcut, promptHistorySearchOwner]);

    const closePromptHistorySearch = React.useCallback((reason: 'dismiss' | 'blur') => {
        const identity = promptHistorySearchIdentityRef.current;
        setPromptHistorySearch(null);
        if (reason !== 'dismiss') return;
        scheduleHistoryFocusFrame(() => {
            if (promptHistorySearchIdentityRef.current === identity) composerRef.current?.focus();
        });
    }, [scheduleHistoryFocusFrame]);

    const pickPromptHistoryCandidate = React.useCallback((candidate: PromptHistoryCandidate<AttachedFile>) => {
        if (!isPromptHistorySearchOpen || promptHistorySearchIdentityRef.current !== promptHistorySearchIdentity) return;
        const recalled = messageHistory.jumpTo(candidate.index, { text: messageRef.current, attachments: attachedFiles }, candidate.value);
        if (!recalled) return;
        setPromptHistorySearch(null);
        applyHistoryValue(recalled, 'end');
    }, [applyHistoryValue, attachedFiles, isPromptHistorySearchOpen, messageHistory, promptHistorySearchIdentity]);
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
                                onReopenPicker={() => setReferencePicker({ source: 'repository', kind: 'issue' })}
                                onRemove={remove}
                            />
                        );
                    case 'repository-discussion':
                        return (
                            <LinkedReferenceRow
                                key={key}
                                numberLabel={`#${reference.number}`}
                                title={reference.title}
                                url={reference.url}
                                author={reference.author}
                                openInBrowserLabel={t('chat.chatInput.linked.discussion.openInBrowserAria')}
                                removeLabel={t('chat.chatInput.linked.discussion.removeAria')}
                                onReopenPicker={() => setReferencePicker({ source: 'repository', kind: 'discussion' })}
                                onRemove={remove}
                            />
                        );
                    case 'change-request':
                        return (
                            <LinkedReferenceRow
                                key={key}
                                numberLabel={formatChangeRequestLabel(descriptorOf(reference.provider), reference.number)}
                                title={reference.title}
                                url={reference.url}
                                author={reference.author}
                                branches={reference.head && reference.base ? { head: reference.head, base: reference.base } : undefined}
                                openInBrowserLabel={t(changeRequestCopy('chat.chatInput.linked.pr.openInBrowserAria', descriptorOf(reference.provider).terminology.changeRequest))}
                                removeLabel={t(changeRequestCopy('chat.chatInput.linked.pr.removeAria', descriptorOf(reference.provider).terminology.changeRequest))}
                                onReopenPicker={() => setReferencePicker({ source: 'repository', kind: 'pull' })}
                                onRemove={remove}
                            />
                        );
                    case 'tracker-item': {
                        const trackerName = trackerDescriptors.find((descriptor) => descriptor.id === reference.provider)?.name ?? reference.provider;
                        return (
                            <LinkedReferenceRow
                                key={key}
                                numberLabel={reference.identifier}
                                title={reference.title}
                                url={reference.url}
                                author={reference.author}
                                openInBrowserLabel={t('chat.chatInput.linked.trackerItem.openInBrowserAria', { provider: trackerName })}
                                removeLabel={t('chat.chatInput.linked.trackerItem.removeAria', { provider: trackerName })}
                                onReopenPicker={() => setReferencePicker({ source: trackerReferenceSource(reference.provider) })}
                                onRemove={remove}
                            />
                        );
                    }
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
    // composer, outside the clipping box.
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
    const worktreeSetupRow = worktreeSetupPending
        ? <ComposerStatusStrip icon="loader-4" spin text={t('chat.worktreeSetup.running')} />
        : null;
    // The first message is on screen while the server still creates its
    // session; this says why Send waits. A worktree's setup line already does.
    // A fast server answers within the delay, and then nothing flashes.
    const creatingSession = Boolean(pendingFirstSend && !pendingFirstSend.sessionCreated && !worktreeSetupPending);
    const creatingSessionRow = useShownAfter(creatingSession, CREATING_SESSION_LINE_DELAY_MS)
        ? <ComposerStatusStrip icon="loader-4" spin text={t('chat.draft.creatingSession')} />
        : null;
    // A message sent while its space is still being made waits for it; the
    // composer is empty then, so this row is the only sign it was not lost.
    const spaceWaitRow = showDraftTargetSelectors && messageWaitsForSpace
        ? <ComposerStatusStrip icon="time" text={t('spaces.draft.queued')} />
        : null;
    const autoReviewRow = !isBtwActive && !newSessionDraftOpen ? <AutoReviewStrip /> : null;
    // The agent waits on its pull request; the server wakes it.
    const prWatchRow = !isBtwActive && !newSessionDraftOpen ? <PullRequestWatchStrip sessionId={currentSessionId} /> : null;
    // The session's goal, then what is still running, then what waits for it.
    const goalRow = !isBtwActive ? (
        <SessionGoalRow
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
        />
    ) : null;
    const revertRow = !isBtwActive && !newSessionDraftOpen ? (
        <RevertedMessagesStrip
            sessionId={currentSessionId}
            directory={currentSessionDirectoryForSync ?? currentDirectory}
        />
    ) : null;
    const queueRow = !isBtwActive && !newSessionDraftOpen ? (
        <QueuedMessagesStrip
            target={parentMessageQueueTarget}
            composerAgentName={currentAgentName}
            onEditMessage={handleQueuedMessageEdit}
            onSendMessage={handleQueuedMessageSend}
        />
    ) : null;
    // Null exactly when the suggestion row alone would have been: the mobile
    // pill picks its shape from whether a top row exists.
    const composerTopRows = worktreeSetupRow || creatingSessionRow || spaceWaitRow || goalRow || autoReviewRow || prWatchRow || backgroundShellsRow || revertRow || queueRow || doneHintRow || reviewHintRow || suggestionRow ? (
        <>
            {worktreeSetupRow}
            {creatingSessionRow}
            {spaceWaitRow}
            {goalRow}
            {autoReviewRow}
            {prWatchRow}
            {backgroundShellsRow}
            {revertRow}
            {queueRow}
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

    /** Address the mobile mic action to this form even if another editor has focus. */
    const toggleDictation = React.useCallback(() => {
        window.dispatchEvent(new CustomEvent('openchamber:dictation-toggle', {
            detail: { composer: composerFormRef.current },
        }));
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

    // The footer's objective counter shows only while a goal is armed; passing
    // the length otherwise would re-render the whole footer on every keystroke.
    const goalArmed = useSessionGoalArmStore((state) => state.armed);
    // Set by the footer's desktop dictation; the mobile overlay lives outside the box.
    const [desktopDictating, setDesktopDictating] = React.useState(false);
    const goalObjectiveLength = goalArmed ? message.length : 0;
    const waitingForOpenCode = useOpenCodeStartupStore((state) => state.waitingSends > 0);

    const footerPaddingClass = isMobile ? 'px-1.5 py-1.5' : (isVSCode ? 'px-1.5 py-1' : 'px-2.5 py-1.5');
    const buttonSizeClass = isMobile ? 'h-8 w-8' : (isVSCode ? 'h-5 w-5' : 'h-6 w-6');
    const sendIconSizeClass = isMobile ? 'h-4 w-4' : (isVSCode ? 'h-3.5 w-3.5' : 'h-4 w-4');
    const stopIconSizeClass = isMobile ? 'h-6 w-6' : (isVSCode ? 'h-4 w-4' : 'h-5 w-5');
    // 16px on desktop, the size of the model controls' effort and agent icons
    // and of the send arrow, so the footer's glyphs read as one row.
    const iconSizeClass = isMobile ? 'h-[18px] w-[18px]' : 'h-4 w-4';

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
        if (!isPermissionAutoAcceptInteractive || isPromptHistorySearchOpen) return false;
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

    // The editor is memoized: stable handlers let it skip the composer's
    // renders while a reply streams, which change nothing it shows.
    const handleEditorChange = useStableHandler(handleComposerChange);
    const handleEditorKeyDown = useStableHandler((event: KeyboardEvent) => {
        // Every interception branch calls preventDefault, so the event itself
        // reports whether the composer consumed it.
        handleKeyDown(event);
        return event.defaultPrevented;
    });
    const handleEditorKeyUp = useStableHandler((event: KeyboardEvent) => largeTextPasteGesture.keyUp(event));
    const handleEditorSelectionChange = useStableHandler((selection: ComposerSelection) => {
        largeTextPasteGesture.invalidate();
        cursorPosRef.current = selection.start;
        updateAutocompleteOverlayPosition();
    });
    const handleEditorBlur = useStableHandler(() => {
        largeTextPasteGesture.invalidate();
        mobileShell.onEditorBlur();
    });

    return (
        <>
        <form
            ref={setPromptHistorySearchForm}
            data-prompt-history-search-owner="true"
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
                if (isPromptHistorySearchOpen) return;
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
                        {renderDraftTitle(draftHeading, draftProjectLabel)}
                    </h1>
                </div>
            ) : null}
            <div className={cn('chat-input-column relative overflow-visible', isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}>
                {/* Comment mode shows only its own shell: the normal composer's
                    furniture (chips, banners, draft selectors) stays in state
                    and returns unchanged when the comment exits. */}
                {!mobileCommentActive ? (<>
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
                            spaceBranchOptions={spaceBranchOptions}
                            branchItems={draftBranchItems}
                            showBranchSelector={shouldShowDraftBranchSelector}
                            onProjectChange={handleDraftProjectChange}
                            onDirectoryChange={handleDraftDirectoryChange}
                            onRefreshTarget={refreshDraftTarget}
                            onCreateSpace={handleCreateSpace}
                            onCreateCustomWorktree={handleCreateCustomWorktree}
                            theme={currentTheme}
                        />
                    </div>
                ) : null}
                {isMobile && showDraftTargetSelectors && selectedDraftProject ? (
                    <MobileDraftTargetTriggers
                        selectedProject={selectedDraftProject}
                        selectedBranchLabel={selectedDraftBranchLabel}
                        showBranchSelector={shouldShowDraftBranchSelector}
                        theme={currentTheme}
                        onOpenPicker={handleMobileDraftPickerChange}
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
                        newSessionDraftOpen={newSessionDraftOpen}
                        hasContent={Boolean(hasContent) && !pendingFirstSend}
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
                        onPickLocalFiles={handlePickLocalFiles}
                        onOpenGitHubPicker={openGitHubPicker}
                        repositoryProvider={repositoryProvider}
                        trackerPickers={trackerPickers}
                        onOpenAttachSheet={openMobileAttachSheet}
                        onStartDictation={toggleDictation}
                        onAbort={handleAbort}
                    />
                ) : (
                <>
                {/* The autocomplete popups anchor to this wrapper, not to the
                    box, which clips its contents. */}
                <div
                    ref={isMobile ? undefined : setContextPreviewHost}
                    className={cn('relative', isComposerExpanded && 'flex flex-1 min-h-0 flex-col')}
                >
                    {largeTextPasteOffer ? (
                        <LargeTextPasteChoice
                            key={largeTextPasteOffer.id}
                            takeFocus={!isMobile}
                            onChoose={(action, explicitlyChosen) => largeTextPasteOffer.resolve(action, explicitlyChosen)}
                            onTypeThrough={(text) => largeTextPasteOffer.resolve('inline', true, text)}
                        />
                    ) : null}
                    <ComposerAutocompletePopups
                        open={openAutocomplete}
                        query={autocompleteQuery}
                        overlayPosition={autocompleteOverlayPosition}
                        commandRef={commandRef}
                        skillRef={skillRef}
                        snippetRef={snippetRef}
                        mentionRef={mentionRef}
                        emojiRef={emojiRef}
                        onCommandSelect={handleCommandSelect}
                        onSkillSelect={handleSkillSelect}
                        onSnippetSelect={handleSnippetSelect}
                        snippetDraftText={snippetDraftText}
                        onSnippetDraftSaved={handleSnippetDraftSaved}
                        onFileSelect={handleFileSelect}
                        onAgentSelect={completeMentionSelection}
                        // VS Code shows no reference chips, so it cannot hold one.
                        onSessionSelect={isVSCode ? undefined : handleSessionSelect}
                        currentSessionId={currentSessionId}
                        onEmojiSelect={handleEmojiSelect}
                        onClose={closeAutocomplete}
                    />
                <div
                    className={cn(
                        'flex flex-col',
                        isComposerExpanded && 'relative flex-1 min-h-0',
                    )}
                    style={{ borderRadius: chatInputRadius }}
                >
                {/* Normal: zero-height row above the composer box. Expanded: the
                    box grows to fill the column, so the anchor is pinned to the
                    box's bottom edge instead of flowing before it. */}
                <div
                    className={cn(isComposerExpanded ? 'absolute inset-s-0 inset-e-0 bottom-0 h-0' : 'relative h-0')}
                    data-prompt-history-search-anchor
                >
                    {isPromptHistorySearchOpen && promptHistorySearch ? (
                        <PromptHistorySearchPanel
                            history={historyValues}
                            initialQuery={promptHistorySearch.initialQuery}
                            olderRequest={promptHistorySearch.olderRequest}
                            onPick={pickPromptHistoryCandidate}
                            onClose={closePromptHistorySearch}
                        />
                    ) : null}
                </div>
                <div
                    className={cn(
                        "flex flex-col relative overflow-visible",
                        isComposerExpanded && 'flex-1 min-h-0',
                        // Opaque: always on screen over the moving transcript
                        // (see .oc-surface-floating in design-system.css).
                        'oc-surface-floating',
                        // Lit like a dropdown (top edge, hairline, shadow). Its
                        // box-shadow would hide the drag ring, so it steps aside
                        // while a file is dragged over.
                        isDragging ? "ring-2 ring-primary ring-offset-2" : 'oc-glass-floating oc-composer-sheen',
                    )}
                    style={{ borderRadius: chatInputRadius }}
                    ref={dropZoneRef}
                    // The mobile pill morph measures and animates this box.
                    data-composer-box={isMobile ? 'true' : undefined}
                    // The desktop dictation overlay is up: the box hides its
                    // other contents (see design-system.css).
                    data-dictating={desktopDictating && !isMobile && !isBtwActive ? 'true' : undefined}
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
                    <div className={cn('relative flex flex-col', isComposerExpanded && 'flex-1 min-h-0')} data-dictation-chain="true">
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
                                onChange={handleEditorChange}
                                onKeyDown={handleEditorKeyDown}
                                onPaste={handlePaste}
                                onKeyUp={handleEditorKeyUp}
                                onSelectionChange={handleEditorSelectionChange}
                                onFocus={mobileShell.onEditorFocus}
                                onBlur={handleEditorBlur}
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
                                // Return-key send trusts the deferred Shift only from a
                                // hardware keyboard: iOS autocapitalization arms a phantom
                                // Shift at sentence starts that must send, not newline.
                                preserveDeferredEnterShift={
                                    isMobile && mobileReturnKeySends
                                        ? hasHardwareKeyboard
                                        : !enterToSendConfigured || !isMobile
                                }
                                returnKeySends={isMobile && mobileReturnKeySends}
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
                        escapeStops={!isMiniChatSurface}
                        sessionId={currentSessionId}
                        directory={currentSessionDirectoryForSync ?? currentDirectory}
                        newSessionDraftOpen={newSessionDraftOpen}
                        messageLength={goalObjectiveLength}
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
                        permissionMode={shownPermissionMode}
                        isPermissionAutoAcceptInteractive={isPermissionAutoAcceptInteractive}
                        dictationActive={mobileShell.dictationActive}
                        onOpenSettings={onOpenSettings}
                        onPickLocalFiles={handlePickLocalFiles}
                        onOpenGitHubPicker={openGitHubPicker}
                        repositoryProvider={repositoryProvider}
                        trackerPickers={trackerPickers}
                        attachGuests={isMobile ? NO_ATTACH_GUESTS : guestAttachItems}
                        onOpenGuestAttach={openGuestAttach}
                        onOpenAttachSheet={openMobileAttachSheet}
                        onCyclePermissionMode={handlePermissionModeCycle}
                        onPrimaryAction={handlePrimaryAction}
                        onAbort={handleAbort}
                        onStartDictation={toggleDictation}
                        onDictationInsert={handleDictationInsert}
                        onDictationInsertAndSend={handleDictationInsertAndSend}
                        onDictationSendStart={handleDictationSendStart}
                        onDictationStart={markDictationStart}
                        onDictationContentHeightChange={handleDictationContentHeightChange}
                        onDictationActiveChange={setDesktopDictating}
                        isBtw={isBtwActive}
                        modelSessionId={btwComposerSessionId}
                        btwSelection={effectiveBtwSelection}
                        pinnedSelection={pinnedComposerSelection}
                        onRunInParallel={!isMobile && !isBtwActive && !columnPinned ? handleRunInParallel : undefined}
                        parallelRun={parallelRun}
                        waitingForOpenCode={waitingForOpenCode}
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
                    so the form's dictation events belong to that engine.
                    An in-flight recording is discarded by the swap:
                    its transcript must never reach the normal draft. */}
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
                    onSubmit={handlePresetChipSubmit}
                    className={cn('chat-input-column mt-4', draftPresentationClassName)}
                />
            ) : null}
            {/* One floating panel at a time: an open BTW, then a permission,
                then the form, then a collapsed BTW strip. */}
            <PermissionDock
                sessionId={currentSessionId}
                directory={currentSessionDirectoryForSync ?? currentDirectory ?? undefined}
                hidden={newSessionDraftOpen || isBtwActive || isBtwPanelVisible || isPromptHistorySearchOpen}
            />
            <FormDock
                sessionId={currentSessionId}
                directory={currentSessionDirectoryForSync ?? currentDirectory ?? undefined}
                hidden={newSessionDraftOpen || isBtwActive || isBtwPanelVisible || hasPendingPermission || isPromptHistorySearchOpen}
            />
            {currentSessionId ? <BtwPanel parentSessionId={currentSessionId} panel={btwPanel} hidden={!isBtwPanelVisible} onExit={handleExitBtw} /> : null}
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
                initialGitHubKind={referencePicker.source === 'repository' ? referencePicker.kind : undefined}
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
        {reviewDialogMounted ? <ReviewFlowDialog
            open={reviewDialogOpen}
            onOpenChange={setReviewDialogOpen}
            projectDirectory={currentSessionDirectoryForSync ?? currentDirectory ?? null}
            submitting={reviewFlowSubmitting}
            onConfirm={handleStartReviewFlow}
        /> : null}
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
        <AttachmentPickerInput ref={fileInputRef} onChange={handleLocalFileSelect} />

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
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-3 text-start typography-ui-label hover:bg-[var(--interactive-hover)]"
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
                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-3 text-start typography-ui-label hover:bg-[var(--interactive-hover)]"
                        onClick={() => {
                            // Hand-off to the picker: don't sync-restore the
                            // keyboard under the overlay that opens next frame.
                            mobileShell.skipNextOverlayCloseRestore();
                            setMobileAttachMenuOpen(false);
                            requestAnimationFrame(openGitHubPicker);
                        }}
                    >
                        <ProviderIcon descriptor={repositoryDescriptor} className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                        {t(`chat.chatInput.actions.linkRepositoryItem.${repositoryDescriptor.terminology.changeRequest}`, { provider: repositoryDescriptor.label })}
                    </button>
                    {trackerPickers.map((picker) => (
                        <button
                            key={picker.provider}
                            type="button"
                            className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-3 text-start typography-ui-label hover:bg-[var(--interactive-hover)]"
                            onClick={() => {
                                mobileShell.skipNextOverlayCloseRestore();
                                setMobileAttachMenuOpen(false);
                                requestAnimationFrame(picker.open);
                            }}
                        >
                            <Icon name={picker.icon} className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                            {picker.label}
                        </button>
                    ))}
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
                spaceBranchOptions={spaceBranchOptions}
                branchItems={draftBranchItems}
                showBranchSelector={shouldShowDraftBranchSelector}
                onProjectChange={handleDraftProjectChange}
                onDirectoryChange={handleDraftDirectoryChange}
                onCreateSpace={handleCreateSpace}
                onCreateCustomWorktree={handleCreateCustomWorktree}
                theme={currentTheme}
                openPicker={mobileDraftPicker}
                onOpenPickerChange={handleMobileDraftPickerChange}
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

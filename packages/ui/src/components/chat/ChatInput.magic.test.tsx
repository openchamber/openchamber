import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot, type Root } from 'react-dom/client';

import { getDefaultTheme } from '@/lib/theme/themes';

const DIRECTORY = '/repo-chat-input';
const RUNTIME_KEY = 'runtime-chat-input';

type SessionUIState = {
    currentSessionId: string | null;
    currentSessionDirectory: string | null;
    newSessionDraft: {
        open: boolean;
        target: 'chat' | 'project';
        permissionAutoAcceptEnabled?: boolean;
        bootstrapPendingDirectory?: string;
        directoryOverride?: string;
    };
    abortPromptSessionId: string | null;
    getDirectoryForSession: (sessionId: string) => string | null;
    sendMessage: (...args: never[]) => Promise<void>;
    setNewSessionDraftTarget: (...args: never[]) => void;
    setDraftPermissionAutoAcceptEnabled: (...args: never[]) => void;
    openNewSessionDraft: (...args: never[]) => void;
    prepareChatDraftDirectory: () => Promise<void>;
    clearAbortPrompt: () => void;
    acknowledgeSessionAbort: (...args: never[]) => void;
    handleSlashUndo: (...args: never[]) => Promise<void>;
    handleSlashRedo: (...args: never[]) => Promise<void>;
};

const sessionUIState: SessionUIState = {
    currentSessionId: 'session-chat-input',
    currentSessionDirectory: DIRECTORY,
    newSessionDraft: { open: false, target: 'project' },
    abortPromptSessionId: null,
    getDirectoryForSession: () => DIRECTORY,
    sendMessage: async () => undefined,
    setNewSessionDraftTarget: () => undefined,
    setDraftPermissionAutoAcceptEnabled: () => undefined,
    openNewSessionDraft: () => undefined,
    prepareChatDraftDirectory: async () => undefined,
    clearAbortPrompt: () => undefined,
    acknowledgeSessionAbort: () => undefined,
    handleSlashUndo: async () => undefined,
    handleSlashRedo: async () => undefined,
};

const useSessionUIStoreMock = Object.assign(
    <T,>(selector: (state: SessionUIState) => T): T => selector(sessionUIState),
    { getState: () => sessionUIState },
);

mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: useSessionUIStoreMock }));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => RUNTIME_KEY }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/lib/chatDraftPersistence', () => ({
    createChatDraftIdentity: (runtimeKey: string, directory: string | null | undefined, sessionId: string | null) => ({
        runtimeKey,
        directory: directory ?? '',
        sessionId,
    }),
    readChatDraft: () => ({ text: '', confirmedMentions: new Set<string>() }),
    writeChatDraft: () => undefined,
}));
mock.module('@/hooks/useQueuedMessageAutoSend', () => ({
    isQueuedSendBlockedForTarget: () => false,
    resolveQueuedSessionStatusType: () => 'idle',
}));
mock.module('@/hooks/useSessionActivity', () => ({
    useCurrentSessionActivity: () => ({ phase: 'idle', isWorking: false, isBusy: false, isCooldown: false }),
    useSessionActivity: () => ({ phase: 'idle', isWorking: false, isBusy: false, isCooldown: false }),
}));
mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => DIRECTORY }));
mock.module('@/hooks/useChatSearchDirectory', () => ({ useChatSearchDirectory: () => DIRECTORY }));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ git: null, vscode: null, linear: null }) }));
mock.module('@/hooks/useKeybind', () => ({ useKeybind: () => undefined }));
mock.module('@/lib/hardwareKeyboard', () => ({ useHardwareKeyboard: () => false }));
mock.module('@/lib/device', () => ({ useTabletLayout: () => ({ enabled: false }) }));
mock.module('@/lib/desktop', () => ({ isVSCodeRuntime: () => false }));
mock.module('@/lib/ime', () => ({ isIMECompositionEvent: () => false }));
mock.module('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: getDefaultTheme(true) }) }));
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: async () => new Response(null, { status: 404 }) }));
mock.module('@/lib/opencode/client', () => ({ opencodeClient: { getDirectory: () => DIRECTORY } }));
mock.module('@/lib/shortcuts', () => ({
    eventMatchesShortcut: () => false,
    getEffectiveShortcutCombo: () => '',
    normalizeCombo: (combo: string) => combo,
}));
mock.module('@/lib/linkedIssues', () => ({ buildLinkedIssue: () => null, buildLinkedLinearIssue: () => null }));
mock.module('@/lib/reviewFlow', () => ({ startReviewFlow: async () => undefined }));
mock.module('@/lib/sessionEvents', () => ({
    sessionEvents: { onGitRefreshHint: () => () => undefined },
}));
mock.module('@/lib/responseStyle', () => ({ fetchResponseStyleInstruction: async () => null }));
mock.module('@/lib/systemReminder', () => ({ wrapSystemReminder: (text: string) => text }));
mock.module('@/lib/btw', () => ({
    buildBtwSyntheticTexts: () => [],
    destroyBtwSession: async () => undefined,
    startBtwSession: async () => undefined,
}));
mock.module('@/lib/sessionBtwMetadata', () => ({ wasPromotedBtwSession: () => false }));
mock.module('@/lib/chunkLoadRecovery', () => ({ lazyWithChunkRecovery: () => () => null }));
mock.module('@/components/ui', () => ({ toast: { error: () => undefined, warning: () => undefined } }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));

type ConfigState = {
    currentProviderId: string;
    currentModelId: string;
    currentVariant: string | undefined;
    currentAgentName: string | null;
    modelsMetadata: Record<string, never>;
    providers: Record<string, never>;
    getModelMetadata: () => undefined;
    getVisibleAgents: () => [];
    setAgent: () => undefined;
};
const configState: ConfigState = {
    currentProviderId: 'provider-chat-input',
    currentModelId: 'model-chat-input',
    currentVariant: undefined,
    currentAgentName: null,
    modelsMetadata: {},
    providers: {},
    getModelMetadata: () => undefined,
    getVisibleAgents: () => [],
    setAgent: () => undefined,
};
mock.module('@/stores/useConfigStore', () => ({
    useConfigStore: <T,>(selector: (state: ConfigState) => T): T => selector(configState),
}));

type UIState = {
    isMobile: boolean;
    inputBarOffset: number;
    persistChatDraft: boolean;
    inputSpellcheckEnabled: boolean;
    largeTextPasteBehavior: 'ask' | 'attach' | 'inline';
    isExpandedInput: boolean;
    shortcutOverrides: Record<string, string>;
    setImagePreviewOpen: () => undefined;
    setExpandedInput: () => undefined;
    setTimelineDialogOpen: () => undefined;
};
const uiState: UIState = {
    isMobile: false,
    inputBarOffset: 0,
    persistChatDraft: false,
    inputSpellcheckEnabled: false,
    largeTextPasteBehavior: 'ask',
    isExpandedInput: false,
    shortcutOverrides: {},
    setImagePreviewOpen: () => undefined,
    setExpandedInput: () => undefined,
    setTimelineDialogOpen: () => undefined,
};
mock.module('@/stores/useUIStore', () => ({
    useUIStore: <T,>(selector: (state: UIState) => T): T => selector(uiState),
}));

type DirectoryState = { currentDirectory: string; homeDirectory: string };
const directoryState: DirectoryState = { currentDirectory: DIRECTORY, homeDirectory: '/home/test' };
mock.module('@/stores/useDirectoryStore', () => ({
    useDirectoryStore: <T,>(selector: (state: DirectoryState) => T): T => selector(directoryState),
}));

type RegistryState = { commands: []; directoryScoped: Map<string, []> };
const registryState: RegistryState = { commands: [], directoryScoped: new Map() };
mock.module('@/stores/useCommandsStore', () => ({
    useCommandsStore: Object.assign(
        <T,>(selector: (state: RegistryState) => T): T => selector(registryState),
        { getState: () => registryState },
    ),
    selectCommandsForDirectory: () => [],
}));
mock.module('@/stores/useSkillsStore', () => ({
    useSkillsStore: Object.assign(
        <T,>(selector: (state: RegistryState) => T): T => selector(registryState),
        { getState: () => registryState },
    ),
    selectSkillsForDirectory: () => [],
}));
mock.module('@/stores/useSnippetsStore', () => ({
    useSnippetsStore: Object.assign(
        <T,>(selector: (state: { snippets: []; expandText: (text: string) => Promise<string> }) => T): T => selector({ snippets: [], expandText: async (text) => text }),
        { getState: () => ({ snippets: [], expandText: async (text: string) => text }) },
    ),
}));
mock.module('@/stores/permissionStore', () => ({
    usePermissionStore: <T,>(selector: (state: { setSessionAutoAccept: () => undefined; isSessionAutoAccepting: () => boolean }) => T): T => selector({
        setSessionAutoAccept: () => undefined,
        isSessionAutoAccepting: () => false,
    }),
}));
mock.module('@/stores/useGitStore', () => ({
    useGitStore: <T,>(selector: (state: { directories: Map<string, never>; ensureStatus: () => Promise<void>; fetchStatus: () => Promise<void>; clearDiffCache: () => undefined }) => T): T => selector({
        directories: new Map<string, never>(),
        ensureStatus: async () => undefined,
        fetchStatus: async () => undefined,
        clearDiffCache: () => undefined,
    }),
    useIsGitRepo: () => false,
}));
mock.module('@/sync/selection-store', () => ({
    useSelectionStore: <T,>(selector: (state: { saveSessionAgentSelection: () => undefined }) => T): T => selector({ saveSessionAgentSelection: () => undefined }),
}));
mock.module('@/lib/runtime-auth-expiry', () => ({ useAuthSessionStore: { getState: () => ({ state: 'ok' }) } }));
mock.module('@/sync/session-actions', () => ({
    waitForConnectionOrThrow: async () => undefined,
    abortCurrentOperation: async () => undefined,
    dismissOpenPermissionsForSession: async () => false,
    dismissOpenQuestionsForSession: async () => false,
}));
mock.module('@/sync/sync-context', () => ({ useUserMessageHistory: () => [] }));

mock.module('@/components/chat/btw/BtwPanel', () => ({ BtwPanel: () => null }));
mock.module('@/components/chat/btw/useBtwPanelState', () => ({
    useBtwPanelState: () => ({ btwSessionId: null, btwDirectory: null, collapsed: false, parentSession: null }),
}));
mock.module('@/components/chat/FileAttachment', () => ({
    AttachedFilesList: () => null,
    AttachedVSCodeFileChips: () => null,
    ActiveEditorFileSuggestion: () => null,
}));
mock.module('@/components/chat/QueuedMessageChips', () => ({ QueuedMessageChips: () => null }));
mock.module('@/components/chat/AutoReviewBanner', () => ({ AutoReviewBanner: () => null }));
mock.module('@/components/chat/ModelControls', () => ({ ModelControls: () => null }));
mock.module('@/components/chat/ComposerStatusBar', () => ({ ComposerStatusBar: () => null }));
mock.module('@/components/chat/PendingChangesBar', () => ({ PendingChangesBar: () => null }));
mock.module('@/components/chat/MobileAgentButton', () => ({ MobileAgentButton: () => null }));
mock.module('@/components/chat/MobileModelButton', () => ({ MobileModelButton: () => null }));
mock.module('@/components/chat/DraftPresetChips', () => ({ DraftPresetChips: () => null }));
mock.module('@/components/chat/SessionSuggestionChip', () => ({ SessionSuggestionChip: () => null }));
mock.module('@/components/chat/SessionGoalRow', () => ({ SessionGoalRow: () => null }));
mock.module('@/components/session/GitHubIssuePickerDialog', () => ({ GitHubIssuePickerDialog: () => null }));
mock.module('@/components/session/GitHubPrPickerDialog', () => ({ GitHubPrPickerDialog: () => null }));
mock.module('@/components/session/LinearIssuePickerDialog', () => ({ LinearIssuePickerDialog: () => null }));
mock.module('@/components/session/ReviewFlowDialog', () => ({ ReviewFlowDialog: () => null }));
mock.module('@/components/dictation/ComposerDictation', () => ({ ComposerDictation: () => null }));
mock.module('@/components/ui/MobileOverlayPanel', () => ({ MobileOverlayPanel: () => null }));

const localModule = (path: string): string => new URL(path, import.meta.url).pathname;
mock.module(localModule('./markdown/markdown-worker.ts'), () => ({
    highlightCodeInWorker: async () => null,
}));
mock.module(`${localModule('./markdown/markdown-shiki.worker.ts')}?worker&url`, () => ({ default: 'worker-url' }));
mock.module('./markdown/markdown-shiki.worker.ts?worker&url', () => ({ default: 'worker-url' }));
mock.module(localModule('./composer/ui/ComposerAutocompletePopups.tsx'), () => ({ ComposerAutocompletePopups: () => null }));
mock.module(localModule('./composer/ui/DraftTargetSelectors.tsx'), () => ({
    DraftTargetSelectors: () => null,
    MobileDraftTargetSheets: () => null,
    MobileDraftTargetTriggers: () => null,
}));
mock.module(localModule('./composer/ui/MobilePillComposer.tsx'), () => ({ MobilePillComposer: () => null }));
mock.module(localModule('./composer/ui/ComposerContextChips.tsx'), () => ({ ComposerContextChips: () => null }));
mock.module(localModule('./composer/ui/LinkedReferenceRow.tsx'), () => ({ LinkedReferenceRow: () => null }));
mock.module(localModule('./composer/ui/RevertedMessageDock.tsx'), () => ({ RevertedMessageDock: () => null }));
mock.module(localModule('./composer/ui/ComposerFooter.tsx'), () => ({
    ComposerFooter: ({ onPrimaryAction }: { onPrimaryAction: () => void }) => React.createElement(
        'button',
        { type: 'button', 'data-testid': 'chat-submit', onClick: onPrimaryAction },
        'send',
    ),
}));
mock.module(localModule('./composer/state/useMessageHistory.ts'), () => ({
    useMessageHistory: () => ({ reset: () => undefined, older: () => null, newer: () => null }),
}));
mock.module(localModule('./composer/state/useComposerDraft.ts'), () => ({
    useComposerDraft: () => ({ persistNow: () => undefined }),
}));
mock.module(localModule('./composer/state/useDraftTarget.ts'), () => ({
    useDraftTarget: () => ({
        projects: [],
        selectedDraftProject: null,
        draftProjectLabel: null,
        selectedDraftDirectory: null,
        selectedDraftBranchLabel: null,
        selectedDraftBranchIsKnown: false,
        projectRootBranchOption: null,
        worktreeBranchOptions: [],
        draftBranchItems: [],
        shouldShowDraftBranchSelector: false,
        handleDraftProjectChange: () => undefined,
        handleDraftDirectoryChange: () => undefined,
    }),
}));
mock.module(localModule('./composer/state/useMobileComposerShell.ts'), () => ({
    useMobileComposerShell: () => ({
        expanded: false,
        focused: false,
        dictationActive: false,
        expand: () => undefined,
        onEditorFocus: () => undefined,
        onEditorBlur: () => undefined,
        onDictationActiveChange: () => undefined,
        cancelOverlayCloseRestore: () => undefined,
        skipNextOverlayCloseRestore: () => undefined,
    }),
}));
mock.module(localModule('./composer/state/useMobileViewportPin.ts'), () => ({ useMobileViewportPin: () => undefined }));
mock.module(localModule('./composer/state/useAutocompletePosition.ts'), () => ({
    useAutocompletePosition: () => ({ position: null, update: () => undefined }),
}));

type EditorProps = { value: string };
type EditorHandle = {
    getValue: () => string;
    getSelection: () => { start: number; end: number };
    focus: () => undefined;
    blur: () => undefined;
    selectAll: () => undefined;
};
mock.module(localModule('./composer/editor/ComposerEditor.tsx'), () => ({
    ComposerEditor: React.forwardRef<EditorHandle, EditorProps>(({ value }, ref) => {
        React.useImperativeHandle(ref, () => ({
            getValue: () => value,
            getSelection: () => ({ start: value.length, end: value.length }),
            focus: () => undefined,
            blur: () => undefined,
            selectAll: () => undefined,
        }), [value]);
        return React.createElement('textarea', { 'data-testid': 'chat-input', value, readOnly: true });
    }),
}));

const summaryCommand = { name: 'summary', errorToastKey: 'chat.chatInput.toast.summaryFailed' };
mock.module(localModule('./composer/submit/slashCommands.ts'), () => ({
    parseSlashCommand: (text: string) => {
        const match = /^\s*\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
        return match ? { name: match[1]?.toLowerCase() ?? '', argument: match[2] ?? '' } : null;
    },
    findMagicPromptCommand: (name: string) => name === 'summary' ? summaryCommand : null,
    canRunCommand: () => true,
    renderMagicPromptCommand: async () => {
        throw new Error('magic render failed');
    },
}));

import { createMessageQueueTarget, useMessageQueueStore } from '@/stores/messageQueueStore';

describe('ChatInput magic prompt failure', () => {
    let windowInstance: Window;
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        windowInstance = new Window();
        Object.assign(globalThis, {
            window: windowInstance,
            document: windowInstance.document,
            HTMLElement: windowInstance.HTMLElement,
            Element: windowInstance.Element,
            Node: windowInstance.Node,
            PointerEvent: windowInstance.PointerEvent,
            IS_REACT_ACT_ENVIRONMENT: true,
        });
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        useMessageQueueStore.setState({
            queuedMessages: {},
            sendingIds: {},
            queueDeletionGenerations: {},
            quarantinedLegacyMessages: {},
        });
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        windowInstance.close();
    });

    test('restores merged queue entries and captured context when magic rendering fails', async () => {
        const { ChatInput } = await import('./ChatInput');
        const target = createMessageQueueTarget('session-chat-input', DIRECTORY, RUNTIME_KEY);
        if (!target) throw new Error('queue target derivation failed');
        const capturedContext = [{ text: 'queued review context', synthetic: true }];
        useMessageQueueStore.getState().addToQueue(target, {
            content: '/summary latency',
            additionalParts: [{ text: 'queued instructions', synthetic: true }, ...capturedContext],
            capturedContext,
            contextClaimed: true,
            sendConfig: { providerID: 'provider-chat-input', modelID: 'model-chat-input' },
        });
        const beforeSend = useMessageQueueStore.getState().getQueueForTarget(target);

        await act(async () => {
            root.render(React.createElement(ChatInput));
            await Promise.resolve();
        });
        const submit = host.querySelector<HTMLButtonElement>('[data-testid="chat-submit"]');
        if (!submit) throw new Error('ChatInput submit harness did not render');

        await act(async () => {
            submit.click();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual(beforeSend);
        expect(useMessageQueueStore.getState().getQueueForTarget(target)[0]?.capturedContext).toEqual(capturedContext);
    });
});

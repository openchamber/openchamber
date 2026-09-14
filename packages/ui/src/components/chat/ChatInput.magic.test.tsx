import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot, type Root } from 'react-dom/client';

import { getDefaultTheme } from '@/lib/theme/themes';
import type { RuntimeFetchOptions } from '@/lib/runtime-fetch';

const DIRECTORY = '/repo-chat-input';
const RUNTIME_KEY = 'runtime-chat-input';
let activeRuntimeKey = RUNTIME_KEY;
let liveSessionStatus: 'idle' | 'busy' = 'idle';
let sendShouldFail = false;
let sendMessageCalls: unknown[][] = [];
let vscodeRuntime = true;
type RuntimeFetchCall = { path: string; method: string; runtimeKey: string };
let runtimeFetchCalls: RuntimeFetchCall[] = [];
let runtimeFetchHandler: (path: string, init?: RuntimeFetchOptions) => Response | Promise<Response> = () => new Response(null, { status: 404 });

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
    sendMessage: async (...args: never[]) => {
        sendMessageCalls.push(args);
        if (sendShouldFail) throw new Error('send failed');
    },
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
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => activeRuntimeKey }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/lib/chatDraftPersistence', () => ({
    createChatDraftIdentity: (runtimeKey: string, directory: string | null | undefined, sessionId: string | null) => ({
        runtimeKey,
        directory: directory ?? '',
        sessionId,
    }),
    getChatDraftIdentityKey: (identity: { runtimeKey: string; directory: string; sessionId: string | null }) =>
        `${identity.runtimeKey}\n${identity.directory}\n${identity.sessionId}`,
    readChatDraft: () => ({ text: '', confirmedMentions: new Set<string>() }),
    writeChatDraft: () => undefined,
    clearChatDraft: () => undefined,
}));
mock.module('@/hooks/useQueuedMessageAutoSend', () => ({
    isQueuedSendBlockedForTarget: () => false,
    resolveQueuedSessionStatusType: () => liveSessionStatus,
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
mock.module('@/lib/desktop', () => ({ isVSCodeRuntime: () => vscodeRuntime }));
// ChatInput reads the auto-review store both as a hook and via getState. The
// hook-only mock QueuedMessageChips.test.tsx registers leaks into this file
// when the group runs in one process, so keep a self-contained stub here.
type AutoReviewStateStub = {
    runsByOriginalSessionID: Record<string, never>;
};
const autoReviewMockState: AutoReviewStateStub = { runsByOriginalSessionID: {} };
const useAutoReviewStoreMock = Object.assign(
    <T,>(selector: (state: AutoReviewStateStub) => T): T => selector(autoReviewMockState),
    { getState: (): AutoReviewStateStub => autoReviewMockState },
);
mock.module('@/stores/useAutoReviewStore', () => ({
    useAutoReviewStore: useAutoReviewStoreMock,
    isAutoReviewRunActiveForTarget: () => false,
}));
mock.module('@/lib/ime', () => ({ isIMECompositionEvent: () => false }));
mock.module('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: getDefaultTheme(true) }) }));
mock.module('@/lib/runtime-fetch', () => ({
    runtimeFetch: async (path: string, init?: RuntimeFetchOptions) => {
        runtimeFetchCalls.push({ path, method: init?.method ?? 'GET', runtimeKey: activeRuntimeKey });
        return runtimeFetchHandler(path, init);
    },
}));
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
    preparePendingBtwSend: async () => null,
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
    currentVariantSelection: { override: string | undefined; inherited: string | undefined };
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
    currentVariantSelection: { override: undefined, inherited: undefined },
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
mock.module('@/components/chat/QueuedMessageChips', () => ({
    QueuedMessageChips: ({ onSendMessage }: { onSendMessage: (messageId: string) => void }) => React.createElement(
        'button',
        {
            type: 'button',
            'data-testid': 'queued-message-send',
            onClick: () => onSendMessage('queued-chat-input'),
        },
        'send queued',
    ),
}));
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
    useComposerDraft: () => ({ persistNow: () => undefined, restoreDraft: () => undefined }),
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
    planLocalSlashCommand: (text: string, inputMode: string | undefined, hasAttachedContext: boolean) => {
        if (inputMode !== 'normal') return null;
        const match = /^\s*\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
        if (!match) return null;
        const name = match[1]?.toLowerCase() ?? '';
        if (name === 'btw' || name === 'summary') {
            return { command: { name, argument: match[2] ?? '' }, kind: 'prompt', attachedContext: hasAttachedContext ? 'send' : 'none' };
        }
        return null;
    },
    renderMagicPromptCommand: async () => {
        throw new Error('magic render failed');
    },
}));

import { createMessageQueueTarget, getMessageQueueKey, useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import { useInputStore } from '@/sync/input-store';

const createChatInputTarget = () => {
    const target = createMessageQueueTarget('session-chat-input', DIRECTORY, RUNTIME_KEY);
    if (!target) throw new Error('queue target derivation failed');
    return target;
};

const createServerQueueItem = (id: string, content: string) => ({
    id,
    createdAt: 1,
    content,
    text: content,
    attachments: [],
    context: [{ kind: 'synthetic' as const, text: 'queued server context' }],
    sendConfig: { providerID: 'provider-chat-input', modelID: 'model-chat-input' },
});

const createServerQueueSession = (items: ReturnType<typeof createServerQueueItem>[]) => ({
    sessionId: 'session-chat-input',
    directory: DIRECTORY,
    items,
    sendingId: null,
});

const seedServerQueue = () => {
    const target = createChatInputTarget();
    const queuedProjection = {
        id: 'queued-chat-input',
        content: 'queued server prompt',
        text: 'queued server prompt',
        createdAt: 1,
        sendConfig: { providerID: 'provider-chat-input', modelID: 'model-chat-input' },
    };
    useMessageQueueStore.getState().forgetQueue(target);
    useMessageQueueStore.setState({
        queuedMessages: { [getMessageQueueKey(target)]: [queuedProjection] },
        sendingIds: {},
    });
    return { target, queuedProjection, takenItem: createServerQueueItem(queuedProjection.id, queuedProjection.content) };
};

describe('ChatInput magic prompt failure', () => {
    let windowInstance: Window;
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        liveSessionStatus = 'idle';
        sendShouldFail = false;
        activeRuntimeKey = RUNTIME_KEY;
        sendMessageCalls = [];
        vscodeRuntime = true;
        runtimeFetchCalls = [];
        runtimeFetchHandler = () => new Response(null, { status: 404 });
        sessionUIState.sendMessage = async (...args: never[]) => {
            sendMessageCalls.push(args);
            if (sendShouldFail) throw new Error('send failed');
        };
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
            pendingLegacyMessages: {},
            pendingServerRestores: {},
            pendingServerTakes: {},
            pendingServerTakeAcks: {},
            pendingServerEnqueues: {},
            takenServerOperations: {},
            retryPendingIds: {},
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
        useInputStore.getState().setPendingInputText('/summary latency', 'replace');

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

    test('sends a local queued item once and keeps its context until the send resolves', async () => {
        const { ChatInput } = await import('./ChatInput');
        const target = createMessageQueueTarget('session-chat-input', DIRECTORY, RUNTIME_KEY);
        if (!target) throw new Error('queue target derivation failed');
        const queuedMessage = {
            id: 'queued-chat-input',
            content: 'queued local prompt',
            text: 'queued local prompt',
            createdAt: 1,
            context: [{ kind: 'synthetic' as const, text: 'queued local context' }],
            sendConfig: { providerID: 'provider-chat-input', modelID: 'model-chat-input' },
        };
        useMessageQueueStore.setState({
            queuedMessages: { [getMessageQueueKey(target)]: [queuedMessage] },
            sendingIds: {},
        });
        let resolveSend: (() => void) | undefined;
        const sendOutcome = new Promise<void>((resolve) => {
            resolveSend = resolve;
        });
        sessionUIState.sendMessage = async (...args: never[]) => {
            sendMessageCalls.push(args);
            await sendOutcome;
        };

        await act(async () => {
            root.render(React.createElement(ChatInput));
            await Promise.resolve();
        });
        const submit = host.querySelector<HTMLButtonElement>('[data-testid="queued-message-send"]');
        if (!submit) throw new Error('ChatInput queued-send harness did not render');

        await act(async () => {
            submit.click();
            submit.click();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(sendMessageCalls).toHaveLength(1);
        expect(sendMessageCalls[0]?.[0]).toBe('queued local prompt');
        expect(sendMessageCalls[0]?.[6]).toEqual([{ text: 'queued local context', synthetic: true }]);
        expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([queuedMessage]);
        expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([queuedMessage.id]);

        await act(async () => {
            resolveSend?.();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([]);
        expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([]);
    });

    test('keeps a local queued item retryable when queued Send fails', async () => {
        const { ChatInput } = await import('./ChatInput');
        const target = createMessageQueueTarget('session-chat-input', DIRECTORY, RUNTIME_KEY);
        if (!target) throw new Error('queue target derivation failed');
        const queuedMessage = {
            id: 'queued-chat-input',
            content: 'retryable local prompt',
            text: 'retryable local prompt',
            createdAt: 1,
            sendConfig: { providerID: 'provider-chat-input', modelID: 'model-chat-input' },
        };
        useMessageQueueStore.setState({
            queuedMessages: { [getMessageQueueKey(target)]: [queuedMessage] },
            sendingIds: {},
        });
        sendShouldFail = true;

        await act(async () => {
            root.render(React.createElement(ChatInput));
            await Promise.resolve();
        });
        const submit = host.querySelector<HTMLButtonElement>('[data-testid="queued-message-send"]');
        if (!submit) throw new Error('ChatInput queued-send harness did not render');

        await act(async () => {
            submit.click();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(sendMessageCalls).toHaveLength(1);
        expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([queuedMessage]);
        expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([]);
        expect(useMessageQueueStore.getState().getSendableQueue(target)).toEqual([queuedMessage]);
    });

    test('restores a taken queue item when the session becomes busy during preparation', async () => {
        const { ChatInput } = await import('./ChatInput');
        const target = createMessageQueueTarget('session-chat-input', DIRECTORY, RUNTIME_KEY);
        if (!target) throw new Error('queue target derivation failed');
        useMessageQueueStore.getState().addToQueue(target, {
            content: 'already queued',
            sendConfig: { providerID: 'provider-chat-input', modelID: 'model-chat-input' },
        });
        useInputStore.getState().setPendingInputText('new prompt', 'replace');

        await act(async () => {
            root.render(React.createElement(ChatInput));
            await Promise.resolve();
        });
        liveSessionStatus = 'busy';
        const submit = host.querySelector<HTMLButtonElement>('[data-testid="chat-submit"]');
        if (!submit) throw new Error('ChatInput submit harness did not render');

        await act(async () => {
            submit.click();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(useMessageQueueStore.getState().getQueueForTarget(target).map((message) => message.content)).toEqual([
            'already queued',
            'new prompt',
        ]);
    });

    test('restores a taken queue item when the send promise fails', async () => {
        const { ChatInput } = await import('./ChatInput');
        const target = createMessageQueueTarget('session-chat-input', DIRECTORY, RUNTIME_KEY);
        if (!target) throw new Error('queue target derivation failed');
        useMessageQueueStore.getState().addToQueue(target, {
            content: 'restore after failure',
            sendConfig: { providerID: 'provider-chat-input', modelID: 'model-chat-input' },
        });
        useInputStore.getState().setPendingInputText('send this', 'replace');
        sendShouldFail = true;

        await act(async () => {
            root.render(React.createElement(ChatInput));
            await Promise.resolve();
        });
        const submit = host.querySelector<HTMLButtonElement>('[data-testid="chat-submit"]');
        if (!submit) throw new Error('ChatInput submit harness did not render');

        await act(async () => {
            submit.click();
            await new Promise((resolve) => setTimeout(resolve, 0));
            await Promise.resolve();
        });

        expect(useMessageQueueStore.getState().getQueueForTarget(target).map((message) => message.content)).toEqual([
            'restore after failure',
        ]);
    });

    test('takes and acknowledges a server-owned queued chip exactly once', async () => {
        vscodeRuntime = false;
        const { target, takenItem } = seedServerQueue();
        runtimeFetchHandler = (path) => {
            if (path.endsWith(`/items/${takenItem.id}/take`)) {
                return new Response(JSON.stringify({
                    revision: 1,
                    session: createServerQueueSession([]),
                    item: takenItem,
                }));
            }
            if (path.includes('/take-receipts/')) return new Response(JSON.stringify({ acknowledged: true }));
            return new Response(null, { status: 404 });
        };
        const { ChatInput } = await import('./ChatInput');

        await act(async () => {
            root.render(React.createElement(ChatInput));
            await Promise.resolve();
        });
        const submit = host.querySelector<HTMLButtonElement>('[data-testid="queued-message-send"]');
        if (!submit) throw new Error('ChatInput queued-send harness did not render');

        await act(async () => {
            submit.click();
            submit.click();
            await new Promise((resolve) => setTimeout(resolve, 0));
            await Promise.resolve();
            await new Promise((resolve) => setTimeout(resolve, 0));
            await Promise.resolve();
        });

        expect(runtimeFetchCalls.filter((call) => call.path.endsWith(`/items/${takenItem.id}/take`))).toHaveLength(1);
        expect(sendMessageCalls).toHaveLength(1);
        expect(sendMessageCalls[0]?.[0]).toBe(takenItem.text);
        expect(sendMessageCalls[0]?.[6]).toEqual([{ text: 'queued server context', synthetic: true }]);
        expect(runtimeFetchCalls.filter((call) => call.path.includes('/take-receipts/'))).toHaveLength(1);
        expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([]);
        expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([]);
    });

    test('restores a server-taken queued item when preparation observes a busy session', async () => {
        vscodeRuntime = false;
        const { target, takenItem } = seedServerQueue();
        runtimeFetchHandler = (path) => {
            if (path.endsWith(`/items/${takenItem.id}/take`)) {
                liveSessionStatus = 'busy';
                return new Response(JSON.stringify({
                    revision: 1,
                    session: createServerQueueSession([]),
                    item: takenItem,
                }));
            }
            if (path.endsWith('/restore')) {
                return new Response(JSON.stringify({
                    revision: 2,
                    session: createServerQueueSession([takenItem]),
                }));
            }
            return new Response(null, { status: 404 });
        };
        const { ChatInput } = await import('./ChatInput');

        await act(async () => {
            root.render(React.createElement(ChatInput));
            await Promise.resolve();
        });
        const submit = host.querySelector<HTMLButtonElement>('[data-testid="queued-message-send"]');
        if (!submit) throw new Error('ChatInput queued-send harness did not render');

        await act(async () => {
            submit.click();
            await new Promise((resolve) => setTimeout(resolve, 0));
            await Promise.resolve();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(runtimeFetchCalls.filter((call) => call.path.endsWith(`/items/${takenItem.id}/take`))).toHaveLength(1);
        expect(runtimeFetchCalls.filter((call) => call.path.endsWith('/restore'))).toHaveLength(1);
        expect(runtimeFetchCalls.some((call) => call.path.includes('/take-receipts/'))).toBe(false);
        expect(sendMessageCalls).toHaveLength(0);
        expect(useMessageQueueStore.getState().getQueueForTarget(target).map((message) => message.content)).toEqual([
            takenItem.content,
        ]);
    });

    test('restores a server-taken queued item when the send promise fails', async () => {
        vscodeRuntime = false;
        const { target, takenItem } = seedServerQueue();
        sendShouldFail = true;
        runtimeFetchHandler = (path) => {
            if (path.endsWith(`/items/${takenItem.id}/take`)) {
                return new Response(JSON.stringify({
                    revision: 1,
                    session: createServerQueueSession([]),
                    item: takenItem,
                }));
            }
            if (path.endsWith('/restore')) {
                return new Response(JSON.stringify({
                    revision: 2,
                    session: createServerQueueSession([takenItem]),
                }));
            }
            return new Response(null, { status: 404 });
        };
        const { ChatInput } = await import('./ChatInput');

        await act(async () => {
            root.render(React.createElement(ChatInput));
            await Promise.resolve();
        });
        const submit = host.querySelector<HTMLButtonElement>('[data-testid="queued-message-send"]');
        if (!submit) throw new Error('ChatInput queued-send harness did not render');

        await act(async () => {
            submit.click();
            await new Promise((resolve) => setTimeout(resolve, 0));
            await Promise.resolve();
            await new Promise((resolve) => setTimeout(resolve, 0));
            await Promise.resolve();
        });

        expect(runtimeFetchCalls.filter((call) => call.path.endsWith(`/items/${takenItem.id}/take`))).toHaveLength(1);
        expect(sendMessageCalls).toHaveLength(1);
        expect(runtimeFetchCalls.filter((call) => call.path.endsWith('/restore'))).toHaveLength(1);
        expect(runtimeFetchCalls.some((call) => call.path.includes('/take-receipts/'))).toBe(false);
        expect(useMessageQueueStore.getState().getQueueForTarget(target).map((message) => message.content)).toEqual([
            takenItem.content,
        ]);
        expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([]);
    });

    test('persists a taken item across a runtime switch and retries it on the original runtime', async () => {
        vscodeRuntime = false;
        const { target, takenItem } = seedServerQueue();
        let serverItems = [takenItem];
        let restoreAttempts = 0;
        let takeAttempts = 0;
        let acknowledgementAttempts = 0;
        let hydrationAttempts = 0;
        runtimeFetchHandler = (path) => {
            if (path === '/api/message-queue') {
                hydrationAttempts += 1;
                return new Response(JSON.stringify({
                    revision: hydrationAttempts,
                    sessions: [{ ...createServerQueueSession(serverItems), generation: 3 }],
                    sessionLifecycles: {
                        [target.sessionId]: { directory: target.directory, generation: 3, restoreRequiresReceipt: true },
                    },
                }));
            }
            if (path.endsWith(`/items/${takenItem.id}/take`)) {
                takeAttempts += 1;
                serverItems = [];
                return new Response(JSON.stringify({
                    revision: 10 + takeAttempts,
                    session: { ...createServerQueueSession([]), generation: 3 },
                    generation: 3,
                    item: takenItem,
                }));
            }
            if (path.endsWith('/restore')) {
                restoreAttempts += 1;
                serverItems = [takenItem];
                return new Response(JSON.stringify({
                    revision: 20,
                    session: { ...createServerQueueSession(serverItems), generation: 3 },
                }));
            }
            if (path.includes('/take-receipts/')) {
                acknowledgementAttempts += 1;
                return new Response(JSON.stringify({ acknowledged: true }));
            }
            return new Response(null, { status: 404 });
        };
        sessionUIState.sendMessage = async (...args: never[]) => {
            sendMessageCalls.push(args);
            activeRuntimeKey = 'runtime-chat-input-other';
            vscodeRuntime = true;
            useMessageQueueStore.getState().resetForRuntimeSwitch(RUNTIME_KEY);
            throw new Error('send failed after runtime switch');
        };

        const { ChatInput } = await import('./ChatInput');
        await act(async () => {
            root.render(React.createElement(ChatInput));
            await Promise.resolve();
        });
        const submit = host.querySelector<HTMLButtonElement>('[data-testid="queued-message-send"]');
        if (!submit) throw new Error('ChatInput queued-send harness did not render');

        await act(async () => {
            submit.click();
            await new Promise((resolve) => setTimeout(resolve, 0));
            await Promise.resolve();
            await new Promise((resolve) => setTimeout(resolve, 0));
            await Promise.resolve();
        });

        const key = getMessageQueueKey(target);
        const pendingRestore = useMessageQueueStore.getState().pendingServerRestores[key];
        expect(sendMessageCalls).toHaveLength(1);
        expect(pendingRestore?.target).toEqual(target);
        expect(pendingRestore?.messages.map((message) => message.id)).toEqual([takenItem.id]);
        expect(pendingRestore?.mutationGeneration).toBe(3);
        expect(runtimeFetchCalls.some((call) => call.path.endsWith('/restore'))).toBe(false);
        expect(runtimeFetchCalls.some((call) => call.path.includes('/take-receipts/'))).toBe(false);

        activeRuntimeKey = RUNTIME_KEY;
        vscodeRuntime = false;
        useMessageQueueStore.getState().resetForRuntimeSwitch('runtime-chat-input-other');
        await act(async () => {
            await useMessageQueueStore.getState().hydrate();
        });

        expect(runtimeFetchCalls.filter((call) => call.path.endsWith('/restore')).map((call) => call.runtimeKey)).toEqual([RUNTIME_KEY]);
        expect(restoreAttempts).toBe(1);
        expect(useMessageQueueStore.getState().pendingServerRestores[key]).toBe(undefined);
        expect(useMessageQueueStore.getState().getQueueForTarget(target).map((message) => message.id)).toEqual([takenItem.id]);

        await act(async () => {
            await useMessageQueueStore.getState().hydrate();
        });
        expect(restoreAttempts).toBe(1);

        let retried: QueuedMessage | null = null;
        await act(async () => {
            const taken = await useMessageQueueStore.getState().takeForSend(target, takenItem.id);
            retried = taken[0] ?? null;
        });
        if (!retried) throw new Error('restored queued item could not be taken again');
        const retriedMessage = retried;
        await act(async () => {
            await useMessageQueueStore.getState().acknowledgeTakenServerBatch(target, [retriedMessage]);
        });

        expect(takeAttempts).toBe(2);
        expect(restoreAttempts).toBe(1);
        expect(acknowledgementAttempts).toBe(1);
    });
});

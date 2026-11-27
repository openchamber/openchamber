import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { useSpaceArchivesStore } from '@/lib/spaces/space-archives';
import { resetSpaceModelAccess } from '@/lib/spaces/space-model-offer';
import { resetSpaceCreationRequests } from '@/lib/spaces/space-creation-requests';
import { useGuestsStore } from '@/lib/guests/store';
import { useGuestOauthStore } from '@/lib/guests/oauth-store';
import { opencodeClient } from '@/lib/opencode/client';
import { subscribeRuntimeEndpointChanged, type RuntimeEndpointChangedDetail } from '@/lib/runtime-switch';
import { disposeTerminalInputTransport } from '@/lib/terminalApi';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { resetPrWatchesForRuntimeSwitch } from '@/sync/pr-watch';
import { resetExtensionWaitsForRuntimeSwitch } from '@/sync/extension-waits';
import { resetLaterPagesForRuntimeSwitch } from '@/sync/later-pages';
import { usePermissionStore } from '@/stores/permissionStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useGitStore } from '@/stores/useGitStore';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import { repositoryBindingOwner } from '@/lib/source-control/repository-binding';
import { useChangeRequestContextStore } from '@/stores/useChangeRequestContextStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { sessionEvents } from '@/lib/sessionEvents';
import { useTrackerRegistry } from '@/lib/trackers/registry';
import { useTrackerAuthStore } from '@/stores/useTrackerAuthStore';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useCommandsStore } from '@/stores/useCommandsStore';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { useAgentMemoryStore } from '@/stores/useAgentMemoryStore';
import { useWorkflowRunsStore } from '@/lib/workflows/store';
import { useUIStore } from '@/stores/useUIStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useWalkthroughStore } from '@/stores/useWalkthroughStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resetStreamingState } from '@/sync/streaming';
import { replaceGlobalSessionStatusById } from '@/sync/global-session-status';
import { resetGlobalBlockingRequests } from '@/sync/global-blocking-requests';
import { resetPendingSessionAssists } from '@/sync/pending-session-assists';
import { resetRecoverableQuestions } from '@/sync/recoverable-questions';
import { resetBackgroundShells } from '@/sync/background-shells';
import { resetBackgroundImages } from '@/sync/background-images';
import { resetSessionLiveWork } from '@/sync/session-live-work';
import { useMultiRunStore } from '@/stores/useMultiRunStore';
import { resetSessionOrdering } from '@/sync/session-ordering';
import { resetSessionActivityTiming } from '@/sync/session-activity-timing';
import { syncDesktopSettings } from '@/lib/persistence';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';

export const reconnectAppForTransportSwitch = (): void => {
  disposeTerminalInputTransport();
  opencodeClient.reconnectToRuntimeBaseUrl();
  resetStreamingState();
};

export const resetAppForRuntimeEndpointChange = (detail: RuntimeEndpointChangedDetail): void => {
  useSessionUIStore.getState().prepareForRuntimeSwitch(detail.previousRuntimeKey);
  useAutoReviewStore.getState().resetForRuntimeSwitch();
  resetPrWatchesForRuntimeSwitch();
  resetExtensionWaitsForRuntimeSwitch();
  resetLaterPagesForRuntimeSwitch();
  disposeTerminalInputTransport();
  useTerminalStore.getState().clearAll();
  opencodeClient.reconnectToRuntimeBaseUrl();
  useConfigStore.setState({
    providers: [],
    agents: [],
    isConnected: false,
    isInitialized: false,
    connectionPhase: 'connecting',
    lastDisconnectReason: null,
  });
  useProjectsStore.getState().resetForRuntimeSwitch();
  useProjectContextStore.getState().reset();
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  useSpacesStore.getState().resetForRuntimeSwitch();
  useSpaceArchivesStore.getState().resetForRuntimeSwitch();
  resetSpaceModelAccess();
  resetSpaceCreationRequests();
  useMultiRunStore.getState().resetForRuntimeSwitch();
  useSessionMultiSelectStore.getState().disable();
  useCommandsStore.getState().resetForRuntimeSwitch();
  useAgentsStore.getState().resetForRuntimeSwitch();
  replaceGlobalSessionStatusById(new Map());
  resetGlobalBlockingRequests();
  resetPendingSessionAssists();
  resetRecoverableQuestions();
  resetBackgroundShells();
  resetBackgroundImages();
  resetSessionLiveWork();
  resetSessionOrdering();
  resetSessionActivityTiming();
  usePermissionStore.getState().reset();
  useMessageQueueStore.getState().resetForRuntimeSwitch(detail.previousRuntimeKey);
  useFileSearchStore.getState().resetForRuntimeSwitch();
  useGitStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  sessionEvents.cancelPendingGitRefreshes();
  useGitIdentitiesStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  useSourceControlAuthStore.getState().resetForRuntimeSwitch();
  useSourceControlProviderRegistry.getState().resetForRuntimeSwitch(detail.runtimeKey);
  repositoryBindingOwner.reset();
  useChangeRequestContextStore.getState().resetForRuntimeSwitch();
  useGitHubPrStatusStore.getState().resetForRuntimeSwitch();
  useWalkthroughStore.getState().reset();
  useSessionFoldersStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  useFilesViewTabsStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  useGuestsStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  useGuestOauthStore.getState().resetForRuntimeSwitch();
  useTrackerAuthStore.getState().resetForRuntimeSwitch();
  useTrackerRegistry.getState().resetForRuntimeSwitch(detail.runtimeKey);
  useSourceControlAuthStore.getState().resetForRuntimeSwitch();
  useQuotaStore.getState().resetForRuntimeSwitch();
  useMcpStore.getState().resetForRuntimeSwitch();
  useSkillsStore.getState().resetForRuntimeSwitch();
  useAgentMemoryStore.getState().reset();
  useWorkflowRunsStore.getState().reset();
  useSessionUIStore.getState().restoreForRuntimeSwitch(detail.runtimeKey, detail.previousRuntimeKey);
  useSessionUIStore.setState({ worktreeDiscoveryByProject: new Map() });
  useUIStore.getState().setOpenGuestPage(null);
  useUIStore.setState({ customProviderLogos: {} });
  resetStreamingState();
  queueMicrotask(() => void syncDesktopSettings());
};

export const isSameRuntimeEndpoint = (detail: RuntimeEndpointChangedDetail): boolean => (
  detail.runtimeKey === detail.previousRuntimeKey && detail.apiBaseUrl === detail.previousApiBaseUrl
);

export const installRuntimeEndpointReset = (): (() => void) => (
  subscribeRuntimeEndpointChanged((detail) => {
    if (isSameRuntimeEndpoint(detail)) return;
    resetAppForRuntimeEndpointChange(detail);
  })
);

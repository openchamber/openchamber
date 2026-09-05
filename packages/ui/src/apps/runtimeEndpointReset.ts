import { opencodeClient } from '@/lib/opencode/client';
import type { RuntimeEndpointChangedDetail } from '@/lib/runtime-switch';
import { disposeTerminalInputTransport } from '@/lib/terminalApi';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useGitStore } from '@/stores/useGitStore';
import { useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useAgentMemoryStore } from '@/stores/useAgentMemoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resetStreamingState } from '@/sync/streaming';
import { replaceGlobalSessionStatusById } from '@/sync/global-session-status';
import { resetSessionOrdering } from '@/sync/session-ordering';
import { resetSessionActivityTiming } from '@/sync/session-activity-timing';
import { syncDesktopSettings } from '@/lib/persistence';

// Same-device transport switch (LAN⇄relay for one paired device): rebind the SDK
// to the new transport WITHOUT tearing down connection/session state or remounting
// the sync layer. `reconnectToRuntimeBaseUrl` swaps in a fresh SDK client; the
// caller then forces a re-render so SyncProvider receives it as a new `sdk` prop,
// which re-runs its event-pipeline + bootstrap effects (keyed on `sdk`) to
// reconnect over the new transport IN PLACE. Message-pagination refs, the open
// session, and the whole view are preserved — no reconnecting screen, no flash,
// no bounce back to the draft.
export const reconnectAppForTransportSwitch = (): void => {
  disposeTerminalInputTransport();
  opencodeClient.reconnectToRuntimeBaseUrl();
  resetStreamingState();
};

export const resetAppForRuntimeEndpointChange = (detail: RuntimeEndpointChangedDetail): void => {
  useSessionUIStore.getState().prepareForRuntimeSwitch(detail.previousRuntimeKey);
  if (detail.previousRuntimeKey) {
    useAutoReviewStore.getState().stopRunningRunsForRuntime(detail.previousRuntimeKey);
  }
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
  // Notes, todos, plans and the pinned-context bookkeeping are keyed by a
  // path-derived project id, which two runtimes can collide on.
  useProjectContextStore.getState().reset();
  // Cross-project session list (mobile sessions sheet & co) belongs to the
  // previous instance — drop it so stale sessions can't linger after a switch.
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  replaceGlobalSessionStatusById(new Map());
  resetSessionOrdering();
  // Turn timings belong to the previous instance's sessions, and the reset also
  // restarts the resume window so the switch is treated as a fresh load.
  resetSessionActivityTiming();
  usePermissionStore.getState().reset();
  useMessageQueueStore.getState().resetForRuntimeSwitch(detail.previousRuntimeKey);
  useFileSearchStore.getState().resetForRuntimeSwitch();
  useGitStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  useGitHubPrStatusStore.getState().resetForRuntimeSwitch();
  useSessionFoldersStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  useFilesViewTabsStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  // Linear and GitHub are authenticated on the instance, not in the browser.
  // Left in place, the previous instance's login stayed visible and usable —
  // its rail tab, its issue pickers, its work-status rows — against a runtime
  // that has no such integration. `App` re-asks once the new instance answers.
  useLinearAuthStore.getState().resetForRuntimeSwitch();
  useGitHubAuthStore.getState().resetForRuntimeSwitch();
  // Work-status readouts served from the instance: quotas, MCP servers, skills
  // and agent memory. All were cached globally or by directory alone, so they
  // reported the previous instance until something happened to refetch.
  useQuotaStore.getState().resetForRuntimeSwitch();
  useMcpStore.getState().resetForRuntimeSwitch();
  useSkillsStore.getState().resetForRuntimeSwitch();
  useAgentMemoryStore.getState().reset();
  // The Linear team filter names a team in one workspace. Carried across, it
  // filters the new instance's issue list down to nothing.
  useUIStore.getState().applyLinearIssueListFiltersForRuntime();
  useSessionUIStore.getState().restoreForRuntimeSwitch(detail.runtimeKey);
  resetStreamingState();
  queueMicrotask(() => void syncDesktopSettings());
};

import { opencodeClient } from '@/lib/opencode/client';
import type { RuntimeEndpointChangedDetail } from '@/lib/runtime-switch';
import { disposeTerminalInputTransport } from '@/lib/terminalApi';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useUIStore } from '@/stores/useUIStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resetStreamingState } from '@/sync/streaming';

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
  useUIStore.getState().prepareForRuntimeSwitch(detail.previousRuntimeKey);
  if (detail.previousRuntimeKey) {
    useAutoReviewStore.getState().stopRunningRunsForRuntime(detail.previousRuntimeKey);
  }
  disposeTerminalInputTransport();
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
  // Cross-project session list (mobile sessions sheet & co) belongs to the
  // previous instance — drop it so stale sessions can't linger after a switch.
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  usePermissionStore.getState().reset();
  useSessionUIStore.getState().restoreForRuntimeSwitch(detail.runtimeKey);
  useUIStore.getState().restoreForRuntimeSwitch(detail.runtimeKey);
  resetStreamingState();
};

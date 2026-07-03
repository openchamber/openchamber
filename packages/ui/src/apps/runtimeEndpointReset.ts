import { opencodeClient } from '@/lib/opencode/client';
import type { RuntimeEndpointChangedDetail } from '@/lib/runtime-switch';
import { disposeTerminalInputTransport } from '@/lib/terminalApi';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resetStreamingState } from '@/sync/streaming';

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
  useSessionUIStore.getState().restoreForRuntimeSwitch(detail.runtimeKey);
  useUIStore.getState().restoreForRuntimeSwitch(detail.runtimeKey);
  resetStreamingState();
};

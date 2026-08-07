import { create } from 'zustand';
import {
  BrowserSocket,
  fetchBrowserArtifacts,
  fetchBrowserState,
  runBrowserAction,
  type BrowserAction,
  type BrowserArtifact,
  type BrowserCursor,
  type BrowserRecording,
  type BrowserSocketMessage,
  type BrowserState,
  type BrowserTab,
} from '@/lib/browser/agentBrowserApi';

type BrowserConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed';

type AgentBrowserStoreState = {
  supported: boolean;
  running: boolean;
  hydrated: boolean;
  activeTabId: string | null;
  tabs: BrowserTab[];
  recording: BrowserRecording;
  artifacts: BrowserArtifact[];
  connection: BrowserConnectionStatus;
  /** JPEG data URL of the latest screencast frame for the watched tab. */
  frameByTab: Record<string, string>;
  cursorByTab: Record<string, BrowserCursor>;
  error: string | null;
  mountCount: number;
};

type AgentBrowserStoreActions = {
  mount: () => void;
  unmount: () => void;
  watch: (tabId: string | null) => void;
  run: <T = unknown>(action: BrowserAction, params?: Record<string, unknown>) => Promise<T>;
  refreshArtifacts: () => Promise<void>;
  setError: (message: string | null) => void;
};

let socket: BrowserSocket | null = null;

const applyState = (set: (partial: Partial<AgentBrowserStoreState>) => void, state: BrowserState) => {
  set({
    supported: state.supported,
    running: state.running,
    activeTabId: state.activeTabId,
    tabs: state.tabs,
    recording: state.recording,
    hydrated: true,
  });
};

export const useAgentBrowserStore = create<AgentBrowserStoreState & AgentBrowserStoreActions>((set, get) => ({
  supported: true,
  running: false,
  hydrated: false,
  activeTabId: null,
  tabs: [],
  recording: null,
  artifacts: [],
  connection: 'idle',
  frameByTab: {},
  cursorByTab: {},
  error: null,
  mountCount: 0,

  mount: () => {
    const next = get().mountCount + 1;
    set({ mountCount: next });
    if (next > 1) return;
    void fetchBrowserState().then((state) => applyState(set, state)).catch(() => {});
    void get().refreshArtifacts();
    socket = new BrowserSocket();
    socket.connect({
      onStatus: (status) => set({ connection: status }),
      onMessage: (message: BrowserSocketMessage) => {
        switch (message.t) {
          case 'snapshot':
          case 'state': {
            if (message.state) applyState(set, message.state as BrowserState);
            break;
          }
          case 'tab': {
            const tab = message.tab as BrowserTab | undefined;
            if (!tab) break;
            set({ tabs: get().tabs.map((entry) => (entry.id === tab.id ? tab : entry)) });
            break;
          }
          case 'cursor': {
            const tabId = typeof message.tabId === 'string' ? message.tabId : null;
            const cursor = message.cursor as BrowserCursor | undefined;
            if (!tabId || !cursor) break;
            set({ cursorByTab: { ...get().cursorByTab, [tabId]: cursor } });
            break;
          }
          case 'frame': {
            const tabId = typeof message.tabId === 'string' ? message.tabId : null;
            const data = typeof message.data === 'string' ? message.data : null;
            if (!tabId || !data) break;
            set({ frameByTab: { ...get().frameByTab, [tabId]: `data:image/jpeg;base64,${data}` } });
            break;
          }
          case 'recording': {
            set({ recording: (message.recording as BrowserRecording) ?? null });
            break;
          }
          case 'artifact': {
            const artifact = message.artifact as BrowserArtifact | undefined;
            if (!artifact) break;
            set({ artifacts: [artifact, ...get().artifacts.filter((entry) => entry.id !== artifact.id)] });
            break;
          }
          case 'error': {
            if (typeof message.message === 'string') set({ error: message.message });
            break;
          }
          default:
            break;
        }
      },
    });
  },

  unmount: () => {
    const next = Math.max(0, get().mountCount - 1);
    set({ mountCount: next });
    if (next > 0) return;
    socket?.dispose();
    socket = null;
    set({ connection: 'idle' });
  },

  watch: (tabId) => {
    socket?.watch(tabId);
  },

  run: async (action, params = {}) => {
    try {
      const result = await runBrowserAction(action, params);
      set({ error: null });
      return result as never;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  refreshArtifacts: async () => {
    try {
      const artifacts = await fetchBrowserArtifacts();
      set({ artifacts });
    } catch {
      // artifact listing is best-effort; the surface still works without it
    }
  },

  setError: (message) => set({ error: message }),
}));

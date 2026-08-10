import { create } from 'zustand';
import {
  BrowserSocket,
  fetchBrowserArtifacts,
  fetchBrowserState,
  runBrowserAction,
  takeoverBrowser,
  type BrowserAction,
  type BrowserArtifact,
  type BrowserControl,
  type BrowserCursor,
  type BrowserRecording,
  type BrowserSocketMessage,
  type BrowserState,
  type BrowserTab,
} from '@/lib/browser/agentBrowserApi';

type BrowserConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed';

const EMPTY_CONTROL: BrowserControl = { actor: null, sessionId: null, claimedAt: null };

type AgentBrowserStoreState = {
  supported: boolean;
  running: boolean;
  hydrated: boolean;
  activeTabId: string | null;
  tabs: BrowserTab[];
  recording: BrowserRecording;
  control: BrowserControl;
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
  run: <T = unknown>(
    action: BrowserAction,
    params?: Record<string, unknown>,
    options?: { takeover?: boolean },
  ) => Promise<T>;
  takeover: () => Promise<BrowserControl>;
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
    control: state.control ?? EMPTY_CONTROL,
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
  control: EMPTY_CONTROL,
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

  run: async (action, params = {}, options = {}) => {
    try {
      const result = await runBrowserAction(action, params, options);
      set({ error: null });
      return result as never;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  takeover: async () => {
    const result = await takeoverBrowser();
    set({ control: result.control, error: null });
    return result.control;
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

import { create } from 'zustand';

export const MESSENGER_UI_EVENTS_WS_PATH = '/api/messenger/ws';

export const MESSENGER_UI_EVENTS_BUFFER_LIMIT = 100;

export type OpenChamberAgentWsConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export type OpenChamberAgentUiRealtimeEvent = {
  eventId: string;
  eventType: string;
  data: unknown;
  timestamp: number;
};

const eventListeners = new Set<(event: OpenChamberAgentUiRealtimeEvent) => void>();

const notifyRealtimeListeners = (event: OpenChamberAgentUiRealtimeEvent) => {
  for (const listener of Array.from(eventListeners)) {
    try {
      listener(event);
    } catch {
      void 0;
    }
  }
};

type OpenChamberAgentEventsState = {
  connectionStatus: OpenChamberAgentWsConnectionStatus;
  lastDisconnectReason: string | null;
  lastEventId: string | null;
  patterns: string[];
  events: OpenChamberAgentUiRealtimeEvent[];
  setConnectionStatus: (status: OpenChamberAgentWsConnectionStatus, hint?: string | null) => void;
  setPatterns: (patterns: string[]) => void;
  ingestServerEvent: (event: OpenChamberAgentUiRealtimeEvent) => void;
  resetLocalEvents: () => void;
  subscribeToEvents: (listener: (event: OpenChamberAgentUiRealtimeEvent) => void) => () => void;
};

export const useOpenChamberAgentEventsStore = create<OpenChamberAgentEventsState>((set) => ({
  connectionStatus: 'idle',
  lastDisconnectReason: null,
  lastEventId: null,
  patterns: ['*'],
  events: [],
  setConnectionStatus: (status, hint) => {
    set((state) => {
      if (hint !== undefined && hint !== null) {
        return {
          connectionStatus: status,
          lastDisconnectReason: hint,
        };
      }

      if (status === 'open' || status === 'connecting') {
        return {
          connectionStatus: status,
          lastDisconnectReason: null,
        };
      }

      return {
        connectionStatus: status,
        lastDisconnectReason: state.lastDisconnectReason,
      };
    });
  },
  setPatterns: (patterns) =>
    set({
      patterns: patterns.length === 0 ? ['*'] : patterns,
    }),
  ingestServerEvent: (event) => {
    notifyRealtimeListeners(event);

    set((state) => {
      const events = [...state.events, event];
      if (events.length > MESSENGER_UI_EVENTS_BUFFER_LIMIT) {
        events.splice(0, events.length - MESSENGER_UI_EVENTS_BUFFER_LIMIT);
      }

      return {
        events,
        lastEventId: event.eventId,
      };
    });
  },
  resetLocalEvents: () => set({ events: [], lastEventId: null }),
  subscribeToEvents: (listener) => {
    eventListeners.add(listener);

    return () => {
      eventListeners.delete(listener);
    };
  },
}));

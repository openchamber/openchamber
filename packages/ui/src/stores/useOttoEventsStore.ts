import { create } from 'zustand';

export const OTTO_UI_EVENTS_WS_PATH = '/ws/otto/events';

export const OTTO_UI_EVENTS_BUFFER_LIMIT = 100;

export type OttoWsConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export type OttoUiRealtimeEvent = {
  eventId: string;
  eventType: string;
  data: unknown;
  timestamp: number;
};

const eventListeners = new Set<(event: OttoUiRealtimeEvent) => void>();

const notifyRealtimeListeners = (event: OttoUiRealtimeEvent) => {
  for (const listener of Array.from(eventListeners)) {
    try {
      listener(event);
    } catch {
      void 0;
    }
  }
};

type OttoEventsState = {
  connectionStatus: OttoWsConnectionStatus;
  lastDisconnectReason: string | null;
  lastEventId: string | null;
  patterns: string[];
  events: OttoUiRealtimeEvent[];
  setConnectionStatus: (status: OttoWsConnectionStatus, hint?: string | null) => void;
  setPatterns: (patterns: string[]) => void;
  ingestServerEvent: (event: OttoUiRealtimeEvent) => void;
  resetLocalEvents: () => void;
  subscribeToEvents: (listener: (event: OttoUiRealtimeEvent) => void) => () => void;
};

export const useOttoEventsStore = create<OttoEventsState>((set) => ({
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
      if (events.length > OTTO_UI_EVENTS_BUFFER_LIMIT) {
        events.splice(0, events.length - OTTO_UI_EVENTS_BUFFER_LIMIT);
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

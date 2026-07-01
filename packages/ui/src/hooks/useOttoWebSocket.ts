import { useEffect, useRef } from 'react';

import {
  OTTO_UI_EVENTS_WS_PATH,
  type OttoUiRealtimeEvent,
  useOttoEventsStore,
} from '@/stores/useOttoEventsStore';

export type UseOttoWebSocketOptions = {
  enabled?: boolean;
};

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

function buildWsUrl(lastEventId: string | null) {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const pathname = OTTO_UI_EVENTS_WS_PATH;
  const base = `${protocol}://${window.location.host}${pathname}`;

  if (!lastEventId) {
    return base;
  }

  const url = new URL(base, window.location.origin);

  url.searchParams.set('lastEventId', lastEventId);

  return `${pathname}${url.search}`;
}

function safeParseMessage(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

export function useOttoWebSocket({ enabled = true }: UseOttoWebSocketOptions = {}) {
  const patternsKey = useOttoEventsStore((state) => state.patterns.join('|'));
  const patterns = useOttoEventsStore((state) => state.patterns);
  const ingestServerEvent = useOttoEventsStore((state) => state.ingestServerEvent);
  const setConnectionStatus = useOttoEventsStore((state) => state.setConnectionStatus);

  const backoffMsRef = useRef(MIN_BACKOFF_MS);
  const reconnectTimerRef = useRef<number | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const intentionalCloseRef = useRef(false);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      return undefined;
    }

    intentionalCloseRef.current = false;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current === null) {
        return;
      }

      window.clearTimeout(reconnectTimerRef.current);

      reconnectTimerRef.current = null;
    };

    const scheduleReconnect = () => {
      if (intentionalCloseRef.current) {
        return;
      }

      clearReconnectTimer();

      const delay = backoffMsRef.current;

      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);

      backoffMsRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
    };

    const connect = () => {
      if (!enabled || intentionalCloseRef.current) {
        return;
      }

      socketRef.current?.close();

      const resumeAfterId = useOttoEventsStore.getState().lastEventId;

      const socketUrl = buildWsUrl(resumeAfterId);

      setConnectionStatus('connecting');

      const socket = new WebSocket(socketUrl);

      socketRef.current = socket;

      socket.addEventListener('open', () => {
        backoffMsRef.current = MIN_BACKOFF_MS;
        setConnectionStatus('open');

        const subscribePatterns = useOttoEventsStore.getState().patterns;

        socket.send(
          JSON.stringify({
            type: 'subscribe',
            patterns: subscribePatterns,
          }),
        );
      });

      socket.addEventListener('message', (event) => {
        const parsed = safeParseMessage(String(event.data));

        if (!isRecord(parsed)) {
          return;
        }

        if (parsed.type !== 'event') {
          return;
        }

        const eventIdField = Reflect.get(parsed, 'eventId');
        const eventTypeField = Reflect.get(parsed, 'eventType');
        const timestampField = Reflect.get(parsed, 'timestamp');

        if (
          typeof eventIdField !== 'string' ||
          typeof eventTypeField !== 'string' ||
          typeof timestampField !== 'number'
        ) {
          return;
        }

        const realtimeEvent: OttoUiRealtimeEvent = {
          eventId: eventIdField,
          eventType: eventTypeField,
          timestamp: timestampField,
          data: Reflect.get(parsed, 'data'),
        };

        ingestServerEvent(realtimeEvent);
      });

      socket.addEventListener('error', () => {
        setConnectionStatus('error', 'WebSocket transport error');
      });

      socket.addEventListener('close', (evt) => {
        socketRef.current = null;

        if (intentionalCloseRef.current) {
          setConnectionStatus('closed');
          return;
        }

        const reason =
          typeof evt.reason === 'string' && evt.reason.trim().length > 0
            ? evt.reason
            : `Socket closed (${evt.code})`;

        setConnectionStatus('closed', reason);
        scheduleReconnect();
      });
    };

    connect();

    return () => {
      intentionalCloseRef.current = true;
      clearReconnectTimer();

      socketRef.current?.close(1000, 'client teardown');

      socketRef.current = null;
      setConnectionStatus('closed');
    };
  }, [enabled, ingestServerEvent, setConnectionStatus]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      return;
    }

    const socket = socketRef.current;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          patterns,
        }),
      );
    } catch {
      setConnectionStatus('error', 'Failed to subscribe to Otto events stream');
    }
  }, [enabled, patternsKey, patterns, setConnectionStatus]);
}

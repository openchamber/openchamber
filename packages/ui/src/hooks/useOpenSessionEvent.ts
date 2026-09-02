import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';

type OpenSessionRequest = {
  sessionId: string;
  directory: string | null;
};

const parseOpenSessionRequest = (event: Event): OpenSessionRequest | null => {
  if (!(event instanceof CustomEvent)) return null;
  const detail = event.detail;
  if (detail == null || Array.isArray(detail) || Object(detail) !== detail) return null;

  const sessionRaw = Object.getOwnPropertyDescriptor(detail, 'sessionId')?.value;
  const sessionText = String(sessionRaw);
  if (sessionRaw !== sessionText) return null;
  const sessionId = sessionText.trim();
  if (!sessionId) return null;

  const directoryRaw = Object.getOwnPropertyDescriptor(detail, 'directory')?.value;
  const directoryText = String(directoryRaw);
  const directory = directoryRaw === directoryText && directoryText.trim().length > 0
    ? directoryText.trim()
    : null;

  return { sessionId, directory };
};

export const useOpenSessionEvent = (): void => {
  React.useEffect(() => {
    const handler = (event: Event) => {
      const request = parseOpenSessionRequest(event);
      if (!request) return;
      void useSessionUIStore.getState().setCurrentSession(request.sessionId, request.directory);
    };

    window.addEventListener('openchamber:open-session', handler);
    return () => window.removeEventListener('openchamber:open-session', handler);
  }, []);
};

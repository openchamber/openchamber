import React from 'react';

import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { fetchSharePageGroup, isSharingTurnedOff, SharePageRequestError, type SharePageGroup } from '@/lib/share-pages/api';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';

export type SharePageGroupState = {
  group: SharePageGroup | null;
  error: string | null;
  missing: boolean;
  turnedOff: boolean;
};

const INITIAL: SharePageGroupState = { group: null, error: null, missing: false, turnedOff: false };

export const failedReadState = (current: SharePageGroupState, error: Error): SharePageGroupState => {
  if (isSharingTurnedOff(error)) return { group: null, error: null, missing: false, turnedOff: true };
  const missing = error instanceof SharePageRequestError && error.status === 404;
  return { group: missing ? null : current.group, error: error.message, missing, turnedOff: false };
};

export function useSharePageGroup(sessionId: string, callId: string, enabled = true) {
  const [state, setState] = React.useState<SharePageGroupState>(INITIAL);
  const sequence = React.useRef(0);

  const reload = React.useCallback(async () => {
    const request = ++sequence.current;
    try {
      const group = await fetchSharePageGroup(sessionId, callId);
      if (request !== sequence.current) return;
      setState({ group, error: null, missing: false, turnedOff: false });
    } catch (error) {
      if (request !== sequence.current) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      setState((current) => failedReadState(current, failure));
    }
  }, [callId, sessionId]);

  const accept = React.useCallback((group: SharePageGroup) => {
    sequence.current += 1;
    setState({ group, error: null, missing: false, turnedOff: false });
  }, []);

  const turnOff = React.useCallback(() => {
    sequence.current += 1;
    setState({ group: null, error: null, missing: false, turnedOff: true });
  }, []);

  const enterpriseMode = useEnterpriseMode();

  React.useEffect(() => {
    if (!enabled) return;
    void reload();
    let connected = false;
    return subscribeOpenchamberEvents((event) => {
      if (event.type === 'event-stream-ready') {
        if (connected) void reload();
        connected = true;
      }
      if (event.type === 'share-page-changed' && event.sessionId === sessionId && event.callId === callId) void reload();
    });
  }, [callId, enabled, enterpriseMode, reload, sessionId]);

  return { ...state, reload, accept, turnOff };
}

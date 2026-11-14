import React from 'react';

import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { fetchSharePageGroup, isSharingTurnedOff, SharePageRequestError, type SharePageGroup } from '@/lib/share-pages/api';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';

export type SharePageGroupState = {
  group: SharePageGroup | null;
  /** The last read failed; a group read before it stays shown. */
  error: string | null;
  /** The server has no group for this call (404). */
  missing: boolean;
  /** Enterprise mode allows no relay: the server refuses every share route, and the card shows no sharing. */
  turnedOff: boolean;
};

const INITIAL: SharePageGroupState = { group: null, error: null, missing: false, turnedOff: false };

/** What a failed read leaves: a refusal by policy or a missing group drops the group; any other failure keeps it. */
export const failedReadState = (current: SharePageGroupState, error: Error): SharePageGroupState => {
  if (isSharingTurnedOff(error)) return { group: null, error: null, missing: false, turnedOff: true };
  const missing = error instanceof SharePageRequestError && error.status === 404;
  return { group: missing ? null : current.group, error: error.message, missing, turnedOff: false };
};

/**
 * The server's state of one share call, read when the card mounts, again on
 * every `openchamber:share-page` event for this call, and after the event
 * stream reconnects (a change may have landed in the gap). Only the newest
 * read lands, and a failed read never blanks a group already shown.
 */
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

  /** Shows a group a request answered with, newer than any read on its way. */
  const accept = React.useCallback((group: SharePageGroup) => {
    sequence.current += 1;
    setState({ group, error: null, missing: false, turnedOff: false });
  }, []);

  /** An action the server refused by policy: the card stops showing sharing at once. */
  const turnOff = React.useCallback(() => {
    sequence.current += 1;
    setState({ group: null, error: null, missing: false, turnedOff: true });
  }, []);

  // The policy store cannot tell whether a pinned relay keeps sharing on, so a
  // policy change only makes the card ask the server again; its answer decides.
  const enterpriseMode = useEnterpriseMode();

  React.useEffect(() => {
    if (!enabled) return;
    void reload();
    // The stream's first ready (replayed to a new listener) is the connection
    // the read above already covers; a later one is a reconnect.
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

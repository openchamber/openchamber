import React from 'react';

import { isVSCodeRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { fetchReceivedPage, fetchReceivedPagesConfig, type ReceivedPage } from '@/lib/received-pages/api';
import { isSharingTurnedOff, SharePageRequestError } from '@/lib/share-pages/api';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';

export type ReceivedPageState = {
  page: ReceivedPage | null;
  /** The last read failed; a page read before it stays shown. */
  error: string | null;
  /** The server no longer keeps this page (404). */
  missing: boolean;
  /** Enterprise mode allows no relay: the server refuses, and nothing about the page shows. */
  turnedOff: boolean;
};

const INITIAL: ReceivedPageState = { page: null, error: null, missing: false, turnedOff: false };

const failedReceivedReadState = (current: ReceivedPageState, error: Error): ReceivedPageState => {
  if (isSharingTurnedOff(error)) return { page: null, error: null, missing: false, turnedOff: true };
  const missing = error instanceof SharePageRequestError && error.status === 404;
  return { page: missing ? null : current.page, error: error.message, missing, turnedOff: false };
};

/**
 * One received page as the server keeps it, read on mount, on every
 * `received-page-changed` event for it (an answer sent from another window
 * or device) and after the event stream reconnects. Only the newest read
 * lands; a failed read never blanks a page already shown.
 */
export function useReceivedPage(receivedId: string | null) {
  const [state, setState] = React.useState<ReceivedPageState>(INITIAL);
  const sequence = React.useRef(0);
  const enterpriseMode = useEnterpriseMode();

  const reload = React.useCallback(async () => {
    if (!receivedId) return;
    const request = ++sequence.current;
    try {
      const page = await fetchReceivedPage(receivedId);
      if (request === sequence.current) setState({ page, error: null, missing: false, turnedOff: false });
    } catch (error) {
      if (request !== sequence.current) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      setState((current) => failedReceivedReadState(current, failure));
    }
  }, [receivedId]);

  /** Shows a page a request answered with, newer than any read on its way. */
  const accept = React.useCallback((page: ReceivedPage) => {
    sequence.current += 1;
    setState({ page, error: null, missing: false, turnedOff: false });
  }, []);

  const fail = React.useCallback((error: Error) => {
    sequence.current += 1;
    setState((current) => failedReceivedReadState(current, error));
  }, []);

  React.useEffect(() => {
    if (!receivedId || isVSCodeRuntime()) return;
    void reload();
    let connected = false;
    return subscribeOpenchamberEvents((event) => {
      if (event.type === 'event-stream-ready') {
        if (connected) void reload();
        connected = true;
      }
      if (event.type === 'received-page-changed' && event.receivedId === receivedId) void reload();
    });
  }, [enterpriseMode, receivedId, reload]);

  return { ...state, reload, accept, fail };
}

let configRequest: { key: string; promise: Promise<readonly string[]> } | null = null;

/**
 * The relays whose links the composer turns into a page chip, as the server
 * reports them: none in VS Code (no OpenChamber server keeps the link) or in
 * enterprise mode without a relay, and none while the read fails, so a link
 * then stays plain text. Read once per server and policy state.
 */
export function useReceivedPageBases(): readonly string[] {
  const enterpriseMode = useEnterpriseMode();
  const [bases, setBases] = React.useState<readonly string[]>([]);
  React.useEffect(() => {
    if (isVSCodeRuntime()) return;
    // Another server, or another policy, may open other relays.
    const key = `${getRuntimeKey()}\n${enterpriseMode}`;
    if (configRequest?.key !== key) {
      const promise = fetchReceivedPagesConfig().then((config) => (config.available ? config.bases : []));
      configRequest = { key, promise };
      promise.catch(() => { if (configRequest?.promise === promise) configRequest = null; });
    }
    let live = true;
    configRequest.promise.then((next) => { if (live) setBases(next); }, () => { if (live) setBases([]); });
    return () => { live = false; };
  }, [enterpriseMode]);
  return bases;
}

import React from 'react';

import { isVSCodeRuntime } from '@/lib/desktop';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { fetchReceivedPage, fetchReceivedPagesConfig, type ReceivedPage } from '@/lib/received-pages/api';
import { isSharingTurnedOff, SharePageRequestError } from '@/lib/share-pages/api';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';

export type ReceivedPageState = {
  page: ReceivedPage | null;
  error: string | null;
  missing: boolean;
  turnedOff: boolean;
};

const INITIAL: ReceivedPageState = { page: null, error: null, missing: false, turnedOff: false };

const failedReceivedReadState = (current: ReceivedPageState, error: Error): ReceivedPageState => {
  if (isSharingTurnedOff(error)) return { page: null, error: null, missing: false, turnedOff: true };
  const missing = error instanceof SharePageRequestError && error.status === 404;
  return { page: missing ? null : current.page, error: error.message, missing, turnedOff: false };
};

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

export function useReceivedPageBases(): readonly string[] {
  const enterpriseMode = useEnterpriseMode();
  const [bases, setBases] = React.useState<readonly string[]>([]);
  React.useEffect(() => {
    if (isVSCodeRuntime()) return;
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

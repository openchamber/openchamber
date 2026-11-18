import React from 'react';

import { navStatusUrl, type BrowserNavStatus } from '@/lib/browser/contract';
import { planErrorAnswerRetry, planFailedLoadRetry, type DevServerWaitRun } from '@/lib/browser/devServerWait';
import { probeLoopbackStatus } from '@/lib/browser/devServers';
import { toDisplayUrl } from '@/lib/browser/devTunnel';
import { isLoopbackUrl } from '@/lib/browser/url';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { isProjectActionRunningAtOrigin, useTerminalStore } from '@/stores/useTerminalStore';

const GATEWAY_RETRY_DELAY_MS = 600;
const GATEWAY_WAIT_MS = 20_000;

const subscribeDocumentVisibility = (onChange: () => void): (() => void) => {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
};
const isDocumentVisible = (): boolean => document.visibilityState === 'visible';

type DevServerWait = {
  readonly isWaitingForServer: boolean;
  readonly rearm: () => void;
};

export const useDevServerWait = ({
  status,
  directory,
  visible,
  watchedOutOfSight,
  restoredLoadRef,
  reload,
}: {
  status: BrowserNavStatus;
  directory: string;
  visible: boolean;
  watchedOutOfSight: boolean;
  restoredLoadRef: React.MutableRefObject<boolean>;
  reload: () => void;
}): DevServerWait => {
  const [isWaitingForServer, setIsWaitingForServer] = React.useState(false);
  const retryRef = React.useRef<DevServerWaitRun | null>(null);
  const restoredSettleRef = React.useRef<BrowserNavStatus | null>(null);
  const servedOkRef = React.useRef(false);
  const openedAtRef = React.useRef(Date.now());
  const reloadRef = React.useRef(reload);
  reloadRef.current = reload;

  const documentVisible = React.useSyncExternalStore(subscribeDocumentVisibility, isDocumentVisible);
  const watched = (visible && documentVisible) || watchedOutOfSight;
  const statusUrl = toDisplayUrl(navStatusUrl(status));
  const actionRunning = useTerminalStore((state) => isProjectActionRunningAtOrigin(state.sessions, statusUrl));
  const actionWasRunningRef = React.useRef(false);
  const actionStoppedAtRef = React.useRef<number | null>(null);

  const rearm = React.useCallback(() => {
    servedOkRef.current = false;
    retryRef.current = null;
    openedAtRef.current = Date.now();
  }, []);

  React.useEffect(() => {
    const reloadSoon = (delayMs: number): (() => void) => {
      setIsWaitingForServer(true);
      const timer = setTimeout(() => reloadRef.current(), delayMs);
      return () => clearTimeout(timer);
    };

    if (actionWasRunningRef.current && !actionRunning) actionStoppedAtRef.current = Date.now();
    actionWasRunningRef.current = actionRunning;

    if (status.kind === 'loading') return;

    const restored = restoredLoadRef.current || restoredSettleRef.current === status;
    if (restoredLoadRef.current && (status.kind === 'failed' || (status.kind === 'ready' && status.url))) {
      restoredLoadRef.current = false;
      restoredSettleRef.current = status;
    }

    const context = {
      run: retryRef.current,
      restored,
      watched,
      now: Date.now(),
      actionRunning,
      actionStoppedAt: actionStoppedAtRef.current,
    };

    if (status.kind === 'failed') {
      const plan = planFailedLoadRetry(status, context);
      retryRef.current = plan.run;
      if (plan.next === 'retry') return reloadSoon(plan.delayMs);
      setIsWaitingForServer(plan.next === 'pause');
      return;
    }

    const answerPlan = status.kind === 'ready' && !servedOkRef.current ? planErrorAnswerRetry(status, context) : null;
    if (answerPlan && answerPlan.next !== 'stop') {
      retryRef.current = answerPlan.run;
      if (answerPlan.next === 'retry') return reloadSoon(answerPlan.delayMs);
      setIsWaitingForServer(true);
      return;
    }

    retryRef.current = null;

    if (status.kind !== 'ready' || !status.url || !isLoopbackUrl(status.url)) {
      servedOkRef.current = true;
      setIsWaitingForServer(false);
      return;
    }
    if (restored || servedOkRef.current || Date.now() - openedAtRef.current > GATEWAY_WAIT_MS) {
      servedOkRef.current = true;
      setIsWaitingForServer(false);
      return;
    }

    let cancelled = false;
    let cancelReload: (() => void) | null = null;
    const probe = spaceIdOfDirectory(directory) ? Promise.resolve(null) : probeLoopbackStatus(toDisplayUrl(status.url));
    void probe.then((httpStatus) => {
      if (cancelled) return;
      if (httpStatus === null || httpStatus < 500) {
        servedOkRef.current = true;
        setIsWaitingForServer(false);
        return;
      }
      cancelReload = reloadSoon(GATEWAY_RETRY_DELAY_MS);
    });
    return () => {
      cancelled = true;
      cancelReload?.();
    };
  }, [actionRunning, directory, restoredLoadRef, status, watched]);

  return { isWaitingForServer, rearm };
};

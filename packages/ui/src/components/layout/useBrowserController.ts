import React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { createBrowserExecutor, type BrowserExecutorCallbacks } from '@/lib/browser/executor';
import type { BrowserBackend, BrowserControllerHandle } from '@/lib/api/types';

interface UseBrowserControllerParams {
  /** Register only while a real pane is mounted and sharing is on. */
  enabled: boolean;
  backend: BrowserBackend;
  controllerId: string;
  url: string;
  title?: string;
  /** Recreated each render; the latest is read lazily so we never re-register. */
  getCallbacks: () => BrowserExecutorCallbacks;
  /** Fired for every primitive the agent runs against this pane (activity signal). */
  onCommand?: (primitive: string) => void;
}

/**
 * Registers the active browser pane as a server-drivable controller and keeps the
 * server's view of the current URL in sync. The executor delegates to the pane's
 * latest callbacks via a ref, so this registers once per (controllerId, backend)
 * and never churns on re-render — important for this hot, shared component.
 */
export const useBrowserController = ({ enabled, backend, controllerId, url, title, getCallbacks, onCommand }: UseBrowserControllerParams): void => {
  const browser = useRuntimeAPIs().browser;

  const callbacksRef = React.useRef(getCallbacks);
  callbacksRef.current = getCallbacks;
  const urlRef = React.useRef(url);
  urlRef.current = url;
  const titleRef = React.useRef(title);
  titleRef.current = title;
  const onCommandRef = React.useRef(onCommand);
  onCommandRef.current = onCommand;
  const handleRef = React.useRef<BrowserControllerHandle | null>(null);

  React.useEffect(() => {
    if (!browser || !enabled || !controllerId) return undefined;

    const live: BrowserExecutorCallbacks = {
      runScript: (js) => callbacksRef.current().runScript(js),
      navigate: (u) => callbacksRef.current().navigate?.(u),
      goBack: () => callbacksRef.current().goBack?.(),
      goForward: () => callbacksRef.current().goForward?.(),
      reload: () => callbacksRef.current().reload?.(),
      screenshot: (o) => {
        const fn = callbacksRef.current().screenshot;
        return fn ? fn(o) : Promise.resolve(null);
      },
      // setViewport/emulateDevice are intentionally forwarded only when a pane
      // actually implements them; when absent the executor reports
      // UNSUPPORTED_ON_SURFACE rather than a fake success. handle_dialog runs as a
      // same-origin page script, so no dialog callback is wired here.
      ...(callbacksRef.current().setViewport ? { setViewport: (o: { width: number; height: number; dpr?: number }) => callbacksRef.current().setViewport?.(o) } : {}),
      ...(callbacksRef.current().emulateDevice ? { emulateDevice: (o: { device: string }) => callbacksRef.current().emulateDevice?.(o) } : {}),
      setInputFiles: (o) => {
        const fn = callbacksRef.current().setInputFiles;
        return fn ? fn(o) : Promise.resolve(null);
      },
    };

    const baseExecutor = createBrowserExecutor(live);
    const handle = browser.registerController({
      controllerId,
      backend,
      getUrl: () => urlRef.current,
      getTitle: () => titleRef.current,
      execute: (primitive, args) => {
        try { onCommandRef.current?.(primitive); } catch { /* indicator only */ }
        return baseExecutor(primitive, args);
      },
    });
    handleRef.current = handle;

    return () => {
      handle.close();
      handleRef.current = null;
    };
  }, [browser, enabled, controllerId, backend]);

  React.useEffect(() => {
    handleRef.current?.notifyNavigated({ url, title });
  }, [url, title]);
};

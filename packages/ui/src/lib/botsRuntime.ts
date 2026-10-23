import { useSyncExternalStore } from 'react';
import { subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

let controller = new AbortController();
let scope = { generation: 0, signal: controller.signal };
const listeners = new Set<() => void>();
let observedWindow: Window | null = null;
let releaseEndpoint: (() => void) | undefined;

const observeEndpoint = () => {
  if (!globalThis.window || observedWindow === window) return;
  releaseEndpoint?.();
  observedWindow = window;
  const releaseBefore = subscribeRuntimeEndpointWillChange(({ runtimeKey, previousRuntimeKey }) => {
    if (runtimeKey !== previousRuntimeKey) controller.abort();
  });
  const releaseAfter = subscribeRuntimeEndpointChanged(({ runtimeKey, previousRuntimeKey }) => {
    if (runtimeKey === previousRuntimeKey) return;
    controller.abort();
    controller = new AbortController();
    scope = { generation: scope.generation + 1, signal: controller.signal };
    for (const listener of listeners) listener();
  });
  releaseEndpoint = () => { releaseBefore(); releaseAfter(); };
};

/** Runtime lifetime, including A to B to A. Mutations keep this exact signal. */
export const getBotsRuntime = () => { observeEndpoint(); return scope; };
const subscribeBotsRuntime = (listener: () => void) => {
  observeEndpoint();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const useBotsRuntime = () => useSyncExternalStore(subscribeBotsRuntime, getBotsRuntime, getBotsRuntime);

import DevToolsAssetWorkerUrl from './devtoolsAssetWorker.ts?worker&url';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { openDevToolsAssetProxyRuntime } from './devtoolsAssetProxyRuntime';

export const openDevToolsAssetProxy = async (
  frontendPath: string,
  lifecycle: AbortSignal,
) => openDevToolsAssetProxyRuntime(frontendPath, lifecycle, {
  workerUrl: DevToolsAssetWorkerUrl,
  runtimeFetch,
  getRuntimeKey,
  subscribeRuntimeEndpointWillChange,
});

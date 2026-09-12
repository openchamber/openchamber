import {
  DEVTOOLS_ASSET_MAX_BYTES,
  DEVTOOLS_ASSET_MAX_PENDING,
  DEVTOOLS_ASSET_REQUEST_TIMEOUT_MS,
  encodeDevToolsOwnerClientId,
  isDevToolsRecoveryId,
  isDevToolsRouteKey,
  parseDevToolsAssetPath,
  parseDevToolsFrontendPath,
  type DevToolsAssetProxy,
  type DevToolsAssetProxyDependencies,
  type DevToolsAssetRequestMessage,
  type DevToolsAssetResponseMessage,
  type DevToolsRouteCloseMessage,
  type DevToolsRouteOpenMessage,
  type DevToolsRouteRecoverMessage,
  type DevToolsRouteReadyMessage,
  type QueuedDevToolsAssetRequest,
} from './devtoolsAssetProtocol';

const ACTIVATION_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 5_000;

class DevToolsAssetProxyError extends Error {
  readonly name = 'DevToolsAssetProxyError';

  constructor(readonly code: 'INVALID_PATH' | 'UNAVAILABLE' | 'ACTIVATION_FAILED' | 'ABORTED') {
    super(code);
  }
}

const waitForActiveWorker = async (registration: ServiceWorkerRegistration): Promise<ServiceWorker> => {
  if (registration.active) return registration.active;
  const candidate = registration.installing ?? registration.waiting;
  if (!candidate) throw new DevToolsAssetProxyError('ACTIVATION_FAILED');
  if (candidate.state === 'activated') return candidate;

  return new Promise<ServiceWorker>((resolve, reject) => {
    const timeout = setTimeout(() => {
      candidate.removeEventListener('statechange', onStateChange);
      reject(new DevToolsAssetProxyError('ACTIVATION_FAILED'));
    }, ACTIVATION_TIMEOUT_MS);
    const onStateChange = (): void => {
      if (candidate.state !== 'activated') return;
      clearTimeout(timeout);
      candidate.removeEventListener('statechange', onStateChange);
      resolve(candidate);
    };
    candidate.addEventListener('statechange', onStateChange);
  });
};

const createRouteKey = (): string => crypto.randomUUID().replaceAll('-', '');

const responseContentType = (response: Response): string => {
  const value = response.headers.get('content-type') ?? '';
  return value.length <= 256 && !value.includes('\r') && !value.includes('\n') ? value : '';
};

export const openDevToolsAssetProxyRuntime = async (
  frontendPath: string,
  lifecycle: AbortSignal,
  dependencies: DevToolsAssetProxyDependencies,
): Promise<DevToolsAssetProxy> => {
  const { runtimeFetch, getRuntimeKey, subscribeRuntimeEndpointWillChange } = dependencies;
  const parsed = parseDevToolsFrontendPath(frontendPath);
  if (!parsed) throw new DevToolsAssetProxyError('INVALID_PATH');
  if (lifecycle.aborted) throw new DevToolsAssetProxyError('ABORTED');
  const runtimeWindow = globalThis.window;
  const serviceWorkers = globalThis.navigator?.serviceWorker;
  if (!runtimeWindow || !serviceWorkers) {
    throw new DevToolsAssetProxyError('UNAVAILABLE');
  }

  const workerUrl = new URL(dependencies.workerUrl, runtimeWindow.location.href);
  if (workerUrl.origin !== runtimeWindow.location.origin || !/^https?:$/.test(workerUrl.protocol)) {
    throw new DevToolsAssetProxyError('UNAVAILABLE');
  }
  const scopeUrl = new URL('./openchamber-devtools/', workerUrl);
  const registration = await serviceWorkers.register(workerUrl.href, {
    scope: scopeUrl.pathname,
    type: 'module',
    updateViaCache: 'none',
  });
  const worker = await waitForActiveWorker(registration);
  if (worker.scriptURL !== workerUrl.href) throw new DevToolsAssetProxyError('ACTIVATION_FAILED');
  if (lifecycle.aborted) throw new DevToolsAssetProxyError('ABORTED');

  const routeKey = createRouteKey();
  if (!isDevToolsRouteKey(routeKey)) throw new DevToolsAssetProxyError('UNAVAILABLE');
  const runtimeKey = getRuntimeKey();
  const routeAbort = new AbortController();
  let disposed = false;
  let processing = false;
  let activePort: MessagePort | null = null;
  let activePortAbort: AbortController | null = null;
  let ownerClientId: string | null = null;
  const queued: QueuedDevToolsAssetRequest[] = [];

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    routeAbort.abort();
    activePortAbort?.abort();
    queued.length = 0;
    const closeMessage: DevToolsRouteCloseMessage = { type: 'devtools-route-close', routeKey, runtimeKey };
    activePort?.postMessage(closeMessage);
    activePort?.close();
    activePort = null;
    serviceWorkers.removeEventListener('message', recoverRoute);
    unsubscribeRuntime();
    lifecycle.removeEventListener('abort', dispose);
  };
  const unsubscribeRuntime = subscribeRuntimeEndpointWillChange(dispose);
  lifecycle.addEventListener('abort', dispose, { once: true });

  const sendFailure = (port: MessagePort, requestId: string, status: number): void => {
    if (disposed || port !== activePort) return;
    const message: DevToolsAssetResponseMessage = {
      type: 'devtools-asset-response', requestId, status, contentType: '', body: null,
    };
    port.postMessage(message);
  };

  const processQueue = async (): Promise<void> => {
    if (processing || disposed) return;
    const request = queued.shift();
    if (!request) return;
    processing = true;
    const requestAbort = new AbortController();
    const abortRequest = (): void => requestAbort.abort();
    routeAbort.signal.addEventListener('abort', abortRequest, { once: true });
    request.portSignal.addEventListener('abort', abortRequest, { once: true });
    const timeout = setTimeout(abortRequest, DEVTOOLS_ASSET_REQUEST_TIMEOUT_MS);
    try {
      if (getRuntimeKey() !== runtimeKey) {
        sendFailure(request.replyPort, request.requestId, 410);
        return;
      }
      const response = await runtimeFetch(`${parsed.assetRoot}/${request.path}`, {
        method: request.method,
        signal: requestAbort.signal,
        cache: 'no-store',
      });
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > DEVTOOLS_ASSET_MAX_BYTES) {
        void response.body?.cancel();
        sendFailure(request.replyPort, request.requestId, 502);
        return;
      }
      const body = request.method === 'HEAD' ? null : await response.arrayBuffer();
      if (body && body.byteLength > DEVTOOLS_ASSET_MAX_BYTES) {
        sendFailure(request.replyPort, request.requestId, 502);
        return;
      }
      if (disposed || request.portSignal.aborted || request.replyPort !== activePort
        || getRuntimeKey() !== runtimeKey) return;
      const message: DevToolsAssetResponseMessage = {
        type: 'devtools-asset-response', requestId: request.requestId,
        status: response.status, contentType: responseContentType(response), body,
      };
      request.replyPort.postMessage(message, body ? [body] : []);
    } catch (error) {
      if (!requestAbort.signal.aborted && error instanceof Error) {
        sendFailure(request.replyPort, request.requestId, 502);
      }
    } finally {
      clearTimeout(timeout);
      routeAbort.signal.removeEventListener('abort', abortRequest);
      request.portSignal.removeEventListener('abort', abortRequest);
      processing = false;
      void processQueue();
    }
  };

  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    const timeout = setTimeout(() => {
      routeAbort.signal.removeEventListener('abort', rejectAborted);
      reject(new DevToolsAssetProxyError('ACTIVATION_FAILED'));
    }, READY_TIMEOUT_MS);
    const rejectAborted = (): void => {
      clearTimeout(timeout);
      reject(new DevToolsAssetProxyError('ABORTED'));
    };
    routeAbort.signal.addEventListener('abort', rejectAborted, { once: true });
    const finishReady = (): void => {
      clearTimeout(timeout);
      routeAbort.signal.removeEventListener('abort', rejectAborted);
      resolve();
    };
    resolveReady = finishReady;
  });

  const receiveRouteMessage = (
    port: MessagePort,
    portSignal: AbortSignal,
    event: MessageEvent<DevToolsRouteReadyMessage | DevToolsAssetRequestMessage>,
  ): void => {
    if (port !== activePort || portSignal.aborted) return;
    const message = event.data;
    if (message.type === 'devtools-route-ready') {
      const ownerPath = encodeDevToolsOwnerClientId(message.ownerClientId);
      if (message.routeKey !== routeKey || message.runtimeKey !== runtimeKey || !ownerPath) return;
      if (ownerClientId !== null && ownerClientId !== message.ownerClientId) {
        dispose();
        return;
      }
      ownerClientId = message.ownerClientId;
      resolveReady?.();
      resolveReady = null;
      return;
    }
    if (message.type !== 'devtools-asset-request' || disposed) return;
    const path = parseDevToolsAssetPath(message.path);
    const method = message.method === 'GET' || message.method === 'HEAD' ? message.method : null;
    if (!path || !method || !/^[A-Za-z0-9_-]{1,64}$/.test(message.requestId)) {
      sendFailure(port, message.requestId, 404);
      return;
    }
    if (queued.length + (processing ? 1 : 0) >= DEVTOOLS_ASSET_MAX_PENDING) {
      sendFailure(port, message.requestId, 503);
      return;
    }
    queued.push({ ...message, path, method, replyPort: port, portSignal });
    void processQueue();
  };

  const connectRoute = (target: ServiceWorker, recoveryId: string | null): void => {
    activePortAbort?.abort();
    activePort?.close();
    queued.length = 0;
    const channel = new MessageChannel();
    const portAbort = new AbortController();
    activePort = channel.port1;
    activePortAbort = portAbort;
    channel.port1.onmessage = (event) => receiveRouteMessage(channel.port1, portAbort.signal, event);
    channel.port1.start();
    const openMessage: DevToolsRouteOpenMessage = {
      type: 'devtools-route-open', routeKey, runtimeKey, recoveryId,
    };
    target.postMessage(openMessage, [channel.port2]);
  };

  function recoverRoute(event: MessageEvent<DevToolsRouteRecoverMessage>): void {
    const source = event.source;
    const message = event.data;
    if (disposed || !(source instanceof ServiceWorker) || source.scriptURL !== workerUrl.href) return;
    if (!message || message.type !== 'devtools-route-recover' || message.routeKey !== routeKey) return;
    if (!isDevToolsRecoveryId(message.recoveryId) || getRuntimeKey() !== runtimeKey) return;
    connectRoute(source, message.recoveryId);
  }

  serviceWorkers.addEventListener('message', recoverRoute);
  connectRoute(worker, null);
  try {
    await ready;
  } catch (error) {
    dispose();
    throw error;
  }
  if (disposed) throw new DevToolsAssetProxyError('ABORTED');
  const ownerPath = encodeDevToolsOwnerClientId(ownerClientId ?? '');
  if (!ownerPath) {
    dispose();
    throw new DevToolsAssetProxyError('ACTIVATION_FAILED');
  }
  return { frontendUrl: new URL(`${ownerPath}/${routeKey}/inspector.html`, scopeUrl).href, dispose };
};

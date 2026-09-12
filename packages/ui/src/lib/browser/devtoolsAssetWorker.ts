/// <reference lib="webworker" />

import {
  DEVTOOLS_ASSET_MAX_PENDING,
  DEVTOOLS_ASSET_REQUEST_TIMEOUT_MS,
  DEVTOOLS_ROUTE_RECOVERY_TIMEOUT_MS,
  isDevToolsRecoveryId,
  isDevToolsRouteKey,
  isDevToolsRuntimeKey,
  parseScopedDevToolsRequest,
  type DevToolsAssetRequestMessage,
  type DevToolsAssetResponseMessage,
  type DevToolsRouteCloseMessage,
  type DevToolsRouteOpenMessage,
  type DevToolsRouteRecoverMessage,
  type DevToolsRouteReadyMessage,
} from './devtoolsAssetProtocol';

declare const self: ServiceWorkerGlobalScope;

type PendingResponse = {
  readonly resolve: (response: Response) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly method: 'GET' | 'HEAD';
};

type Route = {
  readonly port: MessagePort;
  readonly pending: Map<string, PendingResponse>;
  readonly runtimeKey: string;
  readonly ownerClientId: string;
};

type RouteRecovery = {
  readonly recoveryId: string;
  readonly ownerClientId: string;
  readonly promise: Promise<Route | null>;
  readonly resolve: (route: Route | null) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};

const ephemeralRoutes = new Map<string, Route>();
const routeRecoveries = new Map<string, RouteRecovery>();
let requestSequence = 0;
const requestGeneration = crypto.randomUUID().replaceAll('-', '');

const fixedResponse = (status: number): Response => new Response(null, {
  status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});

const closeRoute = (routeKey: string): void => {
  const route = ephemeralRoutes.get(routeKey);
  if (!route) return;
  ephemeralRoutes.delete(routeKey);
  for (const pending of route.pending.values()) {
    clearTimeout(pending.timeout);
    pending.resolve(fixedResponse(410));
  }
  route.pending.clear();
  route.port.close();
};

const acceptAssetResponse = (routeKey: string, message: DevToolsAssetResponseMessage): void => {
  const route = ephemeralRoutes.get(routeKey);
  const pending = route?.pending.get(message.requestId);
  if (!route || !pending || message.status < 200 || message.status > 599) return;
  route.pending.delete(message.requestId);
  clearTimeout(pending.timeout);
  const headers = new Headers({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
  });
  if (message.contentType) headers.set('content-type', message.contentType);
  pending.resolve(new Response(pending.method === 'HEAD' ? null : message.body, {
    status: message.status,
    headers,
  }));
};

const openRoute = (message: DevToolsRouteOpenMessage, port: MessagePort, ownerClientId: string): void => {
  const { routeKey, runtimeKey, recoveryId } = message;
  const recovery = routeRecoveries.get(routeKey);
  const invalidRecovery = recovery
    ? recoveryId === null || !isDevToolsRecoveryId(recoveryId)
      || recoveryId !== recovery.recoveryId || ownerClientId !== recovery.ownerClientId
    : recoveryId !== null;
  if (!isDevToolsRouteKey(routeKey) || !isDevToolsRuntimeKey(runtimeKey) || invalidRecovery
    || ephemeralRoutes.has(routeKey) || ephemeralRoutes.size >= 32) {
    port.close();
    return;
  }
  const route: Route = { port, pending: new Map(), runtimeKey, ownerClientId };
  ephemeralRoutes.set(routeKey, route);
  port.onmessage = (event: MessageEvent<DevToolsAssetResponseMessage | DevToolsRouteCloseMessage>) => {
    const message = event.data;
    if (message.type === 'devtools-route-close'
      && message.routeKey === routeKey && message.runtimeKey === runtimeKey) {
      closeRoute(routeKey);
      return;
    }
    if (message.type === 'devtools-asset-response') acceptAssetResponse(routeKey, message);
  };
  port.onmessageerror = () => closeRoute(routeKey);
  port.start();
  const ready: DevToolsRouteReadyMessage = {
    type: 'devtools-route-ready', routeKey, runtimeKey, ownerClientId,
  };
  port.postMessage(ready);
  if (recovery) {
    clearTimeout(recovery.timeout);
    routeRecoveries.delete(routeKey);
    recovery.resolve(route);
  }
};

const recoverRoute = (routeKey: string, ownerClientId: string): Promise<Route | null> => {
  const active = ephemeralRoutes.get(routeKey);
  if (active) return Promise.resolve(active.ownerClientId === ownerClientId ? active : null);
  const existing = routeRecoveries.get(routeKey);
  if (existing) {
    return existing.ownerClientId === ownerClientId ? existing.promise : Promise.resolve(null);
  }

  const recoveryId = crypto.randomUUID().replaceAll('-', '');
  let settle: (route: Route | null) => void = () => {};
  const promise = new Promise<Route | null>((resolve) => {
    settle = resolve;
  });
  const timeout = setTimeout(() => {
    routeRecoveries.delete(routeKey);
    settle(null);
  }, DEVTOOLS_ROUTE_RECOVERY_TIMEOUT_MS);
  routeRecoveries.set(routeKey, { recoveryId, ownerClientId, promise, resolve: settle, timeout });
  void self.clients.get(ownerClientId).then(
    (client) => {
      const message: DevToolsRouteRecoverMessage = { type: 'devtools-route-recover', routeKey, recoveryId };
      if (client?.type === 'window') client.postMessage(message);
      else {
        clearTimeout(timeout);
        routeRecoveries.delete(routeKey);
        settle(null);
      }
    },
    () => {
      clearTimeout(timeout);
      routeRecoveries.delete(routeKey);
      settle(null);
    },
  );
  return promise;
};

const isWindowClientSource = (source: ExtendableMessageEvent['source']): source is WindowClient =>
  source !== null && 'id' in source && 'type' in source && source.type === 'window';

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const message: DevToolsRouteOpenMessage = event.data;
  const port = event.ports[0];
  if (!message || message.type !== 'devtools-route-open' || !port) return;
  if (!isWindowClientSource(event.source)) {
    port.close();
    return;
  }
  openRoute(message, port, event.source.id);
});

self.addEventListener('fetch', (event: FetchEvent) => {
  const parsed = parseScopedDevToolsRequest(event.request.url, self.registration.scope);
  if (!parsed) {
    event.respondWith(Promise.resolve(fixedResponse(404)));
    return;
  }
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
    event.respondWith(Promise.resolve(new Response(null, {
      status: 405,
      headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' },
    })));
    return;
  }
  const method = event.request.method === 'GET' ? 'GET' : 'HEAD';
  event.respondWith(recoverRoute(parsed.routeKey, parsed.ownerClientId).then((route) => {
    if (!route || route.pending.size >= DEVTOOLS_ASSET_MAX_PENDING) {
      return fixedResponse(route ? 503 : 404);
    }
    const requestId = `${requestGeneration}-${++requestSequence}`;
    return new Promise<Response>((resolve) => {
      const timeout = setTimeout(() => {
        route.pending.delete(requestId);
        resolve(fixedResponse(504));
      }, DEVTOOLS_ASSET_REQUEST_TIMEOUT_MS);
      route.pending.set(requestId, { resolve, timeout, method });
      const request: DevToolsAssetRequestMessage = {
        type: 'devtools-asset-request', requestId, method, path: parsed.assetPath,
      };
      route.port.postMessage(request);
    });
  }));
});

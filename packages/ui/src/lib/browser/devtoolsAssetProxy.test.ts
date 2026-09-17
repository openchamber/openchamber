import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type {
  DevToolsAssetRequestMessage,
  DevToolsAssetResponseMessage,
  DevToolsRouteCloseMessage,
  DevToolsRouteOpenMessage,
  DevToolsRouteRecoverMessage,
} from './devtoolsAssetProtocol';
import { openDevToolsAssetProxyRuntime } from './devtoolsAssetProxyRuntime';

type RuntimeFetch = (path: string, init?: RequestInit) => Promise<Response>;

let runtimeFetchImpl: RuntimeFetch = async () => new Response('asset', {
  status: 200,
  headers: { 'content-type': 'text/javascript' },
});
const runtimeFetchCalls: Array<Parameters<RuntimeFetch>> = [];
let runtimeKey = 'relay-a';
let runtimeChange: (() => void) | null = null;

const grant = 'abcdefghijklmnopqrstuvwxyzABCDEF';
const frontendPath = `/api/browser-devtools/${grant}/inspector.html`;
const ownerClientId = 'window-owner-a';
const ownerPath = Array.from(new TextEncoder().encode(ownerClientId), (byte) =>
  byte.toString(16).padStart(2, '0')).join('');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalServiceWorker = Object.getOwnPropertyDescriptor(globalThis, 'ServiceWorker');

const dependencies = {
  workerUrl: '/assets/devtoolsAssetWorker.js',
  runtimeFetch: (path: string, init?: RequestInit) => {
    runtimeFetchCalls.push([path, init]);
    return runtimeFetchImpl(path, init);
  },
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointWillChange: (listener: () => void) => {
    runtimeChange = listener;
    return () => {
      if (runtimeChange === listener) runtimeChange = null;
    };
  },
};

const openDevToolsAssetProxy = (path: string, lifecycle: AbortSignal) =>
  openDevToolsAssetProxyRuntime(path, lifecycle, dependencies);

type WorkerTarget = EventTarget & {
  readonly scriptURL: string;
  readonly postMessage: (message: DevToolsRouteOpenMessage, transfer: readonly Transferable[]) => void;
};

const dispatchWorkerMessage = (target: EventTarget, source: WorkerTarget, data: DevToolsRouteRecoverMessage): void => {
  const event = new Event('message');
  Object.defineProperties(event, { data: { value: data }, source: { value: source } });
  target.dispatchEvent(event);
};

type WorkerHarness = {
  port: MessagePort | null;
  readonly ports: MessagePort[];
  readonly worker: WorkerTarget;
  readonly serviceWorkers: EventTarget;
  readonly openMessages: DevToolsRouteOpenMessage[];
  readonly registerCalls: Array<readonly [string, RegistrationOptions | undefined]>;
};

const installWorkerHarness = (): WorkerHarness => {
  const serviceWorkers = new EventTarget();
  class TestServiceWorker extends EventTarget {
    readonly scriptURL = 'https://app.example/assets/devtoolsAssetWorker.js';

    postMessage(message: DevToolsRouteOpenMessage, transfer: readonly Transferable[]): void {
      const port = transfer[0];
      if (!(port instanceof MessagePort)) return;
      harness.openMessages.push(message);
      harness.port = port;
      harness.ports.push(port);
      port.start();
      queueMicrotask(() => port.postMessage({
        type: 'devtools-route-ready', routeKey: message.routeKey,
        runtimeKey: message.runtimeKey, ownerClientId,
      }));
    }
  }
  Object.defineProperty(globalThis, 'ServiceWorker', { configurable: true, value: TestServiceWorker });
  const worker = new TestServiceWorker();
  const harness: WorkerHarness = {
    port: null, ports: [], worker, serviceWorkers, openMessages: [], registerCalls: [],
  };
  const register = async (scriptUrl: string, options?: RegistrationOptions) => {
    harness.registerCalls.push([scriptUrl, options]);
    return { active: worker };
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { href: 'https://app.example/app/', origin: 'https://app.example' } },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { serviceWorker: Object.assign(serviceWorkers, { register }) },
  });
  return harness;
};

const nextWorkerMessage = <T,>(port: MessagePort): Promise<T> => new Promise((resolve) => {
  port.addEventListener('message', (event: MessageEvent<T>) => resolve(event.data), { once: true });
});

const sendAssetRequest = async (
  port: MessagePort,
  request: DevToolsAssetRequestMessage,
): Promise<DevToolsAssetResponseMessage> => {
  const response = nextWorkerMessage<DevToolsAssetResponseMessage>(port);
  port.postMessage(request);
  return response;
};

beforeEach(() => {
  runtimeKey = 'relay-a';
  runtimeChange = null;
  runtimeFetchCalls.length = 0;
  runtimeFetchImpl = async () => new Response('asset', {
    status: 200,
    headers: { 'content-type': 'text/javascript' },
  });
});

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
  if (originalServiceWorker) Object.defineProperty(globalThis, 'ServiceWorker', originalServiceWorker);
  else Reflect.deleteProperty(globalThis, 'ServiceWorker');
});

describe('openDevToolsAssetProxy', () => {
  test('registers the narrow worker scope and forwards one exact grant asset', async () => {
    const harness = installWorkerHarness();
    const lifecycle = new AbortController();
    const proxy = await openDevToolsAssetProxy(frontendPath, lifecycle.signal);
    const port = harness.port;
    expect(port).toBeInstanceOf(MessagePort);
    if (!port) return;

    expect(harness.registerCalls.at(0)).toEqual([
      'https://app.example/assets/devtoolsAssetWorker.js',
      { scope: '/assets/openchamber-devtools/', type: 'module', updateViaCache: 'none' },
    ]);
    const initialOpen = harness.openMessages.at(0);
    expect(initialOpen?.type).toBe('devtools-route-open');
    expect(initialOpen?.runtimeKey).toBe('relay-a');
    expect(initialOpen?.recoveryId).toBeNull();
    expect(/^[a-f0-9]{32}$/.test(initialOpen?.routeKey ?? '')).toBe(true);
    expect(proxy.frontendUrl).toBe(
      `https://app.example/assets/openchamber-devtools/${ownerPath}/${initialOpen?.routeKey}/inspector.html`,
    );
    const response = await sendAssetRequest(port, {
      type: 'devtools-asset-request', requestId: 'request-a', method: 'GET',
      path: 'entrypoints/inspector/inspector.js',
    });
    const fetchCall = runtimeFetchCalls.at(0);
    expect(fetchCall?.[0]).toBe(
      `/api/browser-devtools/${grant}/entrypoints/inspector/inspector.js`,
    );
    expect(fetchCall?.[1]?.method).toBe('GET');
    expect(fetchCall?.[1]?.cache).toBe('no-store');
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.body ?? new ArrayBuffer(0))).toBe('asset');
    proxy.dispose();
  });

  test('aborts an in-flight asset when its lifecycle closes', async () => {
    const harness = installWorkerHarness();
    const lifecycle = new AbortController();
    let announceFetchStarted: (signal: AbortSignal) => void = () => {};
    const fetchStarted = new Promise<AbortSignal>((resolve) => {
      announceFetchStarted = resolve;
    });
    runtimeFetchImpl = (_path: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      announceFetchStarted(signal);
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    await openDevToolsAssetProxy(frontendPath, lifecycle.signal);
    const port = harness.port;
    if (!port) return;
    port.postMessage({ type: 'devtools-asset-request', requestId: 'request-a', method: 'GET', path: 'bridge.js' });
    const fetchSignal = await fetchStarted;
    lifecycle.abort();
    expect(fetchSignal.aborted).toBe(true);
  });

  test('rejects a request after the captured runtime identity becomes stale', async () => {
    const harness = installWorkerHarness();
    const proxy = await openDevToolsAssetProxy(frontendPath, new AbortController().signal);
    const port = harness.port;
    if (!port) return;
    runtimeKey = 'relay-b';
    const response = await sendAssetRequest(port, {
      type: 'devtools-asset-request', requestId: 'request-a', method: 'GET', path: 'bridge.js',
    });
    expect(response.status).toBe(410);
    expect(runtimeFetchCalls.length).toBe(0);
    proxy.dispose();
  });

  test('rejects an unauthorized worker path before runtime fetch', async () => {
    const harness = installWorkerHarness();
    const proxy = await openDevToolsAssetProxy(frontendPath, new AbortController().signal);
    const port = harness.port;
    if (!port) return;
    const response = await sendAssetRequest(port, {
      type: 'devtools-asset-request', requestId: 'request-a', method: 'GET', path: '../../client-auth/connections',
    });
    expect(response.status).toBe(404);
    expect(runtimeFetchCalls.length).toBe(0);
    proxy.dispose();
  });

  test('rejects an oversized response before buffering its body', async () => {
    const harness = installWorkerHarness();
    runtimeFetchImpl = async () => new Response('small', {
      status: 200,
      headers: { 'content-length': String(64 * 1024 * 1024 + 1) },
    });
    const proxy = await openDevToolsAssetProxy(frontendPath, new AbortController().signal);
    const port = harness.port;
    if (!port) return;
    const response = await sendAssetRequest(port, {
      type: 'devtools-asset-request', requestId: 'request-a', method: 'GET', path: 'bridge.js',
    });
    expect(response.status).toBe(502);
    expect(response.body).toBeNull();
    proxy.dispose();
  });

  test('runtime switching disposes the route and sends its close identity', async () => {
    const harness = installWorkerHarness();
    await openDevToolsAssetProxy(frontendPath, new AbortController().signal);
    const port = harness.port;
    if (!port) return;
    const close = nextWorkerMessage<DevToolsRouteCloseMessage>(port);
    runtimeChange?.();
    expect((await close).type).toBe('devtools-route-close');
  });

  test('reconnects an exact live route when a restarted worker requests recovery', async () => {
    const harness = installWorkerHarness();
    const proxy = await openDevToolsAssetProxy(frontendPath, new AbortController().signal);
    const initialPort = harness.port;
    const initialOpen = harness.openMessages.at(0);
    if (!initialPort || !initialOpen) return;
    const recovery: DevToolsRouteRecoverMessage = {
      type: 'devtools-route-recover',
      routeKey: initialOpen.routeKey,
      recoveryId: 'abcdef0123456789abcdef0123456789',
    };

    runtimeKey = 'relay-b';
    dispatchWorkerMessage(harness.serviceWorkers, harness.worker, recovery);
    expect(harness.port).toBe(initialPort);

    runtimeKey = 'relay-a';
    dispatchWorkerMessage(harness.serviceWorkers, harness.worker, recovery);
    expect(harness.port).not.toBe(initialPort);
    expect(harness.openMessages.at(1)).toEqual({
      type: 'devtools-route-open', routeKey: initialOpen.routeKey,
      runtimeKey: 'relay-a', recoveryId: recovery.recoveryId,
    });
    proxy.dispose();
  });

  test('never sends an old in-flight result through a recovered worker port', async () => {
    const harness = installWorkerHarness();
    let resolveOldFetch: (response: Response) => void = () => {};
    let announceOldFetch: () => void = () => {};
    const oldFetchStarted = new Promise<void>((resolve) => { announceOldFetch = resolve; });
    runtimeFetchImpl = () => {
      if (runtimeFetchCalls.length === 1) {
        announceOldFetch();
        return new Promise<Response>((resolve) => { resolveOldFetch = resolve; });
      }
      return Promise.resolve(new Response('new asset', { status: 200 }));
    };
    const proxy = await openDevToolsAssetProxy(frontendPath, new AbortController().signal);
    const initialPort = harness.port;
    const initialOpen = harness.openMessages.at(0);
    if (!initialPort || !initialOpen) return;
    initialPort.postMessage({
      type: 'devtools-asset-request', requestId: 'generation-a-1',
      method: 'GET', path: 'old.js',
    } satisfies DevToolsAssetRequestMessage);
    await oldFetchStarted;

    dispatchWorkerMessage(harness.serviceWorkers, harness.worker, {
      type: 'devtools-route-recover', routeKey: initialOpen.routeKey,
      recoveryId: '1234567890abcdef1234567890abcdef',
    });
    const recoveredPort = harness.port;
    if (!recoveredPort || recoveredPort === initialPort) return;
    const recoveredResponse = sendAssetRequest(recoveredPort, {
      type: 'devtools-asset-request', requestId: 'generation-b-1',
      method: 'GET', path: 'new.js',
    });
    resolveOldFetch(new Response('old asset', { status: 200 }));

    expect(new TextDecoder().decode((await recoveredResponse).body ?? new ArrayBuffer(0))).toBe('new asset');
    expect(runtimeFetchCalls.map(([path]) => path)).toEqual([
      `/api/browser-devtools/${grant}/old.js`, `/api/browser-devtools/${grant}/new.js`,
    ]);
    proxy.dispose();
  });
});

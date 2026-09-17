import { afterAll, describe, expect, test } from 'bun:test';

import type {
  DevToolsAssetRequestMessage,
  DevToolsAssetResponseMessage,
  DevToolsRouteOpenMessage,
  DevToolsRouteRecoverMessage,
  DevToolsRouteReadyMessage,
} from './devtoolsAssetProtocol';

const routeKey = '0123456789abcdef0123456789abcdef';
const scopeUrl = 'https://app.example/assets/openchamber-devtools/';
const ownerClientId = 'window-owner-a';
const ownerPath = Array.from(new TextEncoder().encode(ownerClientId), (byte) =>
  byte.toString(16).padStart(2, '0')).join('');
const otherOwnerPath = Array.from(new TextEncoder().encode('window-owner-b'), (byte) =>
  byte.toString(16).padStart(2, '0')).join('');
const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');

class WorkerScopeHarness extends EventTarget {
  readonly registration = { scope: scopeUrl };
  readonly requestedClientIds: string[] = [];
  readonly recoveryMessages: DevToolsRouteRecoverMessage[] = [];
  readonly assetRequests: DevToolsAssetRequestMessage[] = [];
  hasOwner = true;
  deferRecovery = false;
  deferredRecovery: DevToolsRouteRecoverMessage | null = null;
  readonly ownerClient = {
    id: ownerClientId,
    type: 'window' as const,
    postMessage: (message: DevToolsRouteRecoverMessage) => {
      if (this.deferRecovery) this.deferredRecovery = message;
      else this.recover(message);
    },
  };
  readonly clients = {
    claim: async () => {},
    get: async (clientId: string) => {
      this.requestedClientIds.push(clientId);
      return this.hasOwner && clientId === ownerClientId ? this.ownerClient : undefined;
    },
  };

  private recover(message: DevToolsRouteRecoverMessage): void {
    this.recoveryMessages.push(message);
    const channel = new MessageChannel();
    channel.port1.onmessage = (event: MessageEvent<DevToolsAssetRequestMessage | DevToolsRouteReadyMessage>) => {
      const request = event.data;
      if (request.type !== 'devtools-asset-request') return;
      this.assetRequests.push(request);
      const body = new TextEncoder().encode('recovered asset').buffer;
      const response: DevToolsAssetResponseMessage = {
        type: 'devtools-asset-response', requestId: request.requestId,
        status: 200, contentType: 'text/javascript', body,
      };
      channel.port1.postMessage(response, [body]);
    };
    channel.port1.start();
    const open: DevToolsRouteOpenMessage = {
      type: 'devtools-route-open', routeKey: message.routeKey,
      runtimeKey: 'relay-a', recoveryId: message.recoveryId,
    };
    const event = new Event('message');
    Object.defineProperties(event, {
      data: { value: open }, ports: { value: [channel.port2] }, source: { value: this.ownerClient },
    });
    this.dispatchEvent(event);
  }

  completeDeferredRecovery(): void {
    const message = this.deferredRecovery;
    if (!message) return;
    this.deferredRecovery = null;
    this.recover(message);
  }
}

const scope = new WorkerScopeHarness();
Object.defineProperty(globalThis, 'self', { configurable: true, value: scope });
await import('./devtoolsAssetWorker');

afterAll(() => {
  if (originalSelf) Object.defineProperty(globalThis, 'self', originalSelf);
  else Reflect.deleteProperty(globalThis, 'self');
});

const dispatchFetch = (url: string): Promise<Response> => new Promise((resolve) => {
  const event = new Event('fetch');
  Object.defineProperties(event, {
    request: { value: new Request(url) },
    respondWith: { value: (response: Promise<Response>) => { void response.then(resolve); } },
  });
  scope.dispatchEvent(event);
});

describe('DevTools asset worker restart recovery', () => {
  test('asks a live owner to restore an unknown route before forwarding the asset', async () => {
    const response = await dispatchFetch(
      `${scopeUrl}${ownerPath}/${routeKey}/entrypoints/inspector/inspector.js`,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('recovered asset');
    expect(scope.requestedClientIds).toEqual([ownerClientId]);
    expect(scope.recoveryMessages).toHaveLength(1);
    expect(scope.recoveryMessages[0]?.routeKey).toBe(routeKey);
    expect(/^[a-f0-9]{32}$/.test(scope.recoveryMessages[0]?.recoveryId ?? '')).toBe(true);
    expect(scope.assetRequests[0]?.path).toBe('entrypoints/inspector/inspector.js');
  });

  test('returns not found when no owner can restore an unknown route', async () => {
    scope.hasOwner = false;
    const unknownRoute = 'fedcba9876543210fedcba9876543210';
    const response = await dispatchFetch(`${scopeUrl}${ownerPath}/${unknownRoute}/inspector.html`);
    expect(response.status).toBe(404);
  });

  test('does not share a pending route recovery with another encoded owner', async () => {
    scope.hasOwner = true;
    scope.deferRecovery = true;
    const collisionRoute = '11111111111111111111111111111111';
    const ownerResponse = dispatchFetch(`${scopeUrl}${ownerPath}/${collisionRoute}/inspector.html`);
    const otherResponse = await dispatchFetch(
      `${scopeUrl}${otherOwnerPath}/${collisionRoute}/inspector.html`,
    );
    expect(otherResponse.status).toBe(404);
    scope.completeDeferredRecovery();
    expect((await ownerResponse).status).toBe(200);
  });
});

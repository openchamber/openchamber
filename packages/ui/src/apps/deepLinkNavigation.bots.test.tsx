import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { installSuggestedTasksDom, serveSuggestedTasks } from '@/lib/test-utils/suggestedTasks.fixture';

const dom = installSuggestedTasksDom();
const server = await serveSuggestedTasks(() => Response.json({}));
const { createRoot } = await import('react-dom/client');
const { useUIStore } = await import('@/stores/useUIStore');
const { switchRuntimeEndpoint, MOBILE_DISCONNECTED_RUNTIME_KEY } = await import('@/lib/runtime-switch');
const { applyDeepLinkUrl, useDeepLinkHandlers, useDeepLinkSource } = await import('./deepLinkNavigation');
let root: Root;
let mobileOpens = 0;
const handlers = { openBots: () => { mobileOpens += 1; } };

function Harness({ ready }: { readonly ready: boolean }) {
  useDeepLinkSource({ ready });
  useDeepLinkHandlers(handlers);
  return null;
}

beforeEach(() => {
  window.__OPENCHAMBER_SURFACE__ = 'mobile';
  switchRuntimeEndpoint({ apiBaseUrl: server.url.origin, runtimeKey: 'native-a' });
  useUIStore.getState().closeMainSurfaces();
  mobileOpens = 0;
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); useUIStore.getState().closeMainSurfaces(); });
afterAll(async () => { await server.stop(true); await dom.restore(); });

describe('Bots native intent application', () => {
  test('opens a sessionless native push URL through the mobile handler', async () => {
    // Given a connected shell with its Bots action registered.
    await act(async () => root.render(<Harness ready />));

    // When the native push entry receives an HTTP target URL.
    await act(async () => applyDeepLinkUrl('https://server.example/?botsProject=project-1&botItem=item-7'));

    // Then it installs the exact target before opening the mobile surface.
    expect(useUIStore.getState().botsPageTarget).toEqual({ projectId: 'project-1', itemId: 'item-7' });
    expect(mobileOpens).toBe(1);
    expect(useUIStore.getState().isBotsPageOpen).toBe(false);
  });

  test('preserves a cold-launch target while the first server connects', async () => {
    // Given no selected runtime and a link arriving before readiness.
    switchRuntimeEndpoint({ apiBaseUrl: server.url.origin, runtimeKey: MOBILE_DISCONNECTED_RUNTIME_KEY });
    await act(async () => root.render(<Harness ready={false} />));
    applyDeepLinkUrl('openchamber://bots?botsProject=project-1&botItem=item-7');

    // When the first server connects and its shell is ready.
    await act(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: server.url.origin, runtimeKey: 'native-a' });
      root.render(<Harness ready />);
    });

    // Then the cold-launch item opens once.
    expect(useUIStore.getState().botsPageTarget).toEqual({ projectId: 'project-1', itemId: 'item-7' });
    expect(mobileOpens).toBe(1);
  });

  test('drops a queued item when changing connected runtimes before readiness', async () => {
    // Given an item tap waiting while runtime A reconnects.
    await act(async () => root.render(<Harness ready={false} />));
    applyDeepLinkUrl('/?botsProject=project-1&botItem=item-7');

    // When the user switches to runtime B before the shell is ready.
    await act(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: server.url.origin, runtimeKey: 'native-b' });
      root.render(<Harness ready />);
    });

    // Then matching project/item IDs on B cannot consume A's pending tap.
    expect(useUIStore.getState().botsPageTarget).toBeNull();
    expect(mobileOpens).toBe(0);
  });
});

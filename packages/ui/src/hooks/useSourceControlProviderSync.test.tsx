import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import { acmeDescriptor, githubLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';

type StreamProperties = { connectionId?: string; guestId?: string; guestName?: string };

class EventSourceFixture {
  static CLOSED = 2;
  static instances: EventSourceFixture[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { EventSourceFixture.instances.push(this); }
  close() { this.readyState = EventSourceFixture.CLOSED; }
  emit(type: string, properties: StreamProperties = {}) {
    this.onmessage?.({ data: JSON.stringify({ type, properties }) });
  }
}

// Real mounted hook, event module and registry; only the browser stream is a fixture.
test('re-reads the provider list and its connected instances when the server announces a change or the stream reconnects', async () => {
  const dom = new Window({ url: 'http://source-control-sync.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
    EventSource: EventSourceFixture, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  EventSourceFixture.instances = [];
  let served: SourceControlProviderDescriptor[] = [githubLikeDescriptor()];
  let reads = 0;
  // The instance list names only registered providers, so it is read again with the provider list.
  let instances = [{ provider: 'github', instance: 'https://github.com' }];
  let instanceReads = 0;
  const sourceControl = {
    providers: async () => { reads += 1; return served; },
    authInstances: async () => { instanceReads += 1; return instances; },
    authStatus: async (identity: { provider: string; instance: string }) => ({
      ...identity, status: 'disconnected' as const, connected: false as const,
    }),
  };
  const { createRoot } = await import('react-dom/client');
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { useSourceControlProviderSync } = await import('./useSourceControlProviderSync');
  const { useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  function Probe() {
    useSourceControlProviderSync(sourceControl);
    return null;
  }
  const ids = () => useSourceControlProviderRegistry.getState().ordered.map((descriptor) => descriptor.id);
  const instanceProviders = () => useSourceControlAuthStore.getState().identities.map((identity) => identity.provider);
  try {
    await act(async () => root.render(<Probe />));
    expect(EventSourceFixture.instances).toHaveLength(1);
    const source = EventSourceFixture.instances[0];
    await act(async () => { await useSourceControlProviderRegistry.getState().refresh(sourceControl); });
    expect(reads).toBe(1);

    served = [githubLikeDescriptor(), acmeDescriptor({ id: 'ext-acme' })];
    instances = [...instances, { provider: 'ext-acme', instance: 'https://git.acme.test' }];
    await act(async () => source.emit('openchamber:source-control-providers-changed'));
    expect(reads).toBe(2);
    expect(ids()).toEqual(['github', 'ext-acme']);
    expect(instanceReads).toBe(1);
    expect(instanceProviders()).toEqual(['github', 'ext-acme']);

    // A change made while the stream was down was never announced to this client.
    served = [githubLikeDescriptor()];
    instances = [{ provider: 'github', instance: 'https://github.com' }];
    await act(async () => source.emit('openchamber:event-stream-ready', { connectionId: 'c-2' }));
    expect(reads).toBe(3);
    expect(ids()).toEqual(['github']);
    expect(instanceReads).toBe(2);
    expect(instanceProviders()).toEqual(['github']);

    await act(async () => source.emit('openchamber:browser-provider-reset', { guestId: 'g', guestName: 'G' }));
    expect(reads).toBe(3);
    expect(instanceReads).toBe(2);

    await act(async () => root.unmount());
    await act(async () => source.emit('openchamber:source-control-providers-changed'));
    expect(reads).toBe(3);
    expect(instanceReads).toBe(2);
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

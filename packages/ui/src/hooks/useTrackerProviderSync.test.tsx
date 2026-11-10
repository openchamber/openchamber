import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { TrackerAPI, TrackerDescriptor } from '@/lib/api/types';
import { acmeTrackerDescriptor, linearLikeTrackerDescriptor } from '@/lib/trackers/descriptor.fixture';

class EventSourceFixture {
  static CLOSED = 2;
  static instances: EventSourceFixture[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { EventSourceFixture.instances.push(this); }
  close() { this.readyState = EventSourceFixture.CLOSED; }
  emit(type: string) {
    this.onmessage?.({ data: JSON.stringify({ type, properties: {} }) });
  }
}

const unexpected = (): never => { throw new Error('Unexpected tracker call'); };

// Real mounted hook, event module, registry and auth store; only the browser stream is a fixture.
test('re-reads the tracker list and every status when the server announces a change or the stream reconnects', async () => {
  const dom = new Window({ url: 'http://tracker-sync.test' });
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
  let served: TrackerDescriptor[] = [linearLikeTrackerDescriptor()];
  let reads = 0;
  const statusReads: string[] = [];
  const trackers: TrackerAPI = {
    providers: async () => { reads += 1; return served; },
    authStatus: async (provider) => { statusReads.push(provider); return { connected: false }; },
    authStart: unexpected, authConnectToken: unexpected, authSaveOAuthClient: unexpected, authDisconnect: unexpected, authActivate: unexpected,
    list: unexpected, refreshListReads: unexpected, get: unexpected, states: unexpected, updateState: unexpected,
    mappingGet: unexpected, mappingSet: unexpected, sessionStatusPost: unexpected, preferencesGet: unexpected, preferencesSet: unexpected,
  };
  const { createRoot } = await import('react-dom/client');
  const { useTrackerRegistry } = await import('@/lib/trackers/registry');
  const { useTrackerAuthStore } = await import('@/stores/useTrackerAuthStore');
  const { useTrackerProviderSync } = await import('./useTrackerProviderSync');
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  function Probe() {
    useTrackerProviderSync(trackers);
    return null;
  }
  const ids = () => useTrackerRegistry.getState().ordered.map((descriptor) => descriptor.id);
  try {
    await act(async () => root.render(<Probe />));
    expect(EventSourceFixture.instances).toHaveLength(1);
    const source = EventSourceFixture.instances[0];
    await act(async () => { await useTrackerRegistry.getState().refresh(trackers); });
    expect(reads).toBe(1);
    expect(ids()).toEqual(['linear']);

    // An extension's tracker attached: the list and the statuses are read again.
    served = [linearLikeTrackerDescriptor(), acmeTrackerDescriptor({ id: 'ext-acme' })];
    await act(async () => source.emit('openchamber:tracker-providers-changed'));
    expect(reads).toBe(2);
    expect(ids()).toEqual(['linear', 'ext-acme']);
    expect(statusReads).toContain('ext-acme');

    // A reconnect reads again too; an unrelated event does not.
    await act(async () => source.emit('openchamber:source-control-providers-changed'));
    expect(reads).toBe(2);
    await act(async () => source.emit('openchamber:event-stream-ready'));
    expect(reads).toBe(3);
  } finally {
    await act(async () => root.unmount());
    useTrackerAuthStore.getState().resetForRuntimeSwitch();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});

import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { GuestMarkEntry } from '@/lib/guests/marks';
import type { InstalledGuest } from '@/lib/guests/types';

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

const guest = (id: string, overrides: Partial<InstalledGuest> = {}): InstalledGuest => ({
  id,
  name: id,
  icon: 'window',
  source: 'path',
  marks: true,
  capabilities: { requested: ['service', 'marks'], granted: ['service', 'marks'] },
  ...overrides,
});

const mark = (text: string): GuestMarkEntry => ({
  guestId: 'ci',
  target: { sessionId: 'ses_1' },
  mark: { icon: 'check', tone: 'success', text },
});

// Real mounted hook, event module, loader and stores; only the browser stream and the server's answer are fixtures.
test('reads the marks when an extension may show them, on each announced change and on a reconnect, and never otherwise', async () => {
  const dom = new Window({ url: 'http://marks-sync.test' });
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
  let served: GuestMarkEntry[] = [mark('Checks passed')];
  let reads = 0;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // The stores this hook reads start requests of their own when they load; those stay unanswered here.
    if (new URL(address, 'http://marks-sync.test').pathname !== '/api/guests/marks') return new Promise<Response>(() => undefined);
    reads += 1;
    return Response.json({ marks: served });
  });
  const { createRoot } = await import('react-dom/client');
  const { getRuntimeKey } = await import('@/lib/runtime-switch');
  const { useGuestsStore } = await import('@/lib/guests/store');
  const { useGuestMarksStore } = await import('@/lib/guests/marks-store');
  const { useGuestMarksSync } = await import('./useGuestMarksSync');
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  function Probe() {
    useGuestMarksSync();
    return null;
  }
  const catalog = (guests: InstalledGuest[]) => act(async () => { useGuestsStore.getState().replaceCatalog(guests, getRuntimeKey()); });
  const shown = () => [...useGuestMarksStore.getState().bySession.values()].flat().map((entry) => entry.text);
  try {
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    await act(async () => root.render(<Probe />));
    expect(EventSourceFixture.instances).toHaveLength(1);
    const source = EventSourceFixture.instances[0];

    // No extension shows marks: the server is not asked, whatever it announces.
    await catalog([guest('plain', { marks: undefined, capabilities: { requested: [], granted: [] } }), guest('paused', { enabled: false })]);
    await act(async () => source.emit('openchamber:guest-marks-changed'));
    await act(async () => source.emit('openchamber:event-stream-ready'));
    expect(reads).toBe(0);

    // The first extension that may show marks starts the reads.
    await catalog([guest('ci')]);
    expect(reads).toBe(1);
    expect(shown()).toEqual(['Checks passed']);

    // A catalog change that leaves the showing set alone reads nothing.
    await catalog([guest('ci', { name: 'CI Watch' })]);
    expect(reads).toBe(1);

    // A service set a mark: the list is read again.
    served = [mark('Checks failed')];
    await act(async () => source.emit('openchamber:guest-marks-changed'));
    expect(reads).toBe(2);
    expect(shown()).toEqual(['Checks failed']);

    // A reconnect reads again too; an unrelated event does not.
    await act(async () => source.emit('openchamber:guests-changed'));
    expect(reads).toBe(2);
    served = [mark('Checks passed')];
    await act(async () => source.emit('openchamber:event-stream-ready'));
    expect(reads).toBe(3);
    expect(shown()).toEqual(['Checks passed']);

    // Paused: its mark is gone with the catalog change, and the server is left alone again.
    await catalog([guest('ci', { enabled: false })]);
    expect(shown()).toEqual([]);
    await act(async () => source.emit('openchamber:guest-marks-changed'));
    expect(reads).toBe(3);
  } finally {
    await act(async () => root.unmount());
    fetch.mockRestore();
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    useGuestMarksStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});

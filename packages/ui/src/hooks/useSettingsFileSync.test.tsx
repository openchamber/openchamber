import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import type { SettingsSyncedDetail } from '@/lib/persistence';
import { useSettingsFileSync } from './useSettingsFileSync';

class MockEventSource {
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

test('a second file change while the first read is outstanding applies only the newer selection', async () => {
  const dom = new Window({ url: 'http://settings-file.test' });
  Object.assign(dom, {
    __OPENCHAMBER_API_BASE_URL__: 'http://settings-file.test',
    __OPENCHAMBER_LOCAL_ORIGIN__: 'http://settings-file.test',
  });
  let releaseFirstRead: (() => void) | null = null;
  const reads: string[] = [];
  const fetchSettings = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes('/api/config/settings') || init?.method === 'PUT') return Promise.resolve(Response.json({}));
    reads.push(url);
    if (reads.length === 1) {
      return new Promise((resolve) => {
        releaseFirstRead = () => resolve(Response.json({ themeId: 'older-theme' }));
      });
    }
    return Promise.resolve(Response.json({ themeId: 'newer-theme' }));
  };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, Element: dom.Element, HTMLElement: dom.HTMLElement,
    Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
    EventSource: MockEventSource, fetch: fetchSettings, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  switchRuntimeEndpoint({ apiBaseUrl: 'http://settings-file.test', runtimeKey: 'settings-file-sync' });

  const synced: SettingsSyncedDetail[] = [];
  const listener = (event: Event) => {
    if (event instanceof CustomEvent) synced.push(event.detail);
  };
  window.addEventListener('openchamber:settings-synced', listener);

  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Probe() {
    useSettingsFileSync();
    return null;
  }
  const announceFileChange = () => {
    const stream = MockEventSource.instances.at(-1);
    if (!stream) throw new Error('The hook did not open the control stream');
    stream.onmessage?.({ data: JSON.stringify({
      type: 'openchamber:settings-changed', properties: { source: 'preferences', changedKeys: ['themeId'] },
    }) });
  };
  try {
    await act(async () => root.render(<Probe />));

    await act(async () => {
      announceFileChange();
      await flush();
    });
    expect(reads).toHaveLength(1);

    await act(async () => {
      announceFileChange();
      await flush();
      releaseFirstRead?.();
      for (let round = 0; round < 5; round += 1) await flush();
    });

    expect(reads).toHaveLength(2);
    expect(synced.map((detail) => detail.settings.themeId)).toEqual(['newer-theme']);
    expect(synced[0]?.adoptTheme).toBe(true);
    expect(synced[0]?.bootstrap).toBe(false);
  } finally {
    window.removeEventListener('openchamber:settings-synced', listener);
    await act(async () => root.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});

import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { useWebNotificationStream } from './useWebNotificationStream';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import type { NotificationPayload } from '@/lib/api/types';
import { useUIStore } from '@/stores/useUIStore';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { createWebNotificationsAPI } from '../../../web/src/api/notifications';

class EventSourceFixture {
  static CLOSED = 2;
  static instances: EventSourceFixture[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { EventSourceFixture.instances.push(this); }
  close() { this.readyState = EventSourceFixture.CLOSED; }
  emit(properties: NotificationPayload | { title: number }) {
    this.onmessage?.({ data: JSON.stringify({ type: 'openchamber:notification', properties }) });
  }
}

// Real mounted hook and notification API, with only browser boundary fixtures.
test('shares one control stream, deduplicates main-stream delivery, and retires old runtimes', async () => {
  const dom = new Window({ url: 'http://notification.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const delivered: string[] = [];
  class NotificationFixture {
    static permission = 'granted';
    constructor(title: string) { delivered.push(title); }
  }
  const previousSettings = useUIStore.getState();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, CustomEvent: dom.CustomEvent,
    EventSource: EventSourceFixture, Notification: NotificationFixture,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  EventSourceFixture.instances = [];
  const notifications = createWebNotificationsAPI();
  Object.defineProperty(window, '__OPENCHAMBER_RUNTIME_APIS__', { value: { notifications }, configurable: true });
  useUIStore.setState({ nativeNotificationsEnabled: true, notificationMode: 'always' });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  function Probe({ enabled }: { enabled: boolean }) {
    useWebNotificationStream({ enabled });
    return null;
  }
  const unsubscribeControl = subscribeOpenchamberEvents(() => {});
  try {
    await act(async () => root.render(<Probe enabled={false} />));
    expect(EventSourceFixture.instances).toHaveLength(1);
    await act(async () => root.render(<Probe enabled />));
    expect(EventSourceFixture.instances).toHaveLength(1);
    const source = EventSourceFixture.instances[0];
    expect(source.url).toContain('/api/openchamber/events');
    const payload = { title: 'Done', body: 'Ready', sessionId: 'session-one', kind: 'complete', directory: '/repo' };
    await act(async () => {
      source.emit(payload);
      // The main event pipeline forwards these same identity fields to this API.
      await notifications.notifyAgentCompletion(payload);
    });
    expect(delivered).toEqual(['Done']);
    source.emit({ title: 123 });
    expect(delivered).toEqual(['Done']);

    useUIStore.setState({ nativeNotificationsEnabled: false });
    await act(async () => source.emit({ ...payload, title: 'Disabled' }));
    expect(delivered).toEqual(['Done']);
    useUIStore.setState({ nativeNotificationsEnabled: true });

    configureRuntimeUrlResolver({ apiBaseUrl: 'http://other-runtime.test', realtimeBaseUrl: 'http://other-runtime.test' });
    window.dispatchEvent(new CustomEvent('openchamber:runtime-endpoint-changed'));
    expect(source.readyState).toBe(EventSourceFixture.CLOSED);
    expect(EventSourceFixture.instances).toHaveLength(2);
    const next = EventSourceFixture.instances[1];
    expect(next.url).toContain('other-runtime.test');
    await act(async () => {
      source.emit({ ...payload, title: 'Stale' });
      next.emit({ ...payload, title: 'New runtime' });
    });
    expect(delivered).toEqual(['Done', 'New runtime']);

    await act(async () => root.render(<Probe enabled={false} />));
    await act(async () => next.emit({ ...payload, title: 'Unmounted notification listener' }));
    expect(delivered).toEqual(['Done', 'New runtime']);
    expect(next.readyState).toBe(1); // Other control consumers still own it.
  } finally {
    await act(async () => root.unmount());
    unsubscribeControl();
    configureRuntimeUrlResolver({});
    useUIStore.setState({ nativeNotificationsEnabled: previousSettings.nativeNotificationsEnabled, notificationMode: previousSettings.notificationMode });
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});

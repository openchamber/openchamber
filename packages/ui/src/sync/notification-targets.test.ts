import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { NotificationPayload } from '@/lib/api/types';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { classifyStreamPayload } from './event-pipeline';

class ControlStream {
  static CLOSED = 2;
  static current: ControlStream | null = null;
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { ControlStream.current = this; }
  close() { this.readyState = ControlStream.CLOSED; }
  emit(data: string) {
    this.onmessage?.({ data });
  }
}

const botTarget = { projectId: 'project-one', itemId: 'item-one' };
const received: NotificationPayload[] = [];
const originals = new Map<string, PropertyDescriptor | undefined>();
let unsubscribe: () => void;
let dom: Window;
let source: ControlStream;

beforeEach(() => {
  dom = new Window({ url: 'https://notification.test' });
  for (const [name, value] of Object.entries({ window: dom, EventSource: ControlStream })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  received.length = 0;
  ControlStream.current = null;
  unsubscribe = subscribeOpenchamberEvents((event) => {
    if (event.type === 'notification') received.push(event.payload);
  });
  if (!ControlStream.current) throw new Error('Control stream was not opened');
  source = ControlStream.current;
});

afterEach(async () => {
  unsubscribe();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  await dom.happyDOM.close();
});

for (const sessionId of [undefined, 'ses_stage']) {
  test(`the control stream preserves item targets with session=${sessionId}`, () => {
    const payload = { kind: 'bot', botTarget, sessionId };
    const expected: NotificationPayload = { kind: 'bot', botTarget };
    if (sessionId) expected.sessionId = sessionId;

    source.emit(JSON.stringify({ type: 'openchamber:notification', properties: payload }));

    expect(received).toEqual([expected]);
  });

  test(`the main event stream preserves item targets with session=${sessionId}`, () => {
    const properties: NotificationPayload = { kind: 'bot', botTarget };
    if (sessionId) properties.sessionId = sessionId;

    const result = classifyStreamPayload({ type: 'openchamber:notification', properties }, '/repo');

    expect(result).toEqual({ kind: 'events', events: [{ directory: '/repo', event: { type: 'openchamber.notification', properties } }] });
  });
}

for (const target of [null, {}, { ...botTarget, itemId: '../item' }, { ...botTarget, url: 'https://other.test' }]) {
  test(`the control stream rejects malformed targets instead of stripping them: ${JSON.stringify(target)}`, () => {
    source.emit(JSON.stringify({ type: 'openchamber:notification', properties: { kind: 'bot', botTarget: target, sessionId: 'ses_fallback' } }));

    expect(received).toEqual([]);
  });

  test(`the main event stream rejects malformed targets instead of stripping them: ${JSON.stringify(target)}`, () => {
    const result = classifyStreamPayload({ type: 'openchamber:notification', properties: { kind: 'bot', botTarget: target, sessionId: 'ses_fallback' } }, '/repo');

    expect(result).toEqual({ kind: 'events', events: [] });
  });
}

import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { FormRequest, ToolPart } from '@/lib/opencode/model';
import type { State } from '@/sync/types';

// A running turn whose only open form is a deferred plugin question (#5391).
let directoryState: Pick<State, 'form' | 'part'> = { form: {}, part: {} };

mock.module('@/sync/sync-context', () => ({
  useSessionStatus: () => ({ type: 'busy' }),
  useSessionStatusSnapshotReady: () => true,
  useSessionMessagesSelector: () => false,
  useSessionPermissions: () => [],
  useDirectorySync: <T,>(select: (state: typeof directoryState) => T) => select(directoryState),
}));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: () => null }));
// The server read of an unloaded tool call; `serverAnswer` is what the read finds.
let serverAnswer: 'completed' | 'running' | 'failed' = 'completed';
const reads: string[] = [];
mock.module('@/sync/session-actions', () => ({
  readUnloadedFormToolLinks: (sessionId: string) => {
    reads.push(sessionId);
    // What readFormToolLink records once the read returns a completed part.
    if (serverAnswer === 'completed') void Promise.resolve().then(() => recovery.noteFormToolReleased(releaseKey, new Set([releaseKey])));
  },
}));

const { useSessionActivity } = await import('./useSessionActivity');
const recovery = await import('@/sync/recoverable-questions');

const form: FormRequest = {
  id: 'frm_later',
  sessionID: 'ses_a',
  title: 'Questions',
  metadata: { kind: 'question', tool: { messageID: 'msg_ask', id: 'call_ask' } },
  fields: [{ key: 'q0', type: 'string' }],
};

const releaseKey = recovery.formReleaseKey(form, { messageID: 'msg_ask', toolID: 'call_ask' });

const toolPart = (state: ToolPart['state']): ToolPart => ({
  id: 'call_ask', sessionID: 'ses_a', messageID: 'msg_ask', callID: 'call_ask', tool: 'deferred_question', type: 'tool', state,
});
const running = () => toolPart({ status: 'running', input: {}, time: { start: 1 } });
const completed = () => toolPart({ status: 'completed', input: {}, output: '', time: { start: 1, end: 2 } });

let root: Root | null = null;
let host: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();

const Probe: React.FC = () => <span data-id="phase">{useSessionActivity('ses_a', '/repo').phase}</span>;
const phase = () => host.querySelector('[data-id="phase"]')?.textContent ?? null;
const render = () => act(async () => root?.render(<Probe />));

beforeEach(() => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  recovery.resetRecoverableQuestions();
  reads.length = 0;
  serverAnswer = 'completed';
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

test('a form whose tool call is still running holds the composer idle', async () => {
  directoryState = { form: { ses_a: [form] }, part: { msg_ask: [running()] } };
  await render();
  expect(phase()).toBe('idle');
  expect(reads).toEqual([]);
});

test('a form whose tool call completed leaves the running turn busy, so Queue and Stop stay', async () => {
  directoryState = { form: { ses_a: [form] }, part: { msg_ask: [completed()] } };
  await render();
  expect(phase()).toBe('busy');
  expect(reads).toEqual([]);
});

test('an unloaded tool call is read before any send, so a completed one shows the turn busy for the first Enter', async () => {
  directoryState = { form: { ses_a: [form] }, part: {} };
  await render();
  // No send has happened: the hook started the read itself, and its answer already put Stop and Queue back.
  expect(reads).toEqual(['ses_a']);
  expect(phase()).toBe('busy');
});

test('an unloaded tool call the read finds running keeps holding the composer idle', async () => {
  serverAnswer = 'running';
  directoryState = { form: { ses_a: [form] }, part: {} };
  await render();
  expect(reads).toEqual(['ses_a']);
  expect(phase()).toBe('idle');
});

test('a failed read is tried again when the forms are refreshed, not on every render', async () => {
  serverAnswer = 'failed';
  directoryState = { form: { ses_a: [form] }, part: {} };
  await render();
  await render();
  expect(reads).toEqual(['ses_a']);
  expect(phase()).toBe('idle');
  // A reconnect resync stores the same form again as a new array; the server answers now.
  serverAnswer = 'completed';
  directoryState = { form: { ses_a: [{ ...form }] }, part: {} };
  await render();
  expect(reads).toEqual(['ses_a', 'ses_a']);
  expect(phase()).toBe('busy');
});

test('a released form keeps the turn busy however many other forms are read while it is open', async () => {
  directoryState = { form: { ses_a: [form] }, part: {} };
  await render();
  expect(phase()).toBe('busy');
  await act(async () => {
    for (let index = 0; index < 150; index += 1) {
      const other = recovery.formReleaseKey({ ...form, id: `frm_other_${index}` }, { messageID: 'msg_ask', toolID: 'call_ask' });
      recovery.noteFormToolReleased(other, new Set([releaseKey, other]));
    }
  });
  expect(phase()).toBe('busy');
  // The entry stayed: the hook never lost the answer and had to read again.
  expect(reads).toEqual(['ses_a']);
});

test('a form without a tool link holds the composer idle, as before', async () => {
  directoryState = { form: { ses_a: [{ ...form, metadata: undefined }] }, part: {} };
  await render();
  expect(phase()).toBe('idle');
});

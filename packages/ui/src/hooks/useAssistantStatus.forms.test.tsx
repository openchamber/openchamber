import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { FormRequest, ToolPart } from '@/lib/opencode/model';
import type { State } from '@/sync/types';

// A running turn with an open form, either still holding the turn or deferred
// past its tool call (#5391).
let directoryState: Pick<State, 'form' | 'part'> = { form: {}, part: {} };
const NO_MESSAGES: never[] = [];
const NO_SERVERS: never[] = [];

mock.module('@/components/chat/chatColumnSession', () => ({
  useChatSessionSelection: () => ({ sessionId: 'ses_a', directory: '/repo' }),
}));
mock.module('@/sync/sync-context', () => ({
  useSession: () => undefined,
  useSessionMessages: () => NO_MESSAGES,
  useSessionStatus: () => ({ type: 'busy' }),
  useSessionStatusSnapshotReady: () => true,
  useSessionMessagesSelector: () => false,
  useSessionPermissions: () => NO_MESSAGES,
  useDirectorySync: <T,>(select: (state: typeof directoryState) => T) => select(directoryState),
}));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: <T,>(select: (state: { sessionAbortFlags: Map<string, unknown> }) => T) => select({ sessionAbortFlags: new Map() }),
}));
mock.module('@/sync/session-actions', () => ({ readUnloadedFormToolLinks: () => {} }));
mock.module('@/stores/useMcpConfigStore', () => ({
  selectMcpServersForDirectory: () => NO_SERVERS,
  useMcpConfigStore: <T,>(select: (state: { loadMcpConfigs: () => Promise<void> }) => T) => select({ loadMcpConfigs: async () => {} }),
}));

const { useAssistantStatus } = await import('./useAssistantStatus');
const recovery = await import('@/sync/recoverable-questions');

const form: FormRequest = {
  id: 'frm_later',
  sessionID: 'ses_a',
  title: 'Questions',
  metadata: { kind: 'question', tool: { messageID: 'msg_ask', id: 'call_ask' } },
  fields: [{ key: 'q0', type: 'string' }],
};

const toolPart = (state: ToolPart['state']): ToolPart => ({
  id: 'call_ask', sessionID: 'ses_a', messageID: 'msg_ask', callID: 'call_ask', tool: 'deferred_question', type: 'tool', state,
});

let root: Root | null = null;
let host: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();

const Probe: React.FC = () => {
  const { working } = useAssistantStatus();
  return <span data-id="working">{`${working.isWorking}:${working.canAbort}`}</span>;
};
const working = () => host.querySelector('[data-id="working"]')?.textContent ?? null;
const render = () => act(async () => root?.render(<Probe />));

beforeEach(() => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  recovery.resetRecoverableQuestions();
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

test('a form whose tool call completed leaves the turn working with Stop available', async () => {
  directoryState = { form: { ses_a: [form] }, part: { msg_ask: [toolPart({ status: 'completed', input: {}, output: '', time: { start: 1, end: 2 } })] } };
  await render();
  expect(working()).toBe('true:true');
});

test('a form whose tool call is still running pauses the status for the answer', async () => {
  directoryState = { form: { ses_a: [form] }, part: { msg_ask: [toolPart({ status: 'running', input: {}, time: { start: 1 } })] } };
  await render();
  expect(working()).toBe('false:false');
});

import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { Message, Part, Session } from '@/lib/opencode/model';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { recordSessionTimestampEvents, resetSessionActivityTimestamps } from '@/sync/session-activity-timestamps';
import { SessionTimestamps } from '@/components/session/sidebar/sessions/SessionTimestamps';
import { EntryTimes } from './EntryTimes';
import { I18nProvider } from '@/lib/i18n';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { SessionRunDuration } from '@/components/session/sidebar/sessions/SessionRunDuration';

let browser: Window;
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  getSafeStorage().clear();
  resetSessionActivityTimestamps({ reload: false });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const text = () => document.body.textContent ?? '';
const timeCount = () => document.querySelectorAll('time').length;
const render = (content: React.ReactNode) => root.render(<I18nProvider>{content}</I18nProvider>);

test('a finished shell command shows its recorded start and end', async () => {
  const part: Part = {
    id: 'call', sessionID: 's', messageID: 'a', type: 'tool', callID: 'call', tool: 'shell',
    state: { status: 'completed', input: { command: 'ls' }, output: '', time: { start: 1_700_000_000_000, end: 1_700_000_005_000 } },
  };
  await act(async () => render(<EntryTimes part={part} />));
  expect(timeCount()).toBe(2);
  expect(text()).toContain('Started');
  expect(text()).toContain('Ended');
});

test('running thinking shows its start and no invented end', async () => {
  const part: Part = { id: 'r', sessionID: 's', messageID: 'a', type: 'reasoning', text: '', time: { start: 1_700_000_000_000 }, displayTime: { start: 1_700_000_000_000 } };
  await act(async () => render(<EntryTimes part={part} running />));
  expect(timeCount()).toBe(1);
  expect(text()).toContain('In progress');
});

test('history text without its own times says the times are unavailable', async () => {
  const part: Part = { id: 't', sessionID: 's', messageID: 'a', type: 'text', text: 'hi', time: { start: 1, end: 2 }, displayTime: {} };
  await act(async () => render(<EntryTimes part={part} />));
  expect(timeCount()).toBe(0);
  expect(text().match(/Unavailable/g)?.length).toBe(2);
});

test('a user message shows its creation and no separate end', async () => {
  const message: Message = { id: 'u', sessionID: 's', role: 'user', time: { created: 1_700_000_000_000 } };
  await act(async () => render(<EntryTimes message={message} />));
  expect(timeCount()).toBe(1);
  expect(text()).toContain('Unavailable');
});

test('a sidebar row labels all four session times and says which are unavailable', async () => {
  const session: Session = {
    id: 's', projectID: 'p', directory: '/repo', title: 'Session', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  };
  // Default: the row stays as it was; the times wait in the hover card.
  await act(async () => render(<SessionTimestamps session={session} placement="row" />));
  expect(text()).toBe('');
  useSessionDisplayStore.getState().setSessionTimes({ display: 'inline' });
  await act(async () => render(<SessionTimestamps session={session} placement="row" />));
  for (const label of ['Created', 'Last input', 'Last completed output', 'Last activity']) expect(text()).toContain(label);
  expect(text().match(/Unavailable/g)?.length).toBe(2);

  await act(async () => recordSessionTimestampEvents([
    { type: 'message.updated', at: 1_700_000_010_000, properties: { info: { id: 'u', sessionID: 's', role: 'user', time: { created: 1_700_000_010_000 } } } },
  ]));
  expect(text().match(/Unavailable/g)?.length).toBe(1);
});

test('hidden fields leave the row, and the hover copy follows the hover mode only', async () => {
  const session: Session = {
    id: 's2', projectID: 'p', directory: '/repo', title: 'Session', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
  };
  useSessionDisplayStore.getState().setSessionTimes({ display: 'inline', fields: ['created'] });
  await act(async () => render(<SessionTimestamps session={session} placement="row" />));
  expect(text()).toContain('Created');
  expect(text()).not.toContain('Last input');
  await act(async () => render(<SessionTimestamps session={session} placement="hover" />));
  expect(text()).toBe('');
  useSessionDisplayStore.getState().setSessionTimes({ display: 'hover', fields: ['created', 'input', 'output', 'activity'] });
});

test('the last run reads from the last prompt to the last activity, and falls back without a prompt', async () => {
  await act(async () => render(<SessionRunDuration sessionId="run" running={false} fallback="3d" />));
  expect(text()).toBe('3d');
  await act(async () => recordSessionTimestampEvents([
    { type: 'message.updated', at: 1_000, properties: { info: { id: 'u', sessionID: 'run', role: 'user', time: { created: 1_000 } } } },
    { type: 'message.part.delta', at: 76_000, properties: { sessionID: 'run', messageID: 'a', partID: 'p', field: 'text', delta: 'x' } },
  ]));
  expect(text()).toBe('1m 15s');
});

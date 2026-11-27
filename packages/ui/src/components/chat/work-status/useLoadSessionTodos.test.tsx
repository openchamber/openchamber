import { afterEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { RuntimeAPIs } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useSessionTodosStore, type SessionTodo } from '@/stores/useSessionTodosStore';
import { useLoadSessionTodos } from './useLoadSessionTodos';

const unavailable = (): never => { throw new Error('not used'); };
const runtimeApis = (isVSCode: boolean): RuntimeAPIs => ({
  runtime: { platform: isVSCode ? 'vscode' : 'web', isDesktop: false, isVSCode },
  get terminal() { return unavailable(); }, get git() { return unavailable(); },
  get files() { return unavailable(); }, get settings() { return unavailable(); },
  get permissions() { return unavailable(); }, get notifications() { return unavailable(); },
  get sourceControl() { return unavailable(); },
});

type Panel = { sessionId: string; directory: string; shown: boolean };

const Probe: React.FC<Panel> = ({ sessionId, directory, shown }) => {
  useLoadSessionTodos(sessionId, directory, shown);
  return null;
};

// The server side of `/api/session-todos/:id`: records each read and answers with the session's status.
const serveTodos = (status: (sessionId: string) => number = () => 200) => {
  const reads: string[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const sessionId = decodeURIComponent(/\/api\/session-todos\/([^?]+)/.exec(url)?.[1] ?? '');
    reads.push(sessionId);
    const code = status(sessionId);
    if (code !== 200) return new Response('', { status: code });
    return Response.json({ revision: 5, state: 'ready', todos: [{ content: `fresh ${sessionId}`, status: 'pending' }] });
  });
  return { reads, restore: () => fetchSpy.mockRestore() };
};

const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });

const mount = async (panels: Panel[]) => {
  const dom = new Window({ url: 'http://todos.test' });
  const startTimer = dom.setTimeout.bind(dom);
  const started: { id: unknown; delay: number | undefined }[] = [];
  spyOn(dom, 'setTimeout').mockImplementation((...args) => {
    const id = startTimer(...args);
    started.push({ id, delay: args[1] });
    return id;
  });
  const clearTimer = spyOn(dom, 'clearTimeout');
  const timers = () => started.map(({ id, delay }) => ({
    delay,
    cleared: clearTimer.mock.calls.some(([cleared]) => cleared === id),
  }));
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(document.createElement('div'));
  const render = async (next: Panel[]) => {
    await act(async () => root.render(<>{next.map((panel) => <Probe key={panel.sessionId} {...panel} />)}</>));
    await settle();
  };
  await render(panels);
  return {
    timers,
    render,
    unmount: async () => {
      await act(async () => root.unmount());
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
};

const ready = (directory: string, todos: SessionTodo[] = [], failures = 0) => ({ directory, state: 'ready' as const, todos, revision: 1, failures });

afterEach(() => {
  registerRuntimeAPIs(null);
  useSessionTodosStore.getState().reset();
});

test('VS Code, which has no session-todos route, never reads the list', async () => {
  registerRuntimeAPIs(runtimeApis(true));
  const server = serveTodos();
  const panel = await mount([{ sessionId: 'ses_1', directory: '/repo', shown: true }]);
  try {
    expect(server.reads).toEqual([]);
  } finally {
    await panel.unmount();
    server.restore();
  }
});

test('an enabled Tasks section reads its session once when it opens, before it has rows', async () => {
  registerRuntimeAPIs(runtimeApis(false));
  const server = serveTodos();
  const panel = await mount([{ sessionId: 'ses_1', directory: '/repo', shown: false }]);
  try {
    expect(server.reads).toEqual([]);
    await panel.render([{ sessionId: 'ses_1', directory: '/repo', shown: true }]);
    await panel.render([{ sessionId: 'ses_1', directory: '/repo', shown: false }]);
    await panel.render([{ sessionId: 'ses_1', directory: '/repo', shown: true }]);
    expect(server.reads).toEqual(['ses_1']);
  } finally {
    await panel.unmount();
    server.restore();
  }
});

test('a reconnect skips hidden Tasks, and showing them again makes one fresh read', async () => {
  registerRuntimeAPIs(runtimeApis(false));
  useSessionTodosStore.setState({ entries: { ses_shown: ready('/repo'), ses_idle: ready('/idle') } });
  const server = serveTodos();
  const panel = await mount([
    { sessionId: 'ses_shown', directory: '/repo', shown: true },
    { sessionId: 'ses_idle', directory: '/idle', shown: false },
  ]);
  try {
    useSessionTodosStore.getState().refresh(null, () => true);
    await settle();
    expect(server.reads).toEqual(['ses_shown']);

    await panel.render([
      { sessionId: 'ses_shown', directory: '/repo', shown: true },
      { sessionId: 'ses_idle', directory: '/idle', shown: true },
    ]);
    await panel.render([
      { sessionId: 'ses_shown', directory: '/repo', shown: true },
      { sessionId: 'ses_idle', directory: '/idle', shown: true },
    ]);
    expect(server.reads).toEqual(['ses_shown', 'ses_idle']);
    expect(useSessionTodosStore.getState().entries.ses_idle?.todos).toEqual([{ content: 'fresh ses_idle', status: 'pending' }]);
  } finally {
    await panel.unmount();
    server.restore();
  }
});

test('a failed read keeps the list and backs off, and hiding Tasks cancels the retry', async () => {
  registerRuntimeAPIs(runtimeApis(false));
  const shown: SessionTodo[] = [{ content: 'shown before the gap', status: 'in_progress' }];
  useSessionTodosStore.setState({ entries: { ses_1: ready('/repo', shown, 1) } });
  useSessionTodosStore.getState().refresh(null, () => true);
  const server = serveTodos(() => 500);
  const panel = await mount([{ sessionId: 'ses_1', directory: '/repo', shown: true }]);
  try {
    // Stale after the reconnect, so it reads at once despite the earlier failure; that read fails too.
    expect(server.reads).toEqual(['ses_1']);
    expect(useSessionTodosStore.getState().entries.ses_1).toMatchObject({ todos: shown, failures: 2 });
    expect(panel.timers()).toEqual([{ delay: 4000, cleared: false }]);

    await panel.render([{ sessionId: 'ses_1', directory: '/repo', shown: false }]);
    expect(panel.timers()).toEqual([{ delay: 4000, cleared: true }]);
    useSessionTodosStore.getState().refresh(null, () => true);
    await settle();
    expect(server.reads).toEqual(['ses_1']);
  } finally {
    await panel.unmount();
    server.restore();
  }
});

test('a revert reads the session again even when no panel shows it', async () => {
  registerRuntimeAPIs(runtimeApis(false));
  useSessionTodosStore.setState({ entries: { ses_idle: ready('/idle') } });
  const server = serveTodos();
  const panel = await mount([]);
  try {
    useSessionTodosStore.getState().applyEvent({ revision: 2, sessionId: 'ses_idle', directory: '/idle', todos: null }, () => true);
    await settle();
    expect(server.reads).toEqual(['ses_idle']);
  } finally {
    await panel.unmount();
    server.restore();
  }
});

test('a reconnect during a read skips its follow-up when Tasks are hidden before the read ends', async () => {
  registerRuntimeAPIs(runtimeApis(false));
  useSessionTodosStore.setState({ entries: { ses_1: ready('/repo') } });
  useSessionTodosStore.getState().refresh(null, () => true);
  const reads: string[] = [];
  let answer: (() => void) | null = null;
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((input) => {
    reads.push(input instanceof Request ? input.url : String(input));
    return new Promise<Response>((resolve) => {
      answer = () => resolve(Response.json({ revision: 5, state: 'ready', todos: [] }));
    });
  });
  const panel = await mount([{ sessionId: 'ses_1', directory: '/repo', shown: true }]);
  try {
    expect(reads.length).toBe(1);
    useSessionTodosStore.getState().refresh(null, () => true);
    await panel.render([{ sessionId: 'ses_1', directory: '/repo', shown: false }]);
    await act(async () => answer?.());
    await settle();
    expect(reads.length).toBe(1);

    await panel.render([{ sessionId: 'ses_1', directory: '/repo', shown: true }]);
    expect(reads.length).toBe(2);
  } finally {
    await panel.unmount();
    fetchSpy.mockRestore();
  }
});

test('a revert during a read still reads again after Tasks are hidden', async () => {
  registerRuntimeAPIs(runtimeApis(false));
  useSessionTodosStore.setState({ entries: { ses_1: ready('/repo') } });
  useSessionTodosStore.getState().refresh(null, () => true);
  const reads: string[] = [];
  const answers: (() => void)[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((input) => {
    reads.push(input instanceof Request ? input.url : String(input));
    return new Promise<Response>((resolve) => {
      answers.push(() => resolve(Response.json({ revision: 5, state: 'ready', todos: [] })));
    });
  });
  const panel = await mount([{ sessionId: 'ses_1', directory: '/repo', shown: true }]);
  try {
    useSessionTodosStore.getState().applyEvent({ revision: 2, sessionId: 'ses_1', directory: '/repo', todos: null }, () => true);
    await panel.render([{ sessionId: 'ses_1', directory: '/repo', shown: false }]);
    await act(async () => answers[0]?.());
    await settle();
    expect(reads.length).toBe(2);
    await act(async () => answers[1]?.());
  } finally {
    await panel.unmount();
    fetchSpy.mockRestore();
  }
});

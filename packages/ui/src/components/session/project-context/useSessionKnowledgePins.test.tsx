import { afterAll, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://runtime.test' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  Element: browser.Element,
  Node: browser.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

type Pins = { notes: string[]; plans: string[] };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

// Each request waits until the test answers it, so the order of answers is the test's.
const summaries: Array<{ sessionId: string | null; answer: Deferred<{ notes: Array<{ id: string }>; plans: Array<{ id: string }> }> }> = [];
const pinWrites: Array<{ sessionId: string; answer: Deferred<Pins | null> }> = [];
mock.module('@/lib/sessionKnowledgeApi', () => ({
  fetchSessionKnowledgeSummary: (_directory: string | null, sessionId: string | null) => {
    const answer = deferred<{ notes: Array<{ id: string }>; plans: Array<{ id: string }> }>();
    summaries.push({ sessionId, answer });
    return answer.promise;
  },
  setSessionProjectContextPin: (_directory: string, sessionId: string) => {
    const answer = deferred<Pins | null>();
    pinWrites.push({ sessionId, answer });
    return answer.promise;
  },
}));

const session = { id: 'A' };
const listeners = new Set<() => void>();
const sessionState = () => ({
  currentSessionId: session.id,
  currentSessionDirectory: '/project',
  newSessionDraft: { open: false, projectContextPins: undefined },
  setDraftProjectContextPin: () => {},
});
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: <T,>(select: (state: ReturnType<typeof sessionState>) => T): T => {
    const [, force] = React.useReducer((count: number) => count + 1, 0);
    React.useEffect(() => {
      listeners.add(force);
      return () => { listeners.delete(force); };
    }, []);
    return select(sessionState());
  },
}));

const { createRoot } = await import('react-dom/client');
const { useSessionKnowledgePins } = await import('./useSessionKnowledgePins');

let current: ReturnType<typeof useSessionKnowledgePins> | null = null;
const Probe = () => {
  current = useSessionKnowledgePins();
  return null;
};
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
const flush = () => act(async () => { await Promise.resolve(); });
const summaryOf = (plans: string[]) => ({ notes: [], plans: plans.map((id) => ({ id })) });

afterAll(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('a read that started before a pin does not undo it', async () => {
  await act(async () => root.render(<Probe />));
  const before = summaries.at(-1)!;
  let toggled: Promise<boolean> | undefined;
  act(() => { toggled = current!.togglePin('plan', 'p1', true); });
  pinWrites.at(-1)!.answer.resolve({ notes: [], plans: ['p1'] });
  await act(async () => { await toggled; });
  expect([...current!.pinnedPlanIds]).toEqual(['p1']);

  // The read sent before the pin answers last, with the state before it.
  before.answer.resolve(summaryOf([]));
  await flush();
  expect([...current!.pinnedPlanIds]).toEqual(['p1']);
});

test("a pin that finishes after a session switch leaves the new session's pins alone", async () => {
  let toggled: Promise<boolean> | undefined;
  act(() => { toggled = current!.togglePin('plan', 'p2', true); });
  const write = pinWrites.at(-1)!;

  session.id = 'B';
  await act(async () => { for (const listener of listeners) listener(); });
  summaries.at(-1)!.answer.resolve(summaryOf(['b1']));
  await flush();
  expect([...current!.pinnedPlanIds]).toEqual(['b1']);

  write.answer.resolve({ notes: [], plans: ['p1', 'p2'] });
  await act(async () => { await toggled; });
  expect([...current!.pinnedPlanIds]).toEqual(['b1']);
});

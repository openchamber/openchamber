import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { opencodeClient } from '@/lib/opencode/client';
import type { FormRequest, Message, Part, Session } from '@/lib/opencode/model';
import { SyncProvider, useDirectoryStore } from '@/sync/sync-context';
import type { State } from '@/sync/types';
import { markOrphanedQuestionDismissed } from './orphanedQuestions';
import { useOrphanedQuestions } from './useOrphanedQuestions';

const DIRECTORY = '/orphaned-hook';
const SESSION_ID = 'ses_orphaned';
const EMPTY_FORMS: FormRequest[] = [];
const sdk = OpenCode.make({
  baseUrl: 'https://sync.test',
  // Hold bootstrap reads so each test controls authoritative state transitions.
  fetch: () => new Promise<Response>(() => undefined),
});
const assistant: Message = {
  id: 'msg_assistant', sessionID: SESSION_ID, role: 'assistant', time: { created: 1 },
  agent: 'build', providerID: 'provider', modelID: 'model',
};
const session = (metadata: Session['metadata'] = {}): Session => ({
  id: SESSION_ID, projectID: 'project', directory: DIRECTORY, title: 'Question',
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 }, metadata,
});
const questionPart = (text = 'Which mode?', status: 'running' | 'error' = 'running'): Part => {
  const input = { questions: [{ question: text, header: 'Mode', options: [] }] };
  return {
    id: 'prt_question', messageID: assistant.id, sessionID: SESSION_ID,
    type: 'tool', callID: 'call_question', tool: 'question',
    state: status === 'running'
      ? { status, input, time: { start: 1 } }
      : { status, input, error: 'Tool execution interrupted', time: { start: 1, end: 2 } },
  };
};

let directoryStore: ReturnType<typeof useDirectoryStore> | undefined;
let reading: ReturnType<typeof useOrphanedQuestions> | undefined;
let dom: ReturnType<typeof installHookTestDom>;
let root: Root;
let restoreSpies: Array<() => void>;
let previousSurface: typeof window.__OPENCHAMBER_SURFACE__;

const Probe = ({ forms, sessionId, directory }: {
  forms: FormRequest[]; sessionId: string | null; directory: string;
}) => {
  directoryStore = useDirectoryStore(directory, { bootstrap: false });
  reading = useOrphanedQuestions(sessionId, directory, forms);
  return null;
};
const result = () => {
  if (!reading) throw new Error('The hook must be mounted before reading its result');
  return reading;
};
const render = async (forms = EMPTY_FORMS, sessionId: string | null = SESSION_ID, directory = DIRECTORY) => {
  await act(async () => root.render(
    <SyncProvider sdk={sdk} directory="">
      <Probe forms={forms} sessionId={sessionId} directory={directory} />
    </SyncProvider>,
  ));
};
const publish = async (state: Partial<State>) => {
  const store = directoryStore;
  if (!store) throw new Error('The directory must be mounted before publishing');
  await act(async () => store.setState(state));
};
const seed = async (ready = true, part = questionPart()) => publish({
  session: [session()], message: { [SESSION_ID]: [assistant] }, part: { [assistant.id]: [part] },
  sessionStatusReady: ready, session_status: {},
});

beforeEach(() => {
  dom = installHookTestDom(new Window().localStorage);
  previousSurface = window.__OPENCHAMBER_SURFACE__;
  window.__OPENCHAMBER_SURFACE__ = 'desktop';
  const spies = [
    spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined)),
    spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home' }),
    spyOn(opencodeClient, 'getFilesystemHome').mockResolvedValue('/home'),
    spyOn(opencodeClient, 'getLocation').mockResolvedValue({
      directory: DIRECTORY, project: { id: 'project', directory: DIRECTORY, canonical: DIRECTORY },
    }),
    spyOn(opencodeClient, 'getConfig').mockResolvedValue({}),
    spyOn(opencodeClient, 'listProjects').mockResolvedValue([]),
  ];
  restoreSpies = spies.map((spy) => () => spy.mockRestore());
  reading = undefined;
  directoryStore = undefined;
  root = createRoot(dom.container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  restoreSpies.forEach((restore) => restore());
  window.__OPENCHAMBER_SURFACE__ = previousSurface;
  dom.restore();
});

test('keeps recovered questions and refresh stable across unrelated parent and store updates', async () => {
  await render();
  await seed();
  const { questions, refresh } = result();
  expect(questions).toHaveLength(1);

  await render();
  await publish({ session: [session()], message: { [SESSION_ID]: [assistant] } });
  expect(result().questions).toBe(questions);
  expect(result().refresh).toBe(refresh);
});

test('refresh reads local dismissals even when every sync input is unchanged', async () => {
  await render();
  await seed();
  const { questions, refresh } = result();
  expect(questions).toHaveLength(1);
  markOrphanedQuestionDismissed('call_question');

  await act(async () => refresh());
  expect(result().questions).toEqual([]);
  expect(result().questions).not.toBe(questions);
  const dismissed = result().questions;
  await render();
  expect(result().questions).toBe(dismissed);
});

test('follows authoritative status, live forms, same-id part changes and the latest message', async () => {
  await render();
  await seed(false);
  expect(result().questions).toEqual([]);
  await publish({ sessionStatusReady: true });
  expect(result().questions).toHaveLength(1);
  await publish({ sessionStatusInvalidated: { [SESSION_ID]: true } });
  expect(result().questions).toEqual([]);
  await publish({ sessionStatusInvalidated: {}, session_status: { [SESSION_ID]: { type: 'busy' } } });
  expect(result().questions).toEqual([]);
  await publish({ session_status: {} });
  expect(result().questions).toHaveLength(1);

  await render([{
    id: 'form_live', sessionID: SESSION_ID, title: 'Questions',
    fields: [{ key: 'q0', type: 'string', title: 'Mode', description: 'Which mode?', options: [] }],
    metadata: { kind: 'question', tool: { messageID: assistant.id, id: 'call_question' } },
  }]);
  expect(result().questions).toEqual([]);
  await render();
  expect(result().questions).toHaveLength(1);
  await publish({ part: { [assistant.id]: [questionPart('Which color?')] } });
  expect(result().questions[0]?.questions[0]?.question).toBe('Which color?');

  await publish({ message: { [SESSION_ID]: [assistant, {
    id: 'msg_user', sessionID: SESSION_ID, role: 'user', time: { created: 2 },
  }] } });
  expect(result().questions).toEqual([]);
});

test('follows interruption records and does not retain questions across session or directory changes', async () => {
  await render();
  await seed(true, questionPart('Which mode?', 'error'));
  expect(result().questions).toEqual([]);
  await publish({ session: [session({ openchamber: { interruption: { reason: 'inactivity', at: 200 } } })] });
  expect(result().questions[0]?.cause).toEqual({ kind: 'inactivity', at: 200 });
  await publish({ session: [session({ openchamber: { restartCutTurn: {
    messageID: assistant.id, callID: 'call_question', toolName: 'question', at: 300,
  } } })] });
  expect(result().questions[0]?.cause).toEqual({ kind: 'opencode-restart', at: 300 });
  await publish({ session: [session({ openchamber: { pendingQuestion: {
    messageID: assistant.id, callID: 'call_question', title: 'Mode', cause: 'inactivity', at: 400,
  } } })] });
  expect(result().questions[0]?.cause).toEqual({ kind: 'inactivity', at: 400 });

  await render(EMPTY_FORMS, null);
  expect(result().questions).toEqual([]);
  await render();
  expect(result().questions).toHaveLength(1);
  await render(EMPTY_FORMS, SESSION_ID, '/other-worktree');
  expect(result().questions).toEqual([]);
  await seed();
  expect(result().questions[0]?.cause).toEqual({ kind: 'unknown' });
});

/**
 * The export's own writing.
 *
 * The export reads every session from the directory it runs in. A descendant
 * that runs in another directory lives in another session store, so the
 * root's directory would never find its records — and the document would
 * say the transcript could not be loaded.
 */

import { afterAll, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import type { SessionMessageRecord } from '@/lib/exportSession';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLButtonElement: browser.HTMLButtonElement,
  Event: browser.Event, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
  KeyboardEvent: browser.KeyboardEvent, FocusEvent: browser.FocusEvent,
  localStorage: browser.localStorage,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

mock.module('@/components/ui', () => ({
  toast: { error: () => undefined, success: () => undefined, warning: () => undefined },
}));

/** The records every directory holds, keyed by the session they belong to. */
const recordsByDirectory = new Map<string, Map<string, SessionMessageRecord[]>>();

/** The reads the export made, in the order it made them. */
const recordReads: Array<{ directory: string; sessionID: string }> = [];

mock.module('@/sync/use-sync', () => ({
  useSessionMessageRecordsForExport: () => async ({ directory, sessionID }: { directory: string; sessionID: string }) => {
    recordReads.push({ directory, sessionID });
    return recordsByDirectory.get(directory)?.get(sessionID) ?? null;
  },
}));

/** The document the export wrote. */
let writeDocument: (content: string) => void = () => undefined;

const exportSession = await import('@/lib/exportSession');
mock.module('@/lib/exportSession', () => ({
  ...exportSession,
  saveAsMarkdownDesktop: async (content: string) => {
    writeDocument(content);
    return '/tmp/export.md';
  },
}));

const { I18nProvider } = await import('@/lib/i18n');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { useSessionExport } = await import('./useSessionExport');

afterAll(() => {
  browser.close();
});

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id,
  projectID: 'proj_1',
  directory: '/repo',
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  ...overrides,
});

const textRecord = (sessionID: string, id: string, content: string, created: number): SessionMessageRecord => ({
  info: { id, sessionID, role: 'user', time: { created } },
  parts: [{ id: `${id}-text`, sessionID, messageID: id, type: 'text', text: content }],
});

const answerRecord = (sessionID: string, id: string, content: string, created: number): SessionMessageRecord => ({
  info: {
    id, sessionID, role: 'assistant', agent: 'reviewer',
    providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created, completed: created + 100 },
  },
  parts: [{ id: `${id}-text`, sessionID, messageID: id, type: 'text', text: content }],
});

/** The call that started a child session. */
const delegationRecord = (
  sessionID: string,
  id: string,
  childSessionID: string,
  created: number,
): SessionMessageRecord => ({
  info: {
    id, sessionID, role: 'assistant', agent: 'build',
    providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created, completed: created + 100 },
  },
  parts: [{
    id: `${id}-subagent`, sessionID, messageID: id, type: 'tool', callID: `${id}-call`, tool: 'subagent',
    state: {
      status: 'completed',
      input: { description: 'Review the change', prompt: 'Review the whole change', agent: 'reviewer' },
      output: 'The review found blocking defects.',
      metadata: { sessionID: childSessionID },
      time: { start: created, end: created + 100 },
    },
  }],
});

const rootRecords: SessionMessageRecord[] = [
  textRecord('ses_root', 'u1', 'Do the work', 1000),
  delegationRecord('ses_root', 'a1', 'ses_child', 2000),
];

const childRecords: SessionMessageRecord[] = [
  textRecord('ses_child', 'cu1', 'Review the change', 2100),
  answerRecord('ses_child', 'ca2', 'Verdict: changes required.', 2500),
];

/** The child's records, with the call that started the grandchild. */
const childRecordsWithGrandchild: SessionMessageRecord[] = [
  textRecord('ses_child', 'cu1', 'Review the change', 2100),
  delegationRecord('ses_child', 'ca1', 'ses_grand', 2200),
  answerRecord('ses_child', 'ca2', 'Verdict: changes required.', 2500),
];

const grandRecords: SessionMessageRecord[] = [
  answerRecord('ses_grand', 'ga1', 'Deeper work', 2300),
];

/** Puts the sessions into the store, the way the app holds them. */
const setSessions = (sessions: Session[]): void => {
  useGlobalSessionsStore.setState({
    activeSessions: [],
    archivedSessions: [],
    sessionsByDirectory: new Map(),
    entityById: new Map(),
    structure: {
      activeSessionIds: [],
      activeRootIds: [],
      activeChildrenByParentId: new Map(),
      activeIdsByDirectory: new Map(),
    },
    hasLoaded: true,
    status: 'ready',
  });
  useGlobalSessionsStore.getState().upsertSessions(sessions);
};

/**
 * Puts the records into the directories they live in.
 *
 * A session store holds the records of the sessions that run in its own
 * directory, so a record read from the wrong directory finds nothing.
 */
const setRecords = (entries: Array<[directory: string, sessionID: string, records: SessionMessageRecord[]]>): void => {
  recordsByDirectory.clear();
  recordReads.length = 0;
  for (const [directory, sessionID, records] of entries) {
    const bySession = recordsByDirectory.get(directory) ?? new Map<string, SessionMessageRecord[]>();
    bySession.set(sessionID, records);
    recordsByDirectory.set(directory, bySession);
  }
};

/**
 * Exports a session and hands back the document it wrote.
 *
 * The dialog is opened and confirmed, the way a reader does it, so the test
 * reads what the export writes.
 */
const exportSessionTo = async (target: { sessionID: string; directory: string }): Promise<string> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let open: (next: { sessionID: string; title: string; directory: string }) => void = () => undefined;
  const written = new Promise<string>((resolve) => { writeDocument = resolve; });

  const ExportApi = () => {
    const api = useSessionExport();
    open = api.openExport;
    return <>{api.dialog}</>;
  };

  const Harness = () => (
    <I18nProvider>
      <ExportApi />
    </I18nProvider>
  );

  await act(async () => {
    root.render(<Harness />);
  });

  await act(async () => {
    open({ sessionID: target.sessionID, title: 'Root', directory: target.directory });
  });

  const confirm = [...container.querySelectorAll<HTMLElement>('button')].find((candidate) => (
    candidate.textContent?.trim() === 'Export'
  ));
  expect(confirm).toBeTruthy();
  await act(async () => {
    confirm?.click();
  });

  return written;
};

describe('the export reads every session from its own directory', () => {
  test('a descendant in another directory is loaded', async () => {
    setRecords([
      ['/repo', 'ses_root', rootRecords],
      ['/other', 'ses_child', childRecords],
    ]);
    setSessions([
      session('ses_root', { title: 'Root', directory: '/repo' }),
      session('ses_child', { title: 'Child', parentID: 'ses_root', directory: '/other' }),
    ]);

    const document = await exportSessionTo({ sessionID: 'ses_root', directory: '/repo' });

    // The child runs in another directory, so its records live in another
    // session store. Read from the root's directory there is nothing there.
    expect(recordReads.some((read) => read.directory === '/other' && read.sessionID === 'ses_child')).toBe(true);
    expect(document).toContain('Verdict: changes required.');
    expect(document).not.toContain('Incomplete export');
  });

  test('a nested descendant is loaded from its own directory', async () => {
    setRecords([
      ['/repo', 'ses_root', rootRecords],
      ['/other', 'ses_child', childRecordsWithGrandchild],
      ['/third', 'ses_grand', grandRecords],
    ]);
    setSessions([
      session('ses_root', { title: 'Root', directory: '/repo' }),
      session('ses_child', { title: 'Child', parentID: 'ses_root', directory: '/other' }),
      session('ses_grand', { title: 'Grand', parentID: 'ses_child', directory: '/third' }),
    ]);

    const document = await exportSessionTo({ sessionID: 'ses_root', directory: '/repo' });

    expect(recordReads.some((read) => read.directory === '/third' && read.sessionID === 'ses_grand')).toBe(true);
    expect(document).toContain('Deeper work');
    expect(document).not.toContain('Incomplete export');
  });
});

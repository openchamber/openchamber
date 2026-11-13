import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { botItem } from '@/lib/bots/bots.fixture';
import { deferred, installSuggestedTasksDom } from '@/lib/test-utils/suggestedTasks.fixture';

const dom = installSuggestedTasksDom();
const originalFetch = globalThis.fetch;
const item = botItem({ worktree: '/host/item-worktree', sessions: { investigation: 'ses_read', fixing: 'ses_fix', judge: 'ses_judge' } });
let respond: () => Response | Promise<Response>;
let detailReads = 0;
// Only the HTTP boundary is replaced; the component, parser and selection store are real.
// Install before store imports so their startup reads use the same test transport.
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
  const path = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
  if (path.endsWith(`/items/${item.id}`)) { detailReads += 1; return respond(); }
  if (path === '/api/fs/home') return Response.json({ home: '/home/test', chatsRoot: '/home/test/chats' });
  return Response.json({});
}, originalFetch);
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { BotItemDetail } = await import('./BotItemDetail');
const originalProjects = useProjectsStore.getState();
const originalSessionUI = useSessionUIStore.getState();
let root: Root;
let left = 0;

beforeEach(() => {
  respond = () => Response.json({ item, reports: {}, snapshot: null });
  detailReads = 0;
  left = 0;
  // Main's selection owner admits known projects/worktrees and valid isolated-space addresses.
  useProjectsStore.setState({ projects: ['/before', '/host/project'].map((path) => ({ id: path, path })) });
  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null, availableWorktreesByProject: new Map([
    ['/host/project', [{ path: '/host/captured-checkout', projectDirectory: '/host/project', branch: 'bot-item', label: 'Bot item' }]],
  ]) });
  useSessionUIStore.getState().setCurrentSession('ses_before', '/before');
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => {
  await act(async () => root.unmount());
  useProjectsStore.setState(originalProjects, true);
  useSessionUIStore.setState(originalSessionUI, true);
  document.body.replaceChildren();
});
afterAll(async () => { globalThis.fetch = originalFetch; await dom.restore(); });

const button = (label: string) => {
  const element = [...document.querySelectorAll('button')].find((entry) => entry.textContent === label);
  if (!(element instanceof HTMLButtonElement)) throw new TypeError(`Missing button: ${label}`);
  return element;
};
const renderDetail = async (archived = false) => {
  await act(async () => root.render(<I18nProvider><BotItemDetail projectId="project-1" initial={item} archived={archived} onBack={() => {}} onLeave={() => { left += 1; }} /></I18nProvider>));
};

describe('Bot stage session navigation', () => {
  for (const archived of [false, true]) {
    for (const directory of ['/spaces/012345abcdef/project', '/host/captured-checkout']) {
      for (const sessionId of ['ses_read', 'ses_fix', 'ses_judge'] as const) {
        test(`opens ${sessionId} at its captured ${directory} directory when archived=${archived}`, async () => {
          // Given stage-specific server addresses that differ from the item's host worktree.
          const sessionDirectories = { ses_read: `${directory}/investigation`, ses_fix: `${directory}/fixing`, ses_judge: `${directory}/judge` };
          respond = () => Response.json({ item, reports: {}, snapshot: null, sessionDirectories });
          await renderDetail(archived);

          // When the corresponding session link is clicked.
          await act(async () => button(sessionId).click());

          // Then selection uses that session's captured address and leaves the detail once.
          expect(useSessionUIStore.getState().currentSessionId).toBe(sessionId);
          expect(useSessionUIStore.getState().currentSessionDirectory).toBe(sessionDirectories[sessionId]);
          expect(left).toBe(1);
          expect(detailReads).toBe(1);
        });
      }
    }
  }

  for (const sessionDirectories of [undefined, {}, { ses_other: '/spaces/other/project' }, { ses_read: '' }]) {
    test(`keeps unknown sessions disabled when the projection is ${JSON.stringify(sessionDirectories)}`, async () => {
      // Given a detail response with no usable address for the visible stage session.
      respond = () => Response.json({ item, reports: {}, snapshot: null, sessionDirectories });
      await renderDetail();
      expect(button('Refresh').disabled).toBe(false);

      // When the user attempts to open that session.
      await act(async () => button('ses_read').click());

      // Then no host guess is selected and the detail remains open.
      expect(button('ses_read').disabled).toBe(true);
      expect(useSessionUIStore.getState().currentSessionId).toBe('ses_before');
      expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/before');
      expect(left).toBe(0);
    });
  }

  test('keeps a session disabled when its ID is only an inherited record property', async () => {
    // Given an empty projection and an ID that also names an Object prototype property.
    respond = () => Response.json({ item: botItem({ worktree: '/host/item-worktree', sessions: { investigation: 'constructor' } }), reports: {}, snapshot: null, sessionDirectories: {} });
    await renderDetail();
    expect(button('Refresh').disabled).toBe(false);

    // When that session link is clicked.
    await act(async () => button('constructor').click());

    // Then only actual projected entries can authorize session selection.
    expect(button('constructor').disabled).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('ses_before');
    expect(left).toBe(0);
  });

  test('keeps stage links disabled when the authoritative detail is still loading', async () => {
    // Given a pending HTTP response and an initial item that already names a host worktree.
    const started = deferred<void>();
    const response = deferred<Response>();
    respond = () => { started.resolve(); return response.promise; };
    await renderDetail();
    await started.promise;

    try {
      // When the user attempts navigation before the captured directory arrives.
      await act(async () => button('ses_read').click());

      // Then the link has no authority to change the current selection.
      expect(button('ses_read').disabled).toBe(true);
      expect(useSessionUIStore.getState().currentSessionId).toBe('ses_before');
      expect(left).toBe(0);
    } finally {
      await act(async () => response.resolve(Response.json({ item, reports: {}, snapshot: null })));
    }
  });

  test('keeps archived stage links disabled when detail has no projected directory', async () => {
    // Given an archived item whose retained worktree does not establish stage addresses.
    await renderDetail(true);

    // When the archived session link is clicked.
    await act(async () => button('ses_read').click());

    // Then the single inspection read cannot authorize a host or current-directory guess.
    expect(button('ses_read').disabled).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('ses_before');
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/before');
    expect(left).toBe(0);
    expect(detailReads).toBe(1);
  });

  for (const status of [200, 503]) {
    test(`keeps archived navigation disabled when the directory projection fails with HTTP ${status}`, async () => {
      // Given a malformed successful projection or a failed response carrying an otherwise valid address.
      respond = () => Response.json({ item, reports: {}, snapshot: null, sessionDirectories: { ses_read: status === 200 ? '' : '/spaces/untrusted/project' } }, { status });
      await renderDetail(true);

      // When the user attempts to open the retained session.
      await act(async () => button('ses_read').click());

      // Then failed authority stays visible and cannot navigate anywhere.
      expect(document.querySelector('[role="alert"]')).not.toBeNull();
      expect(button('ses_read').disabled).toBe(true);
      expect(useSessionUIStore.getState().currentSessionId).toBe('ses_before');
      expect(useSessionUIStore.getState().currentSessionDirectory).toBe('/before');
      expect(left).toBe(0);
      expect(detailReads).toBe(1);
    });
  }
});

describe('Archived Bot inspection', () => {
  test('shows retained evidence, stage reports and diff when archived detail loads', async () => {
    // Given retained detail that contains evidence absent from the archive list item.
    const evidence = { source: 'retained-proof', summary: 'Parser failure reproduced before the fix' };
    const reports = { investigation: { finding: 'Retained investigation' }, fixing: { result: 'Retained correction' }, judge: { reason: 'Retained review' } };
    const snapshot = { baseSha: 'retained-base', headSha: 'retained-head', diff: 'diff --git a/parser.ts b/parser.ts\n-before\n+after', changes: [{ oldPath: 'parser.ts', newPath: 'parser.ts' }] };
    respond = () => Response.json({ item: { ...item, evidence: [evidence] }, reports, snapshot });

    // When the archived detail is opened and its native report disclosures are expanded.
    await renderDetail(true);
    await act(async () => { for (const summary of document.querySelectorAll<HTMLElement>('details > summary')) summary.click(); });

    // Then every retained report and the recorded diff can be read in the existing detail.
    expect(document.body.textContent).toContain(evidence.summary);
    expect([...document.querySelectorAll('details[open] pre')].map((entry) => entry.textContent)).toEqual(Object.values(reports).map((report) => JSON.stringify(report, null, 2)));
    expect([...document.querySelectorAll('pre')].map((entry) => entry.textContent)).toContain(snapshot.diff);
    expect(detailReads).toBe(1);
  });

  for (const state of ['needs-you', 'waiting-answer'] as const) {
    test(`keeps mutation controls absent when retained detail records ${state}`, async () => {
      // Given an archive record that retains a state which normally offers mutations.
      const retained = { ...item, state, title: `Retained ${state}` };
      respond = () => Response.json({ item: retained, reports: {}, snapshot: null });

      // When the archived detail loads through the real HTTP parser.
      await renderDetail(true);

      // Then archived inspection exposes no resume, answer, stop or refresh action.
      expect(document.querySelector('h2')?.textContent).toBe(retained.title);
      const labels = [...document.querySelectorAll('button')].map((entry) => entry.textContent);
      expect(labels.filter((label) => ['Resume', 'Send answer', 'Stop item', 'Refresh'].includes(label ?? ''))).toEqual([]);
      expect(document.querySelector('textarea')).toBeNull();
      expect(detailReads).toBe(1);
    });
  }
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createOpencodeClient, type Session } from '@opencode-ai/sdk/v2';
import { useUIStore } from '@/stores/useUIStore';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';
let WorkStatusSubagentsSection: typeof import('./WorkStatusSubagentsSection').WorkStatusSubagentsSection;

const directory = '/repo';
const parentId = 'parent-1';
const childId = 'child-1';
const otherId = 'other-1';

const makeSession = (id: string, parentID: string | undefined, created: number, updated: number, cost?: number): Session => {
  const session: Session = {
    id, slug: id, projectID: 'project', directory, title: id, version: '1', time: { created, updated }, parentID,
  };
  if (cost !== undefined) session.cost = cost;
  return session;
};

const parent = makeSession(parentId, undefined, 0, 0);
const child = makeSession(childId, parentId, 1, 1);
const other = makeSession(otherId, undefined, 2, 2);

const childPermission: PermissionRequest = {
  id: 'permission-1', sessionID: childId, permission: 'write', patterns: [], metadata: {}, always: [],
};
const otherPermission: PermissionRequest = {
  id: 'permission-2', sessionID: otherId, permission: 'write', patterns: [], metadata: {}, always: [],
};
const childQuestion: QuestionRequest = {
  id: 'question-1', sessionID: childId, questions: [{ question: 'Proceed?', header: 'Confirm', options: [] }],
};

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLIFrameElement', 'localStorage', 'getComputedStyle', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, HTMLIFrameElement: win.HTMLIFrameElement, localStorage: win.localStorage,
    getComputedStyle: win.getComputedStyle.bind(win), ResizeObserver: win.ResizeObserver,
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      void win.happyDOM.close();
    },
  };
};

describe('mounted subagents section with live sync stores', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  let commits = 0;
  // Keep bootstrap pending so each test controls real store publications.
  const sdk = createOpencodeClient({ baseUrl: 'http://subagents.test', fetch: () => new Promise<Response>(() => undefined) });

  const store = (dir = directory) => {
    const result = getSyncChildStores().getChild(dir);
    if (!result) throw new Error('Expected mounted directory store');
    return result;
  };

  const render = async () => {
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={directory}>
        <I18nProvider>
          <React.Profiler id="subagents" onRender={() => { commits += 1; }}>
            <WorkStatusSubagentsSection sessionId={parentId} directory={directory} />
          </React.Profiler>
        </I18nProvider>
      </SyncProvider>,
    ));
  };

  beforeEach(async () => {
    dom = installDom();
    ({ WorkStatusSubagentsSection } = await import('./WorkStatusSubagentsSection'));
    root = createRoot(dom.container);
    commits = 0;
    useUIStore.setState({ isMobile: false, workStatusExpandedSections: { subagents: true } });
    await render();
    await act(async () => store().setState({ session: [parent, child, other], session_status: {} }));
    commits = 0;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
  });

  test('renders one row per child of the requested session', () => {
    expect(dom.container.textContent).toContain(childId);
    expect(dom.container.textContent).not.toContain(otherId);
  });

  // Both the child list and the cost rollup are read from one directory store
  // and subscribe only to its `session`/`session_status`/blocker slices, so a
  // metadata-only publication for a session that is not a child resolves to the
  // same cached snapshot and React bails out.
  test('an unrelated session time.updated bump does not re-render the section', async () => {
    commits = 0;
    await act(async () => store().setState({
      session: [parent, child, { ...other, time: { created: 2, updated: 99 } }],
    }));
    expect(commits).toBe(0);
  });

  test('an unrelated session status update does not re-render the section', async () => {
    commits = 0;
    await act(async () => store().setState({ session_status: { [otherId]: { type: 'busy' } } }));
    expect(commits).toBe(0);
  });

  test('an unrelated permission request does not re-render the section', async () => {
    commits = 0;
    await act(async () => store().setState({ permission: { [otherId]: [otherPermission] } }));
    expect(commits).toBe(0);
  });

  test('a child status change re-renders the section with its busy state', async () => {
    commits = 0;
    await act(async () => store().setState({ session_status: { [childId]: { type: 'busy' } } }));
    expect(commits).toBeGreaterThan(0);
    expect(dom.container.textContent).toContain('is working');
  });

  test('a child permission request re-renders the section as blocked', async () => {
    commits = 0;
    await act(async () => store().setState({ permission: { [childId]: [childPermission] } }));
    expect(commits).toBeGreaterThan(0);
    expect(dom.container.textContent).toContain('needs permission');
  });

  test('a child question re-renders the section as asking', async () => {
    commits = 0;
    await act(async () => store().setState({ question: { [childId]: [childQuestion] } }));
    expect(commits).toBeGreaterThan(0);
    expect(dom.container.textContent).toContain('asked a question');
  });

  test('a new child appearing re-renders and a removed child disappears', async () => {
    const sibling = makeSession('child-2', parentId, 3, 3);
    commits = 0;
    await act(async () => store().setState({ session: [parent, child, sibling, other] }));
    expect(commits).toBeGreaterThan(0);
    expect(dom.container.textContent).toContain('child-2');
    // Rows order by stable `time.created` desc (newest first), so the later
    // child-2 (created 3) renders above child-1 (created 1).
    const rendered = dom.container.textContent ?? '';
    expect(rendered.indexOf('child-2')).toBeLessThan(rendered.indexOf('child-1'));

    // Now bump child-1's `time.updated` past child-2's (99 > 3) while leaving
    // `time.created` unchanged (1 < 3). The section ignores `time.updated`-only
    // changes, so it must not re-render and the stable order must hold. A
    // comparator regressed to volatile `time.updated` would fail on both counts:
    // the snapshot would change (commits > 0) and child-1 would sort above
    // child-2.
    commits = 0;
    await act(async () => store().setState({
      session: [parent, { ...child, time: { created: 1, updated: 99 } }, sibling, other],
    }));
    expect(commits).toBe(0);
    const afterUpdatedBump = dom.container.textContent ?? '';
    expect(afterUpdatedBump.indexOf('child-2')).toBeLessThan(afterUpdatedBump.indexOf('child-1'));

    commits = 0;
    await act(async () => store().setState({ session: [parent, other] }));
    expect(commits).toBeGreaterThan(0);
    expect(dom.container.textContent).not.toContain(childId);
  });

  // A child's spend is a rendered value, so the scoped cost rollup must not
  // swallow a real cost change: this keeps the same child identity, title and
  // busy state, and only the cost differs.
  test('a child session cost change re-renders the section with its cost', async () => {
    commits = 0;
    await act(async () => store().setState({
      session: [parent, makeSession(childId, parentId, 1, 1, 1.5), other],
    }));
    expect(commits).toBeGreaterThan(0);
    expect(dom.container.textContent).toContain('$1.5');
  });
});

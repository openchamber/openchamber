import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Session } from '@/lib/opencode/model';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { useGoalEditStore } from '@/stores/useGoalEditStore';
import { useUIStore } from '@/stores/useUIStore';

// React DOM and the Base UI dialog probe for a DOM when first imported; without
// one the dialog never mounts its popup. Give the probe a document, then
// restore the caller's globals.
const importWindow = new Window();
const importGlobals = ['window', 'document'] as const;
const previousImportGlobals = importGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: importWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: importWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { SessionGoalDialog } = await import('./SessionGoalDialog');
for (const [name, descriptor] of previousImportGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
void importWindow.happyDOM.close();

const directory = '/repo';
const sessionId = 'session-1';
// A streamed step replaces the session record; an active goal's usage moves
// with it.
const session = (updated: number, turnsUsed: number): Session => ({
  id: sessionId, projectID: 'project', directory, title: 'test', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated },
  metadata: { openchamber: { goal: { id: 'goal-1', objective: 'Ship it', status: 'active', tokensUsed: updated * 100, turnsUsed } } },
});

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT', 'Event', 'CustomEvent', 'MutationObserver'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = { window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    MutationObserver: win.MutationObserver };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, restore: () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    void win.happyDOM.close();
  } };
};

describe('SessionGoalDialog', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  let renders = 0;
  // Bootstrap stays pending, so each test owns the directory store's contents.
  const sdk = OpenCode.make({ baseUrl: 'http://goal.test', fetch: () => new Promise<Response>(() => undefined) });
  const store = () => {
    const result = getSyncChildStores().getChild(directory);
    if (!result) throw new Error('Expected mounted directory store');
    return result;
  };
  const stage = (record: Session) => act(async () => {
    store().setState({ session: [record] });
  });
  let openChanges: boolean[] = [];
  const render = (open: boolean) => act(async () => root.render(
    <SyncProvider sdk={sdk} directory={directory}>
      <I18nProvider>
        <React.Profiler id="goal-dialog" onRender={() => { renders += 1; }}>
          <SessionGoalDialog open={open} onOpenChange={(next) => { openChanges.push(next); }} sessionId={sessionId} directory={directory} />
        </React.Profiler>
      </I18nProvider>
    </SyncProvider>,
  ));

  beforeEach(() => {
    renders = 0;
    openChanges = [];
    useGoalEditStore.setState({ jobs: {}, drafts: {} });
    dom = installDom();
    root = createRoot(dom.container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
  });

  test('a closed dialog does not re-render while the session streams', async () => {
    await render(false);
    await stage(session(1, 1));
    const settled = renders;

    await stage(session(2, 1));
    await stage(session(3, 2));
    await stage(session(4, 3));

    expect(renders).toBe(settled);
    expect(document.body.textContent).not.toContain('Session Goal');
  });

  test('an open dialog shows the goal and follows its live usage', async () => {
    await render(false);
    await stage(session(1, 3));
    await render(true);

    expect(document.body.textContent).toContain('Session Goal');
    expect(document.body.textContent).toContain('3 continuations');

    await stage(session(2, 4));

    expect(document.body.textContent).toContain('4 continuations');
  });

  // Saving used to wait in the dialog for the goal writer, up to two minutes,
  // with only a disabled button to show for it.
  test('saving closes the dialog at once and hands the save to the card above the composer', async () => {
    await render(false);
    await stage(session(1, 1));
    await render(true);

    const objective = document.querySelector('textarea');
    if (!objective) throw new Error('No objective field');
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      setValue?.call(objective, 'Ship it, with tests');
      objective.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const save = Array.from(document.querySelectorAll('button')).find((element) => element.textContent?.trim() === 'Save goal');
    if (!save) throw new Error(`No Save button in: ${document.body.textContent}`);
    await act(async () => { save.click(); });

    expect(openChanges).toEqual([false]);
    expect(useGoalEditStore.getState().jobs[sessionId]).toMatchObject({ draft: { objective: 'Ship it, with tests' } });
  });

  // A writer picked in the editor only writes when the objective is rewritten,
  // so only then is it a choice worth recording.
  for (const rewriteAll of [true, false]) {
    test(`a writer picked in the editor is recorded on save ${rewriteAll ? 'when the objective is rewritten' : 'only when the objective is rewritten'}`, async () => {
      const recorded: unknown[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/api/openchamber/model-choices')) recorded.push(JSON.parse(String(init?.body)));
        return new Response('{}', { status: 200 });
      }, { preconnect: async () => {} });
      const previousRewriteAll = useUIStore.getState().sessionGoalRewriteAll;
      useUIStore.setState({ sessionGoalRewriteAll: rewriteAll, modelChoiceRecordingEnabled: true });
      useGoalEditStore.setState({ drafts: { [sessionId]: {
        objective: 'Ship it, with tests', tokenBudget: null, ignoreLimit: false,
        writer: { providerID: 'p', modelID: 'm', variant: 'low' }, message: '', delivery: 'steer',
      } } });
      try {
        await render(false);
        await stage(session(1, 1));
        await render(true);
        const save = Array.from(document.querySelectorAll('button')).find((element) => element.textContent?.trim() === 'Save goal');
        if (!save) throw new Error(`No Save button in: ${document.body.textContent}`);
        await act(async () => { save.click(); });
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      } finally {
        globalThis.fetch = originalFetch;
        useUIStore.setState({ sessionGoalRewriteAll: previousRewriteAll });
      }

      expect(openChanges).toEqual([false]);
      expect(recorded).toEqual(rewriteAll ? [{
        surface: 'goal-writer',
        kind: 'model',
        chosen: { model: 'p/m', variant: 'low' },
        replaced: null,
        sessionModel: null,
        inputSize: 'short',
      }] : []);
    });
  }
});

import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Message, Part, SyntheticMessage, ToolPart as ToolPartData } from '@/lib/opencode/model';
import { SyncProvider, useChildStoreManager } from '@/sync/sync-context';
import { I18nProvider } from '@/lib/i18n';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { classifySubagentReports } from '@/lib/opencode/subagent-run';

// Bun does not implement Vite's worker asset-query imports.
plugin({
  name: 'subagent-notice-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const { TimelineNotice } = await import('./TimelineNotice');
const { SubagentReportNoticesProvider } = await import('./subagentReportNotices');

type Record_ = { info: Message; parts: Part[] };

const call = (childID: string, description: string): Record_ => ({
  info: {
    id: 'msg_call', sessionID: 'parent', role: 'assistant', time: { created: 5 },
    agent: 'build', providerID: 'p', modelID: 'm',
  },
  parts: [{
    id: 'prt_call', sessionID: 'parent', messageID: 'msg_call',
    type: 'tool', tool: 'subagent', callID: 'call_1',
    state: {
      status: 'completed',
      input: { description, agent: 'general' },
      output: 'The subagent is working in the background.',
      metadata: { status: 'running', sessionID: childID },
      time: { start: 6, end: 7 },
    },
  } satisfies ToolPartData],
});

const report = (fields: { id?: string; childID?: string; created?: number; output?: string } = {}): Record_ => ({
  info: {
    id: fields.id ?? 'msg_report',
    sessionID: 'parent',
    role: 'synthetic',
    time: { created: fields.created ?? 20 },
    text: `<subagent sessionID="${fields.childID ?? 'child'}" state="completed">\n${fields.output ?? 'Found two files'}\n</subagent>`,
    description: 'Update files',
    metadata: { source: 'subagent', childID: fields.childID ?? 'child', agent: 'explore', state: 'completed' },
  } satisfies SyntheticMessage,
  parts: [],
});

type ChildStore = ReturnType<ReturnType<typeof useChildStoreManager>['ensureChild']>;

const render = async (
  records: Record_[],
  run: (container: HTMLElement, store: ChildStore) => void | Promise<void>,
) => {
  const classified = classifySubagentReports(records, (childID) => (childID === 'child' ? 6 : childID === 'command' ? 7 : undefined));
  const happyWindow = new Window({ url: 'http://localhost' });
  const globals = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    localStorage: happyWindow.localStorage,
    customElements: happyWindow.customElements,
    Node: happyWindow.Node,
    Text: happyWindow.Text,
    NodeList: happyWindow.NodeList,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    SVGElement: happyWindow.SVGElement,
    CustomEvent: happyWindow.CustomEvent,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    ResizeObserver: happyWindow.ResizeObserver,
    MutationObserver: happyWindow.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const sdk = OpenCode.make({
    baseUrl: 'http://localhost',
    fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }),
  });

  const previousDirectory = useDirectoryStore.getState().currentDirectory;
  let manager: ReturnType<typeof useChildStoreManager> | undefined;
  let store: ChildStore | undefined;
  const CaptureManager = () => { manager = useChildStoreManager(); return null; };
  try {
    useDirectoryStore.setState({ currentDirectory: '/workspace' });
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="/workspace">
          <CaptureManager />
          <I18nProvider>
            <SubagentReportNoticesProvider value={classified.completionNotices}>
              {classified.records.map((record) => (
                <TimelineNotice key={record.info.id} message={record.info} />
              ))}
            </SubagentReportNoticesProvider>
          </I18nProvider>
        </SyncProvider>,
      );
    });
    if (!manager) throw new Error('Sync manager did not mount');
    store = manager.ensureChild('/workspace', { bootstrap: false });
    await run(container, store);
  } finally {
    // The child store is cached per directory, so a session seeded here would
    // otherwise be visible to the next file in the same `bun test` process.
    const used = store;
    if (used) await act(async () => { used.setState({ session: [] }); });
    await act(async () => { root.unmount(); });
    useDirectoryStore.setState({ currentDirectory: previousDirectory });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

const noticeCount = (container: HTMLElement) => (container.textContent?.split('Subagent finished').length ?? 1) - 1;

test('a report of a call this transcript shows reads as one finished line that opens to its result', async () => {
  await render([call('child', 'Update files'), report({ created: 20_000 })], async (container, store) => {
    expect(noticeCount(container)).toBe(1);
    // Named by the call, so the notice and the row read the same run.
    expect(container.textContent).toContain('Update files');
    expect(container.querySelector('button[aria-label="Open Explore subtask"]')).not.toBeNull();
    // Folded, it keeps one line: the result is what expanding shows.
    expect(container.textContent).not.toContain('Found two files');

    // The line measures its own run: the report (t=20s) against the child's
    // start (t=3s), not the length of the child's last turn.
    await act(async () => {
      store.setState({
        session: [{
          id: 'child', parentID: 'parent', projectID: 'p', directory: '/workspace', title: 'child',
          agent: 'explore', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 3_000, updated: 20_000 },
        }],
      });
    });
    expect(container.textContent).toContain('17.0s');
    const header = container.querySelector('[role="button"][aria-label="Show result"]');
    if (!(header instanceof HTMLElement)) throw new Error('The notice header is missing');
    await act(async () => {
      header.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Found two files');
  });
});

test('a task record another tool wrote for the same child reads as the same notice', async () => {
  const record: Record_ = {
    info: {
      id: 'msg_task_record',
      sessionID: 'parent',
      role: 'synthetic',
      time: { created: 40 },
      text: [
        '<task id="child" state="completed">',
        '<summary>Background task completed: Update files</summary>',
        '<task_result>',
        'All three items are implemented.',
        '</task_result>',
        '</task>',
      ].join('\n'),
      metadata: { 'oh-my-opencode-slim.internalInitiator': true },
    } satisfies SyntheticMessage,
    parts: [],
  };
  await render([call('child', 'Update files'), record], (container) => {
    expect(noticeCount(container)).toBe(1);
    expect(container.textContent).toContain('Update files');
    expect(container.textContent).not.toContain('All three items are implemented.');
  });
});

test('a report of a command child keeps its own row, with no completion notice', async () => {
  await render([call('child', 'Update files'), report({ id: 'msg_command', childID: 'command' })], (container) => {
    expect(noticeCount(container)).toBe(0);
    // The full run row, as before this change: the report is its only trace.
    expect(container.textContent).toContain('Update files');
    expect(container.querySelector('[role="button"][aria-label="Show result"]')).toBeNull();
  });
});

test('a child that ran twice reads as two notices, one per run', async () => {
  await render([
    call('child', 'Update files'),
    report({ id: 'msg_first', created: 20, output: 'First run failed' }),
    report({ id: 'msg_second', created: 30, output: 'Second run result' }),
  ], (container) => {
    expect(noticeCount(container)).toBe(2);
  });
});

test('a call without a description leaves the line unnamed, not previewing the result', async () => {
  await render([call('child', ''), report()], (container) => {
    expect(container.textContent).toContain('Subagent finished');
    expect(container.textContent).not.toContain('Found two files');
  });
});

test('a run that reported no text keeps its line, with nothing to open', async () => {
  await render([call('child', 'Update files'), report({ output: '' })], (container) => {
    expect(noticeCount(container)).toBe(1);
    expect(container.textContent).toContain('Update files');
    expect(container.querySelector('[role="button"][aria-label="Show result"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Open Explore subtask"]')).not.toBeNull();
  });
});

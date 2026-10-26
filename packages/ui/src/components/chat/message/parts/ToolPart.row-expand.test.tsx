import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { ToolPart as ToolPartData } from '@/lib/opencode/model';
import { SyncProvider } from '@/sync/sync-context';
import { I18nProvider } from '@/lib/i18n';
import { onRowExpand } from '@/components/chat/lib/scroll/timelineScrollIntent';

// Bun does not implement Vite's worker asset-query imports.
plugin({
  name: 'tool-row-expand-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const { default: ToolPart } = await import('./ToolPart');

const part: ToolPartData = {
  id: 'prt_shell', sessionID: 'ses_shell', messageID: 'msg_shell',
  type: 'tool', tool: 'bash', callID: 'call_shell',
  state: {
    status: 'completed',
    input: { command: 'seq 1 3', description: 'Count to three' },
    output: '1\n2\n3',
    metadata: {},
    time: { start: 1, end: 2 },
  },
};

const Row = ({ onToggled }: { onToggled: () => void }) => {
  const [expanded, setExpanded] = React.useState(false);
  return (
    <ToolPart
      part={part}
      isExpanded={expanded}
      isMobile={false}
      onToggle={() => {
        onToggled();
        setExpanded((value) => !value);
      }}
    />
  );
};

test('opening a tool row tells the timeline before the row grows; closing it does not', async () => {
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
  // Each opening is heard before the toggle runs: the timeline must let go
  // of the end before the row's state changes.
  const events: string[] = [];
  const stop = onRowExpand(container, () => { events.push('expand'); });

  try {
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="">
          <I18nProvider>
            <Row onToggled={() => { events.push('toggle'); }} />
          </I18nProvider>
        </SyncProvider>,
      );
    });
    const header = container.querySelector<HTMLElement>('[role="button"]');
    expect(header).not.toBeNull();

    await act(async () => { header?.click(); });
    expect(events).toEqual(['expand', 'toggle']);

    await act(async () => { header?.click(); });
    expect(events).toEqual(['expand', 'toggle', 'toggle']);
  } finally {
    stop();
    await act(async () => { root.unmount(); });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

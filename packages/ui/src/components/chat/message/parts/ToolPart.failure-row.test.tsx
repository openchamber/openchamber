import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Message, ToolPart as ToolPartData } from '@/lib/opencode/model';
import { SyncProvider } from '@/sync/sync-context';
import { I18nProvider } from '@/lib/i18n';

// Bun does not implement Vite's worker asset-query imports.
plugin({
  name: 'tool-failure-row-worker-url',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
      loader: 'js',
    }));
  },
});

const { default: ToolPart } = await import('./ToolPart');
const { TimelineNotice } = await import('../TimelineNotice');

type ShellMessage = Extract<Message, { role: 'shell' }>;

const shellMessage = (fields: Pick<ShellMessage, 'command' | 'status'> & Partial<ShellMessage>): Message => ({
  id: 'msg_shell_failure',
  sessionID: 'ses_shell_failure',
  role: 'shell',
  shellID: 'shl_failure',
  time: { created: 1, completed: 2 },
  ...fields,
});

const shellOutput = (output: string): ShellMessage['output'] => ({ output, cursor: output.length, size: output.length, truncated: false });

const render = async (element: React.ReactElement, run: (container: HTMLElement) => void) => {
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

  try {
    await act(async () => {
      root.render(
        <SyncProvider sdk={sdk} directory="">
          <I18nProvider>{element}</I18nProvider>
        </SyncProvider>,
      );
    });
    run(container);
  } finally {
    await act(async () => { root.unmount(); });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

test('a failed !command row shows the reason its command printed, collapsed', async () => {
  const message = shellMessage({
    command: 'sudo true',
    status: 'exited',
    exit: 1,
    output: shellOutput('sudo: a terminal is required to read the password\nsudo: a password is required\n'),
  });
  await render(<TimelineNotice message={message} />, (container) => {
    expect(container.textContent).toContain('sudo true');
    expect(container.textContent).toContain('sudo: a password is required');
  });
});

test('a !command that printed nothing shows how it ended, collapsed', async () => {
  const message = shellMessage({ command: 'false', status: 'exited', exit: 1, output: shellOutput('') });
  await render(<TimelineNotice message={message} />, (container) => {
    expect(container.textContent).toContain('exited (1)');
  });
});

test('a timed out !command shows that it timed out, not its last progress line', async () => {
  const message = shellMessage({ command: 'make', status: 'timeout', output: shellOutput('Compiling 34/120\n') });
  await render(<TimelineNotice message={message} />, (container) => {
    expect(container.textContent).toContain('timeout');
    expect(container.textContent).not.toContain('Compiling 34/120');
  });
});

test('a !command whose output was truncated shows how it ended, not a line from the middle', async () => {
  const message = shellMessage({
    command: 'seq 1 300000; false',
    status: 'exited',
    exit: 1,
    output: { output: '1\n2\n16566\n', cursor: 10, size: 2_000_000, truncated: true },
  });
  await render(<TimelineNotice message={message} />, (container) => {
    expect(container.textContent).toContain('exited (1)');
    expect(container.textContent).not.toContain('16566');
  });
});

test('a failed agent tool row shows no reason line, collapsed', async () => {
  const part: ToolPartData = {
    id: 'prt_agent_shell', sessionID: 'ses_agent_shell', messageID: 'msg_agent_shell',
    type: 'tool', tool: 'shell', callID: 'call_agent_shell',
    state: {
      status: 'error',
      input: { command: 'make' },
      error: 'Tool execution aborted',
      metadata: { output: 'Compiling 34/120\n', interrupted: true },
      time: { start: 1, end: 2 },
    },
  };
  await render(<ToolPart part={part} isExpanded={false} isMobile={false} onToggle={() => {}} />, (container) => {
    expect(container.textContent).toContain('make');
    expect(container.textContent).not.toContain('Compiling 34/120');
    expect(container.textContent).not.toContain('Tool execution aborted');
  });
});

test('an expanded failed row leaves its reason to the body', async () => {
  const part: ToolPartData = {
    id: 'prt_shell_expanded', sessionID: 'ses_shell_expanded', messageID: 'msg_shell_expanded',
    type: 'tool', tool: 'shell', callID: 'call_shell_expanded',
    state: { status: 'error', input: { command: 'sudo true' }, error: 'exited (1)', output: '', time: { start: 1, end: 2 } },
  };
  const row = (isExpanded: boolean) => (
    <ToolPart part={part} isExpanded={isExpanded} isMobile={false} onToggle={() => {}} failureReason="header reason" />
  );
  await render(row(false), (container) => {
    expect(container.textContent).toContain('header reason');
  });
  await render(row(true), (container) => {
    expect(container.textContent).not.toContain('header reason');
  });
});

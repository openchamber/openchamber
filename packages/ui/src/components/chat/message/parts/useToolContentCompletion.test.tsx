import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { ToolPart } from '@/lib/opencode/model';

const reads: string[] = [];
let readImpl: (sessionID: string, messageID: string) => Promise<{ info: { id: string }; parts: ToolPart[] }> = async () => {
  throw new Error('not stubbed');
};

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getSessionMessage: (sessionID: string, messageID: string) => {
      reads.push(`${sessionID}/${messageID}`);
      return readImpl(sessionID, messageID);
    },
  },
}));

mock.module('@/sync/sync-refs', () => ({
  getSyncSessionDirectory: () => '/tmp/project',
}));

const { useToolContentCompletion } = await import('./useToolContentCompletion');

const shelledPart: ToolPart = {
  id: 'prt_shell',
  sessionID: 'ses_shell',
  messageID: 'msg_shell',
  type: 'tool',
  callID: 'call_shell',
  tool: 'shell',
  state: {
    status: 'completed',
    input: { command: 'seq 1 3' },
    output: '',
    metadata: { openchamberContentShell: { chars: 5 } },
    time: { start: 1, end: 2 },
  },
};

const wholePart: ToolPart = {
  ...shelledPart,
  state: {
    status: 'completed',
    input: { command: 'seq 1 3' },
    output: '1\n2\n3',
    time: { start: 1, end: 2 },
  },
};

const Probe = ({ part, needed }: { part: ToolPart; needed: boolean }) => {
  const completion = useToolContentCompletion(part, needed);
  const text = completion.status === 'whole' && completion.part.state.status === 'completed'
    ? completion.part.state.output
    : '';
  return (
    <div>
      <span data-testid="status">{completion.status}</span>
      <span data-testid="text">{text}</span>
      {completion.status === 'failed' ? <button onClick={completion.retry}>retry</button> : null}
    </div>
  );
};

const flush = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

const withWindow = async (run: () => Promise<void>): Promise<void> => {
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
  try {
    await run();
  } finally {
    await act(async () => { root.unmount(); });
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

test('a shelled call is read by id once and rendered without touching the store', async () => {
  reads.length = 0;
  readImpl = async () => ({ info: { id: 'msg_shell' }, parts: [wholePart] });
  await withWindow(async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe part={shelledPart} needed />);
      await flush();
    });
    expect(reads).toEqual(['ses_shell/msg_shell']);
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('whole');
    expect(container.querySelector('[data-testid="text"]')?.textContent).toBe('1\n2\n3');
    await act(async () => { root.unmount(); });
  });
});

test('a call read while collapsed is not fetched', async () => {
  reads.length = 0;
  readImpl = async () => ({ info: { id: 'msg_shell' }, parts: [wholePart] });
  await withWindow(async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe part={shelledPart} needed={false} />);
      await flush();
    });
    expect(reads).toEqual([]);
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('loading');
    await act(async () => { root.unmount(); });
  });
});

test('a failed read offers a retry that reads again and renders', async () => {
  reads.length = 0;
  readImpl = async () => {
    if (reads.length === 1) throw new Error('network');
    return { info: { id: 'msg_shell' }, parts: [wholePart] };
  };
  await withWindow(async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe part={shelledPart} needed />);
      await flush();
    });
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('failed');
    const retry = container.querySelector('button');
    expect(retry).not.toBeNull();
    await act(async () => {
      retry?.click();
      await flush();
    });
    expect(reads).toEqual(['ses_shell/msg_shell', 'ses_shell/msg_shell']);
    expect(container.querySelector('[data-testid="status"]')?.textContent).toBe('whole');
    expect(container.querySelector('[data-testid="text"]')?.textContent).toBe('1\n2\n3');
    await act(async () => { root.unmount(); });
  });
});

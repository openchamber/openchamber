import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { ChatErrorBoundaryView } from '../ChatErrorBoundary';

const texts = {
  title: 'Chat Error',
  description: 'Description',
  sessionLabel: 'Session',
  detailsSummary: 'Error details',
  resetAction: 'Reset chat',
  persistentHint: 'Refresh the page',
};

function Chat({ sessionId, broken = false }: { sessionId: string; broken?: boolean }) {
  if (broken) throw new Error(`Failed ${sessionId}`);
  return <div data-chat={sessionId}>Chat {sessionId}</div>;
}

describe('chat error recovery across sessions', () => {
  let win: Window;
  let root: Root;
  let container: HTMLDivElement;
  let restoreGlobals: () => void;
  let caughtErrors: number;

  beforeEach(() => {
    win = new Window({ url: 'http://localhost' });
    const globals = {
      window: win,
      document: win.document,
      HTMLElement: win.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    restoreGlobals = () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
    container = document.createElement('div');
    document.body.append(container);
    caughtErrors = 0;
    root = createRoot(container, { onCaughtError: () => { caughtErrors += 1; } });
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      await win.happyDOM.close();
      restoreGlobals();
    }
  });

  const render = async (sessionId: string, children: React.ReactNode) => {
    await act(async () => root.render(
      <ChatErrorBoundaryView sessionId={sessionId} texts={texts}>
        {children}
      </ChatErrorBoundaryView>,
    ));
  };

  const expectError = (sessionId: string) => {
    expect(container.textContent).toContain(texts.title);
    expect(container.textContent).toContain(`Session: ${sessionId}`);
    expect(container.querySelector('pre')?.textContent).toBe(`Error: Failed ${sessionId}`);
    expect(container.querySelector('[data-chat]')).toBeNull();
  };

  test('renders a healthy session after another session failed', async () => {
    await render('A', <Chat sessionId="A" broken />);
    expectError('A');

    await render('B', <Chat sessionId="B" />);
    expect(container.textContent).toBe('Chat B');
    expect(container.querySelector('pre')).toBeNull();
    expect(caughtErrors).toBe(1);
  });

  test('captures the next session\'s own error after clearing the previous error', async () => {
    await render('A', <Chat sessionId="A" broken />);
    expectError('A');

    await render('B', <Chat sessionId="B" broken />);
    expectError('B');
    expect(caughtErrors).toBe(2);
  });

  test('does not retry a fresh error caught during a healthy-to-failing session switch', async () => {
    await render('A', <Chat sessionId="A" />);
    expect(container.textContent).toBe('Chat A');

    await render('B', <Chat sessionId="B" broken />);
    expectError('B');
    // Count committed catches, not render attempts: React may replay a failed render.
    expect(caughtErrors).toBe(1);
  });

  test('keeps the same session\'s error latched when its children change', async () => {
    await render('A', <Chat sessionId="A" broken />);
    expectError('A');

    await render('A', <Chat sessionId="A" />);
    expectError('A');
    expect(caughtErrors).toBe(1);
  });

  test('the Reset chat button retries the current session and clears the error', async () => {
    await render('A', <Chat sessionId="A" broken />);
    await render('A', <Chat sessionId="A" />);
    expectError('A');

    const reset = container.querySelector('button');
    if (!reset) throw new Error('Expected the Reset chat button');
    expect(reset.textContent).toBe(texts.resetAction);
    await act(async () => reset.click());

    expect(container.textContent).toBe('Chat A');
    expect(container.querySelector('pre')).toBeNull();
    expect(caughtErrors).toBe(1);
  });

  test('preserves mounted child state across healthy session switches', async () => {
    function StatefulChat({ sessionId }: { sessionId: string }) {
      const [count, setCount] = React.useState(0);
      return <button onClick={() => setCount(count + 1)}>{sessionId}: {count}</button>;
    }

    await render('A', <StatefulChat sessionId="A" />);
    const button = container.querySelector('button');
    if (!button) throw new Error('Expected the chat button');
    await act(async () => button.click());
    expect(button.textContent).toBe('A: 1');

    await render('B', <StatefulChat sessionId="B" />);
    expect(container.querySelector('button')).toBe(button);
    expect(container.textContent).toBe('B: 1');
    expect(caughtErrors).toBe(0);
  });
});

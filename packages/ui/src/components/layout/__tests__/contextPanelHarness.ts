/**
 * Shared fixture for the context panel render tests.
 *
 * `installDom` makes happy-dom the global DOM, so a test file must call it
 * before it imports the layout components. The terminal view is replaced: the
 * real one needs a live PTY. Its stand-in keeps the markup that the Escape
 * guard reads (`data-terminal-owner`) and a bubble-phase key listener on its
 * input, as the real terminal has.
 *
 * Elements are built with `createElement` so this stays a plain module.
 */
import { mock } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Root } from 'react-dom/client';

export const DIRECTORY = '/project';
export const TERMINAL_DIRECTORY = '/term-dir';

/** Every render of the terminal stand-in, with the props the panel gave it. */
export const terminalRenders: Array<{ directory?: string; visible?: boolean }> = [];
/** Keys the terminal's input received in the bubble phase. */
export const ptyKeys: string[] = [];

const FakeTerminalInput = (): React.ReactElement => {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    const input = ref.current;
    const onKeyDown = (event: KeyboardEvent) => { ptyKeys.push(event.key); };
    input?.addEventListener('keydown', onKeyDown);
    return () => input?.removeEventListener('keydown', onKeyDown);
  }, []);
  return React.createElement('input', { ref, 'aria-label': 'terminal input' });
};

// Markdown and diff highlighting import workers by URL, which the test runtime cannot load.
mock.module('@/components/chat/markdown/markdown-shiki.worker.ts?worker&url', () => ({ default: 'blob:test-shiki-worker' }));
mock.module('@pierre/diffs/worker/worker.js?worker&url', () => ({ default: 'blob:test-diff-worker' }));
// The panel's project. Resolving it for real needs a sync runtime and a session list.
mock.module('@/hooks/useEffectiveDirectory', () => ({
  useEffectiveDirectory: () => DIRECTORY,
  resolveEffectiveDirectory: () => DIRECTORY,
}));
mock.module('@/components/views/TerminalView', () => ({
  TerminalView: (props: { directory?: string; visible?: boolean }) => {
    terminalRenders.push({ directory: props.directory, visible: props.visible });
    return React.createElement(
      'div',
      null,
      React.createElement('div', { 'data-terminal-owner': 'main' }, React.createElement(FakeTerminalInput)),
      React.createElement('button', { type: 'button' }, 'Outside the terminal'),
    );
  },
}));
mock.module('@/components/terminal/AgentTerminalsSection', () => ({
  AgentTerminalsSection: () => null,
}));

/** The installed DOM: where a test mounts, and how to undo the globals. */
export type DomFixture = {
  container: HTMLElement;
  restore: () => Promise<void>;
};

export const installDom = (): DomFixture => {
  const dom = new Window({ url: 'http://localhost' });
  const values = {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    localStorage: dom.localStorage,
    customElements: dom.customElements,
    Node: dom.Node,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    MutationObserver: dom.MutationObserver,
    KeyboardEvent: dom.KeyboardEvent,
    MouseEvent: dom.MouseEvent,
    ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const container = document.createElement('div');
  document.body.append(container);
  return {
    container,
    restore: async () => {
      await dom.happyDOM.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

/**
 * Mounts the right zone's frame and its keep-alive panes, in the order the
 * layout mounts them, under the providers the app wraps them in. The sync
 * provider's server never answers: the panel reads only the stores.
 */
export const renderContextPanels = async (root: Root): Promise<void> => {
  const { I18nProvider } = await import('@/lib/i18n');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { SyncProvider } = await import('@/sync/sync-context');
  // The web runtime's APIs, as the app mounts them. The panel does not depend on their calls.
  const { createWebAPIs } = await import('../../../../../web/src/api/index');
  const { ContextPanel } = await import('../ContextPanel');
  const { ContextSurfacePanes } = await import('../ContextSurfacePanes');
  const sdk = OpenCode.make({ baseUrl: 'http://panels.test', fetch: () => new Promise<Response>(() => undefined) });
  await act(async () => {
    root.render(
      React.createElement(
        RuntimeAPIContext.Provider,
        { value: createWebAPIs() },
        React.createElement(
          I18nProvider,
          null,
          React.createElement(
            TooltipProvider,
            null,
            React.createElement(SyncProvider, {
              sdk,
              directory: DIRECTORY,
              children: React.createElement(
                React.Fragment,
                null,
                React.createElement(ContextPanel, { zone: 'right' }),
                React.createElement(ContextSurfacePanes),
              ),
            }),
          ),
        ),
      ),
    );
  });
};

/**
 * Presses Escape on `target` as a real keydown, so React's capture listeners
 * see it. Resolves to whether the key was left alone (not prevented).
 */
export const pressEscape = async (target: Element): Promise<boolean> => {
  let notPrevented = false;
  await act(async () => {
    notPrevented = target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  return notPrevented;
};

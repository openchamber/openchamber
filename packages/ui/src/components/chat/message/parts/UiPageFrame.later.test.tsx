import { afterEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

import type { ToolPart } from '@/lib/opencode/model';
import type { RenderedPageAsk } from '@/lib/opencode/tools';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  Event: browser.Event,
  MutationObserver: browser.MutationObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

type SentAnswer = { sessionId: string; callId: string; notDrawn?: string[] };
const answers: SentAnswer[] = [];
const revealed: (string | undefined)[] = [];
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/components/ui', () => ({ toast: { error: () => undefined } }));
mock.module('@/lib/renderPageAnswer', () => ({
  answerRenderedPage: async (answer: SentAnswer) => {
    answers.push(answer);
  },
}));
mock.module('@/components/chat/lib/scroll/timelineScrollIntent', () => ({
  dispatchPageWaiting: (block: HTMLElement | null) => revealed.push(block?.dataset.waitingPage),
}));
mock.module('@/sync/sync-context', () => ({
  useSessionDirectory: () => '/project',
  useSessionStatus: () => undefined,
  useSessionStatusSnapshotReady: () => false,
}));
mock.module('@/sync/global-blocking-requests', () => ({ useIsCallWaiting: () => false }));
mock.module('@/sync/later-pages', () => ({ useLaterPage: () => undefined }));

const { useGuestsStore } = await import('@/lib/guests/store');

// The block renderer as far as these tests need it: a program naming an
// extension component parses only once the catalog is in, and it reports the
// parser's errors from an effect, as UiBlock does.
function FakeUiBlock({ source, onNotDrawn }: { source: string; onNotDrawn?: (errors: string[]) => void }) {
  const catalogReady = useGuestsStore((state) => state.status === 'ready');
  const errors = React.useMemo(() => {
    if (source.includes('Bogus')) return ['Bogus: Unknown component'];
    return source.includes('DeskChart') && !catalogReady ? ['DeskChart: Unknown component'] : null;
  }, [catalogReady, source]);
  React.useEffect(() => {
    if (errors) onNotDrawn?.(errors);
  }, [errors, onNotDrawn]);
  return <div>{source}</div>;
}
mock.module('../../uiBlocks/useUiBlockComponent', () => ({ useUiBlockComponent: () => FakeUiBlock }));

const { createRoot } = await import('react-dom/client');
const { UiPageFrame } = await import('./UiPageFrame');

const part = (callID: string): ToolPart => ({
  id: `part-${callID}`,
  sessionID: 'ses-1',
  messageID: 'msg-1',
  type: 'tool',
  tool: 'openchamber_render',
  callID,
  state: { status: 'pending', input: {}, raw: '' },
});

const LATER: RenderedPageAsk = { kind: 'waiting', later: true };
const WAITING: RenderedPageAsk = { kind: 'waiting' };
const setCatalog = (status: 'loading' | 'ready') => {
  useGuestsStore.setState({ status });
};

const mount = async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (node: React.ReactNode) => act(async () => root.render(node));
  return {
    container,
    render,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
};

afterEach(() => {
  answers.length = 0;
  revealed.length = 0;
});

test('a later page restored before the extension catalog is not reported as undrawable', async () => {
  setCatalog('loading');
  const view = await mount();
  try {
    // The later pages' snapshot lands first: the program names an extension component nobody knows yet.
    await view.render(<UiPageFrame part={part('call-1')} source="root = DeskChart()" ask={LATER} />);
    expect(answers).toEqual([]);
    await act(async () => setCatalog('ready'));
    expect(answers).toEqual([]);
  } finally {
    await view.unmount();
  }
});

test('a later page whose snapshot lands after the catalog is not reported either', async () => {
  setCatalog('ready');
  const view = await mount();
  try {
    await view.render(<UiPageFrame part={part('call-1')} source="root = DeskChart()" ask={{ kind: 'show' }} />);
    await view.render(<UiPageFrame part={part('call-1')} source="root = DeskChart()" ask={LATER} />);
    expect(answers).toEqual([]);
  } finally {
    await view.unmount();
  }
});

test('a later page that cannot be drawn reports it once the catalog is in', async () => {
  setCatalog('loading');
  const view = await mount();
  try {
    await view.render(<UiPageFrame part={part('call-1')} source="root = Bogus()" ask={LATER} />);
    expect(answers).toEqual([]);
    await act(async () => setCatalog('ready'));
    expect(answers).toEqual([{ sessionId: 'ses-1', callId: 'call-1', notDrawn: ['Bogus: Unknown component'] }]);
  } finally {
    await view.unmount();
  }
});

test('an older later page never stands in for a page the turn waits on', async () => {
  setCatalog('ready');
  const view = await mount();
  try {
    await view.render(
      <>
        <UiPageFrame part={part('call-later')} source="root = Text()" ask={LATER} />
        <UiPageFrame part={part('call-wait')} source="root = Text()" ask={WAITING} />
      </>,
    );
    // What a toast's "Open session" looks for (useChatTimelineScroll) and what the chat brings into view.
    expect(view.container.querySelector<HTMLElement>('[data-waiting-page]')?.dataset.waitingPage).toBe('part-call-wait');
    expect(view.container.querySelectorAll('[data-waiting-page]')).toHaveLength(1);
    expect(revealed).toEqual(['part-call-wait']);
  } finally {
    await view.unmount();
  }
});

test('an answer the agent has not got yet is marked under the page', async () => {
  setCatalog('ready');
  const view = await mount();
  try {
    await view.render(<UiPageFrame part={part('call-1')} source="root = Text()" ask={{ kind: 'answered', summary: 'Red', data: null, undelivered: true }} />);
    expect(view.container.querySelector('[data-html-render-status]')?.textContent).toBe('chat.htmlRender.answered· chat.htmlRender.undelivered');
    // Its own element beside the summary, which alone is cut when the line is too narrow.
    const warning = view.container.querySelector<HTMLElement>('[data-html-render-undelivered]');
    expect(warning?.textContent).toBe('· chat.htmlRender.undelivered');
    expect(warning?.closest('.truncate')).toBeNull();
    expect(warning?.className).toContain('shrink-0');
    expect(view.container.querySelector('[data-html-render-status] .truncate')?.textContent).toBe('chat.htmlRender.answered');
    await view.render(<UiPageFrame part={part('call-1')} source="root = Text()" ask={{ kind: 'answered', summary: 'Red', data: null }} />);
    expect(view.container.querySelector('[data-html-render-status]')?.textContent).toBe('chat.htmlRender.answered');
    expect(view.container.querySelector('[data-html-render-undelivered]')).toBeNull();
  } finally {
    await view.unmount();
  }
});

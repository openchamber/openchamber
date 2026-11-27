import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { Root } from 'react-dom/client';

import type { ReferenceCommentItem, ReferenceTimelineEntry } from './referenceTimeline';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, Text: browser.Text,
  HTMLImageElement: browser.HTMLImageElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  HTMLAnchorElement: browser.HTMLAnchorElement, SVGElement: browser.SVGElement,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  PointerEvent: browser.PointerEvent, FocusEvent: browser.FocusEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

const { createRoot } = await import('react-dom/client');

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const resolvedThread: ReferenceCommentItem = {
  kind: 'comment', key: 't1', author: 'mona', avatarUrl: null, body: 'A resolved thread', createdAt: '2026-01-03T00:00:00Z',
  context: null, location: null, thread: { id: 'T1', resolved: true, canResolve: true, canReply: true, replies: [] },
};

const commits: ReferenceTimelineEntry = {
  kind: 'commits', key: 'commit:abc',
  commits: [{ sha: 'abc1234', headline: 'Add the login form', author: 'mona', avatarUrl: null, committedAt: '2026-01-02T00:00:00Z', url: null }],
};

const render = async (entries: ReferenceTimelineEntry[], threadsUnavailable: boolean) => {
  const [{ ReferenceCommentsSection }, { I18nProvider }, { TooltipProvider }] = await Promise.all([
    import('./ReferenceCommentsSection'),
    import('@/lib/i18n'),
    import('@/components/ui/tooltip'),
  ]);
  await act(async () => {
    root.render(
      <I18nProvider>
        <TooltipProvider>
          <ReferenceCommentsSection
            state={{ status: 'ready', value: entries }}
            total={null}
            activity
            now={0}
            threadsUnavailable={threadsUnavailable}
          />
        </TooltipProvider>
      </I18nProvider>,
    );
  });
};

const filterTrigger = () => host.querySelector<HTMLButtonElement>('button[aria-label^="Filter activity"]');

const pick = async (label: string) => {
  const trigger = filterTrigger();
  if (!trigger) throw new Error('Expected the activity filter');
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
  });
  const item = [...document.querySelectorAll('[role="menuitemradio"]')].find((node) => node.textContent?.includes(label));
  if (!(item instanceof HTMLElement)) throw new Error(`Expected the ${label} option`);
  await act(async () => { item.click(); });
};

describe('the Activity list when the thread read is lost', () => {
  test('a thread filter picked before falls back to everything that arrived', async () => {
    await render([commits, resolvedThread], false);
    await pick('Resolved');
    // Only the resolved thread is left, folded to its summary line.
    expect(filterTrigger()?.textContent).toContain('Resolved · 1');
    expect(host.textContent).not.toContain('Add the login form');

    // The refresh keeps the commits but loses the threads.
    await render([commits], true);
    expect(host.textContent).toContain('Add the login form');
    expect(host.textContent).toContain('Threads are unavailable');
    expect(host.textContent).not.toContain('No resolved');
    expect(filterTrigger()).toBeNull();
  });

  test('a lost thread read with nothing else is not an empty conversation', async () => {
    await render([], true);
    expect(host.textContent).toContain('Threads are unavailable');
    expect(host.textContent).not.toContain('No comments');
  });
});

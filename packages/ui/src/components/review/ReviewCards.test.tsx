import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { Root } from 'react-dom/client';

import type { ReviewThread } from '@/lib/source-control/types';
import type { ChangeRequestReview } from './useChangeRequestReview';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, Text: browser.Text,
  HTMLTextAreaElement: browser.HTMLTextAreaElement, HTMLAnchorElement: browser.HTMLAnchorElement,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
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

const thread = (outdated?: boolean): ReviewThread => {
  const next: ReviewThread = {
    id: 'T1', path: 'src/login.ts', side: 'new', line: 12, startLine: null, resolved: true,
    canReply: true, canResolve: true,
    comments: [{ id: 'C1', body: 'This needs a test', createdAt: '2026-01-01T00:00:00Z', url: 'https://forge.example.com/c/1', author: { login: 'mona' } }],
  };
  if (outdated) next.outdated = true;
  return next;
};

const review: ChangeRequestReview = {
  state: null,
  readFailed: false,
  fileComments: true,
  canWrite: true,
  addComment: async () => true,
  updateComment: async () => true,
  deleteComment: async () => true,
  reply: async () => true,
  setResolved: async () => true,
  attachThread: () => undefined,
  submit: async () => true,
  discard: async () => true,
};

const renderThread = async (next: ReviewThread) => {
  const { I18nProvider } = await import('@/lib/i18n');
  const { ReviewThreadCard } = await import('./ReviewCards');
  await act(async () => {
    root.render(
      <I18nProvider>
        <ReviewThreadCard thread={next} review={review} excerpt={null} />
      </I18nProvider>,
    );
  });
};

describe('a review thread the host marks as outdated', () => {
  test('keeps the thread on screen and marks it', async () => {
    await renderThread(thread(true));
    expect(host.textContent).toContain('This needs a test');
    expect(host.textContent).toContain('Outdated');
  });

  test('a thread the host says nothing about carries no marker', async () => {
    await renderThread(thread());
    expect(host.textContent).toContain('This needs a test');
    expect(host.textContent).not.toContain('Outdated');
  });
});

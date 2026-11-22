import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import type { RunLaneCardProps } from './RunLaneCard';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, SVGElement: browser.SVGElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  DocumentFragment: browser.DocumentFragment, ShadowRoot: browser.ShadowRoot, NodeFilter: browser.NodeFilter,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { RunLaneCard } = await import('./RunLaneCard');
const { AttachSessionDialog } = await import('./AttachSessionDialog');
let root: Root | null = null;

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.innerHTML = '';
});

function props(events: string[], extra: Partial<RunLaneCardProps> = {}): RunLaneCardProps {
  return {
    session: {
      id: 's1', projectID: 'project', directory: '/worktree', title: 'Result', cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1, idle: 10 },
    },
    providerID: 'provider', modelLabel: 'Model A', variantLabel: null, isFusion: false,
    busy: false, status: 'finished', unread: false, summary: undefined,
    fuseSource: null, hasWorktree: false, actionsDisabled: false,
    onToggleFuseSource: () => { events.push('select'); }, onDetach: () => { events.push('detach'); },
    onArchive: () => { events.push('archive'); }, onOpenChat: () => { events.push('view'); },
    onOpenDiff: () => { events.push('diff'); }, ...extra,
  };
}

async function mount(value: RunLaneCardProps) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root?.render(<I18nProvider><RunLaneCard {...value} /></I18nProvider>); });
}

async function click(name: string, dialog = false) {
  const owner = dialog ? document.querySelector('[role="dialog"]') : document;
  const button = owner && [...owner.querySelectorAll<HTMLButtonElement>('button')]
    .find((item) => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === name);
  if (!button) throw new Error(`Missing button: ${name}`);
  await act(async () => { button.click(); });
}

// Oracle: view emits only navigation; membership changes require the dialog's
// explicit confirmation. Real card controls are the only coverage of that gate.
test('opening a model session never requests detachment', async () => {
  const events: string[] = [];
  await mount(props(events));
  await click('Open chat');
  expect(events).toEqual(['view']);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test('remove opens confirmation, cancellation leaves membership unchanged, confirm removes once', async () => {
  const events: string[] = [];
  await mount(props(events));
  await click('Remove from run');
  expect(events).toEqual([]);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('worktree stay available');
  await click('Cancel', true);
  expect(events).toEqual([]);
  await click('Remove from run');
  await click('Remove from run', true);
  expect(events).toEqual(['detach']);
});

test('archive is confirmed separately and does not invoke detach', async () => {
  const events: string[] = [];
  await mount(props(events));
  await click('Archive this session');
  expect(events).toEqual([]);
  await click('Archive this session', true);
  expect(events).toEqual(['archive']);
});

test('view stays available while selecting fusion sources and does not toggle selection', async () => {
  const events: string[] = [];
  await mount(props(events, { fuseSource: { checked: true, selectable: true }, actionsDisabled: true }));
  await click('Open chat');
  expect(events).toEqual(['view']);
  await click('Select Model A');
  expect(events).toEqual(['view', 'select']);
});

test('existing-session picker requires an explicit selection before importing', async () => {
  const events: string[] = [];
  const member = props(events).session;
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root?.render(
    <I18nProvider>
      <AttachSessionDialog open onOpenChange={() => { events.push('close'); }} sessions={[member]} busy={false} onAttach={async (session) => { events.push(`attach:${session.id}`); }} />
    </I18nProvider>,
  ); });
  await click('Add session', true);
  expect(events).toEqual([]);
  await click('Result', true);
  expect(events).toEqual([]);
  await click('Add session', true);
  expect(events).toEqual(['attach:s1']);
});

test('canceling the existing-session picker never imports the selected session', async () => {
  const events: string[] = [];
  const member = props(events).session;
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root?.render(
    <I18nProvider>
      <AttachSessionDialog open onOpenChange={() => { events.push('close'); }} sessions={[member]} busy={false} onAttach={async () => { events.push('attach'); }} />
    </I18nProvider>,
  ); });
  await click('Result', true);
  await click('Cancel', true);
  expect(events).toEqual(['close']);
});

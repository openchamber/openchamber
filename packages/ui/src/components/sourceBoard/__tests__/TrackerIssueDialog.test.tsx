// The dialog's own contract, against the same transport seam the mutations
// tests stub: a create submit posts the create route and finishes through
// `onDone`, a failed submit keeps every field and says so, and an edit submit
// posts the edit route for the item it opened with.
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

// React DOM probes for a document when it is first imported; the globals have
// to exist before that import, so it happens below, not at the top.
const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
// Nothing here talks to the network; the mocked runtime-fetch answers below.
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

const { createRoot } = await import('react-dom/client');

type RecordedRequest = { path: string; init: RequestInit };
const requests: RecordedRequest[] = [];
let nextResponse: Response;

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (path: string, init: RequestInit = {}) => {
    requests.push({ path, init });
    return nextResponse;
  },
}));

// Base UI's dialog and select need a live browser; the dialog test only needs
// the tree these components wrap, so they render as their plain parts.
const passthrough = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
const actualDialog = await import('@/components/ui/dialog');
mock.module('@/components/ui/dialog', () => ({
  ...actualDialog,
  Dialog: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => open ? <>{children}</> : null,
  DialogContent: passthrough,
  DialogHeader: passthrough,
  DialogTitle: passthrough,
  DialogDescription: passthrough,
  DialogFooter: passthrough,
}));
const actualSelect = await import('@/components/ui/select');
mock.module('@/components/ui/select', () => ({
  ...actualSelect,
  Select: passthrough,
  SelectTrigger: passthrough,
  SelectValue: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
}));
mock.module('@/components/ui/textarea', () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));
const actualSettingsSection = await import('@/components/sections/shared/SettingsSection');
mock.module('@/components/sections/shared/SettingsSection', () => ({
  ...actualSettingsSection,
  SettingsStackedField: ({ label, children }: React.PropsWithChildren<{ label?: React.ReactNode }>) => (
    <label><span>{label}</span>{children}</label>
  ),
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));

const { TrackerIssueDialog } = await import('../TrackerIssueDialog');
const { I18nProvider } = await import('@/lib/i18n');

const CONTAINERS = [
  { id: 'proj-1', name: 'alpha' },
  { id: 'proj-2', name: 'beta' },
];

const ITEM = {
  id: 'LOCAL-1', identifier: 'LOCAL-1', title: 'New issue', provider: 'local', url: '', state: null, description: null,
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  requests.length = 0;
  nextResponse = Response.json({ connected: true, item: ITEM });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const renderDialog = async (props: Partial<React.ComponentProps<typeof TrackerIssueDialog>> = {}) => {
  await act(async () => {
    root.render(
      <I18nProvider>
        <TrackerIssueDialog
          provider="local"
          mode="create"
          containers={CONTAINERS}
          onDone={() => undefined}
          onClose={() => undefined}
          {...props}
        />
      </I18nProvider>,
    );
  });
};

const setValue = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value',
  )?.set;
  if (!setter) throw new Error('Missing input value setter');
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const clickButton = async (text: string) => {
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent === text);
  if (!button) throw new Error(`Missing ${text} button`);
  await act(async () => { button.click(); });
  // The submit's mocked round trip (fetch, then response.json()) crosses
  // several microtask hops before its state lands.
  await act(async () => {
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
  });
};

describe('TrackerIssueDialog', () => {
  test('a create submit posts the create route with the form and finishes through onDone', async () => {
    const done: unknown[] = [];
    let closed = false;
    await renderDialog({ onDone: (item) => done.push(item), onClose: () => { closed = true; } });

    const createButton = [...host.querySelectorAll('button')].find((node) => node.textContent === 'Create issue');
    expect(createButton?.disabled).toBe(true);
    expect(host.textContent).toContain('Project');

    await setValue(host.querySelectorAll('input')[0], '  New issue  ');
    await setValue(host.querySelectorAll('textarea')[0], 'Body text');
    await setValue(host.querySelectorAll('input')[1], 'bug, ui ');
    await clickButton('Create issue');

    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/api/tracker/local/items/create');
    expect(requests[0].init.method).toBe('POST');
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      containerId: 'proj-1',
      title: 'New issue',
      description: 'Body text',
      priority: 'none',
      labels: ['bug', 'ui'],
    });
    expect(done).toEqual([ITEM]);
    expect(closed).toBe(true);
  });

  test('a failed create submit reports the failure and keeps the fields', async () => {
    nextResponse = Response.json({ error: 'containerId is required' }, { status: 400 });
    const done: unknown[] = [];
    let closed = false;
    await renderDialog({ onDone: (item) => done.push(item), onClose: () => { closed = true; } });

    await setValue(host.querySelectorAll('input')[0], 'Kept title');
    await clickButton('Create issue');

    expect(host.textContent).toContain('Creating the issue failed.');
    // SAFETY: the dialog's first field is the title input, so index 0 is one.
    expect((host.querySelectorAll('input')[0] as HTMLInputElement).value).toBe('Kept title');
    expect(done).toEqual([]);
    expect(closed).toBe(false);
  });

  test('an edit submit posts the edit route with the item id and the form', async () => {
    const done: unknown[] = [];
    await renderDialog({
      mode: 'edit',
      initial: {
        ...ITEM, title: 'Old title', description: 'Old body', priority: 'high',
        labels: [{ id: 'l1', name: 'bug', color: null }, { id: 'l2', name: 'ui', color: null }],
      },
      onDone: (item) => done.push(item),
    });

    // SAFETY: the dialog's first field is the title input, so index 0 is one.
    const title = host.querySelectorAll('input')[0] as HTMLInputElement;
    expect(title.value).toBe('Old title');
    await setValue(title, 'Renamed');
    await clickButton('Edit issue');

    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe('/api/tracker/local/items/edit');
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      id: 'LOCAL-1',
      title: 'Renamed',
      description: 'Old body',
      priority: 'high',
      labels: ['bug', 'ui'],
    });
    expect(done).toEqual([ITEM]);
  });
});

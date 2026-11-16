import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import type { SuggestionSummary } from '@/lib/suggestedTasksApi';
import { deferred, installSuggestedTasksDom, serveSuggestedTasks } from '@/lib/test-utils/suggestedTasks.fixture';

class EventSourceFixture {
  static CLOSED = 2;
  static instances: EventSourceFixture[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { EventSourceFixture.instances.push(this); }
  close() { this.readyState = EventSourceFixture.CLOSED; }
  emit(type: string) { this.onmessage?.({ data: JSON.stringify({ type, properties: { projectId: 'app' } }) }); }
}

const dom = installSuggestedTasksDom();
const eventSourceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
Object.defineProperty(globalThis, 'EventSource', { configurable: true, writable: true, value: EventSourceFixture });
const bootstrapServer = await serveSuggestedTasks(() => Response.json({}));
const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { useUIStore } = await import('@/stores/useUIStore');
const { useSuggestedTasksStore } = await import('@/stores/useSuggestedTasksStore');
const { subscribeOpenchamberEvents } = await import('@/lib/openchamberEvents');
const { useSidebarPages } = await import('./useSidebarPages');
const { SidebarPageRow } = await import('./SidebarPageRow');

type PagesProps = { enabled: boolean; visible: boolean; drawRows: boolean };
let metadataRenders = 0;
function Pages({ enabled, visible, drawRows }: PagesProps) {
  metadataRenders += 1;
  const pages = useSidebarPages(enabled);
  return drawRows ? <>{pages.map((page) => <SidebarPageRow key={page.id} page={page} visible={visible} />)}</> : null;
}

let server: Awaited<ReturnType<typeof serveSuggestedTasks>>;
let root: ReturnType<typeof createRoot>;
let projects: SuggestionSummary;
let reads = 0;
let failSummary = false;
const initialUI = useUIStore.getState();
const summarySettled = () => {
  const settled = deferred<void>();
  const release = useSuggestedTasksStore.subscribe((state, previous) => {
    if (state.summary === previous.summary && state.summaryError === previous.summaryError) return;
    release();
    settled.resolve();
  });
  return settled.promise;
};
const render = async (props: Partial<PagesProps> = {}) => {
  await act(async () => root.render(
    <I18nProvider><TooltipProvider><Pages enabled visible drawRows {...props} /></TooltipProvider></I18nProvider>,
  ));
};
const renderCount = async () => {
  const settled = summarySettled();
  await render();
  await act(async () => { await settled; });
};
const suggestedRow = () => document.querySelector<HTMLButtonElement>('button:has(use[href="#oc-lightbulb"])');
const source = () => {
  const stream = EventSourceFixture.instances.at(-1);
  if (!stream) throw new Error('No active event stream');
  return stream;
};

beforeEach(async () => {
  EventSourceFixture.instances = [];
  projects = [];
  reads = 0;
  failSummary = false;
  metadataRenders = 0;
  server = await serveSuggestedTasks((request) => {
    if (new URL(request.url).pathname !== '/api/openchamber/suggested-tasks/summary') return Response.json({});
    reads += 1;
    return failSummary ? Response.json({ error: 'Offline' }, { status: 503 }) : Response.json({ projects });
  });
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => {
  await act(async () => root.unmount());
  useUIStore.setState(initialUI);
  useI18nStore.getState().setLocale('en');
  Reflect.deleteProperty(window, '__VSCODE_CONFIG__');
  await server.stop(true);
  document.body.replaceChildren();
});
afterAll(async () => {
  await bootstrapServer.stop(true);
  if (eventSourceDescriptor) Object.defineProperty(globalThis, 'EventSource', eventSourceDescriptor);
  else Reflect.deleteProperty(globalThis, 'EventSource');
  await dom.restore();
});

test('lists Suggested tasks between Scheduled tasks and Archive', async () => {
  // Given the ordinary desktop Pages consumer.
  // When its rows mount.
  await renderCount();

  // Then the inbox has a direct entry in the migrated Pages section.
  const labels = [...document.querySelectorAll('button')].map((button) => button.textContent?.trim());
  const scheduled = labels.indexOf('Scheduled tasks');
  expect(labels.slice(scheduled, scheduled + 3)).toEqual(['Scheduled tasks', 'Suggested tasks', 'Archive']);
});

test('reflects an inbox opened elsewhere and toggles it with the Pages row', async () => {
  // Given Settings already opened the inbox.
  useUIStore.getState().setSuggestedTasksPageOpen(true);
  await render();
  const row = suggestedRow();
  expect(row?.getAttribute('aria-pressed')).toBe('true');
  expect(row?.classList.contains('oc-selected')).toBe(true);

  // When the selected entry is pressed.
  await act(async () => { row?.click(); });

  // Then the existing inbox closes and the entry loses its selected state.
  expect(useUIStore.getState().isSuggestedTasksPageOpen).toBe(false);
  expect(suggestedRow()?.getAttribute('aria-pressed')).toBe('false');
});

for (const event of ['openchamber:suggested-tasks-changed', 'openchamber:event-stream-ready']) {
  test(`refreshes the live open count on ${event} without rebuilding page metadata`, async () => {
    // Given a summary across projects, including a project without an open count.
    projects = [{ projectId: 'app', open: 2 }, { projectId: 'other', open: 5 }, { projectId: 'scanning', running: true }];
    await renderCount();
    expect(suggestedRow()?.textContent?.trim()).toBe('Suggested tasks (open: 7)');
    const renders = metadataRenders;
    projects = [{ projectId: 'app', open: 0 }, { projectId: 'other', open: 1 }];
    const settled = summarySettled();
    let forwarded = false;
    const release = subscribeOpenchamberEvents(({ type }) => {
      if (type === event.slice('openchamber:'.length)) forwarded = true;
    });

    // When the real control stream announces fresher server data.
    try {
      await act(async () => {
        source().emit(event);
        expect(forwarded).toBe(true);
        await settled;
      });
    } finally {
      release();
    }

    // Then only the count readout updates, with one summary read per event.
    expect(suggestedRow()?.textContent?.trim()).toBe('Suggested tasks (open: 1)');
    expect(reads).toBe(2);
    expect(metadataRenders).toBe(renders);
  });
}

for (const props of [{ enabled: false }, { visible: false }, { drawRows: false }]) {
  test(`does no summary or stream work for ${JSON.stringify(props)}`, async () => {
    // Given a disabled, hidden or metadata-only Pages consumer.
    // When it mounts.
    await render(props);

    // Then only an actually visible inbox entry can create observation demand.
    expect(reads).toBe(0);
    expect(EventSourceFixture.instances).toHaveLength(0);
  });
}

test('starts a fresh count when a hidden row becomes visible', async () => {
  // Given the mounted sidebar is hidden.
  await render({ visible: false });
  projects = [{ projectId: 'app', open: 4 }];
  const settled = summarySettled();

  // When the sidebar becomes visible.
  await render();
  await act(async () => { await settled; });

  // Then its row reads the current summary and shows the count.
  expect(reads).toBe(1);
  expect(suggestedRow()?.textContent?.trim()).toBe('Suggested tasks (open: 4)');
});

test('releases observation when the rendered sidebar is hidden', async () => {
  // Given a visible inbox entry observing the shared stream.
  await renderCount();
  const stream = source();

  // When its still-mounted sidebar becomes hidden.
  await render({ visible: false });
  await act(async () => { stream.emit('openchamber:event-stream-ready'); });

  // Then the last consumer releases the stream and starts no refresh.
  expect(stream.readyState).toBe(EventSourceFixture.CLOSED);
  expect(reads).toBe(1);
});

test('keeps the confirmed count when a summary refresh fails', async () => {
  // Given a confirmed open count.
  projects = [{ projectId: 'app', open: 3 }];
  await renderCount();
  failSummary = true;
  const settled = summarySettled();

  // When reconnecting cannot fetch the summary.
  await act(async () => { source().emit('openchamber:event-stream-ready'); await settled; });

  // Then failure never changes the known count to zero.
  expect(suggestedRow()?.textContent?.trim()).toBe('Suggested tasks (open: 3)');
  expect(useSuggestedTasksStore.getState().summaryError).toBe('Offline');
});

test('excludes the server-only entry and observation in VS Code', async () => {
  // Given VS Code bootstrap exists before mounting Pages.
  Object.defineProperty(window, '__VSCODE_CONFIG__', { configurable: true, value: {} });

  // When even an enabled consumer mounts there.
  await render();

  // Then it exposes no unsupported opener or server demand.
  expect(suggestedRow()).toBeNull();
  expect(reads).toBe(0);
  expect(EventSourceFixture.instances).toHaveLength(0);
});

test('localizes the live count without closing the open inbox', async () => {
  // Given a counted entry whose inbox is open.
  projects = [{ projectId: 'app', open: 2 }];
  useUIStore.getState().setSuggestedTasksPageOpen(true);
  await renderCount();
  const { dict } = await import('@/lib/i18n/messages/pt-BR');

  // When the user changes locale while the sidebar remains mounted.
  await act(async () => { useI18nStore.setState({ locale: 'pt-BR', dictionary: dict }); });

  // Then the same count and open state remain in the translated entry.
  expect(suggestedRow()?.textContent?.trim()).toBe('Tarefas sugeridas (abertas: 2)');
  expect(suggestedRow()?.getAttribute('aria-pressed')).toBe('true');
});

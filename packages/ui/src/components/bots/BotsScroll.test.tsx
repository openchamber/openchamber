import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { botItem, botsConfig } from '@/lib/bots/bots.fixture';
import { installSuggestedTasksDom, serveSuggestedTasks } from '@/lib/test-utils/suggestedTasks.fixture';

const dom = installSuggestedTasksDom();
const project = { id: 'project-1', path: '/repo' };
let revision = 1;
const server = await serveSuggestedTasks((request) => {
  const path = new URL(request.url).pathname;
  if (path.endsWith('/items/item-1')) return Response.json({ item: botItem({ revision }), reports: {}, snapshot: null });
  if (path.endsWith('/identities')) return Response.json({ identities: [] });
  if (path.endsWith('/bots')) return Response.json({ config: botsConfig(), revision, items: [botItem()], presets: [] });
  return Response.json({});
}, { projects: [project], activeProjectId: project.id });
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { useUIStore } = await import('@/stores/useUIStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { BotsView } = await import('./BotsPage');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { createWebAPIs } = await import('../../../../web/src/api/index');
const apis = createWebAPIs();
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  revision = 1;
  useUIStore.getState().closeMainSurfaces();
  useProjectsStore.setState({ projects: [project], activeProjectId: project.id });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  useUIStore.getState().closeMainSurfaces();
});
afterAll(async () => { await server.stop(true); await dom.restore(); });

function control(label: string): HTMLButtonElement {
  const element = [...container.querySelectorAll('button')].find((entry) => entry.textContent === label || entry.getAttribute('aria-label') === label);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return element;
}

function body(): HTMLElement {
  const element = container.firstElementChild;
  if (!(element instanceof HTMLElement) || !element.classList.contains('overflow-y-auto')) throw new Error('Missing mobile Bots scroll owner');
  return element;
}

async function waitFor(read: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (read()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  throw new Error('Expected Bots view did not appear');
}

async function openList(): Promise<void> {
  await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><ThemeSystemProvider><I18nProvider><BotsView layout="mobile" onLeave={() => {}} /></I18nProvider></ThemeSystemProvider></RuntimeAPIContext.Provider>));
  await waitFor(() => !control('New bot').disabled);
}

describe('mobile Bots view scroll ownership', () => {
  for (const label of ['Edit', 'New bot', 'Add item', 'Repair parser']) {
    test(`starts ${label} at the mobile page top after a scrolled list`, async () => {
      // Given the real mobile page is scrolled in the list.
      await openList();
      const owner = body();
      owner.scrollTop = 180;

      // When navigation replaces the list with an editor, create form or detail.
      await act(async () => control(label).click());

      // Then the same owning page starts at its top, including the project picker.
      expect(body()).toBe(owner);
      expect(owner.scrollTop).toBe(0);
    });
  }

  for (const label of ['Edit', 'Add item', 'Repair parser']) {
    test(`returns from ${label} to the list top`, async () => {
      // Given the editor, create form or detail has been scrolled.
      await openList();
      await act(async () => control(label).click());
      const owner = body();
      owner.scrollTop = 240;

      // When Back returns to the list.
      await act(async () => control('Back').click());

      // Then list navigation clears the preceding screen's position.
      expect(owner.scrollTop).toBe(0);
    });
  }

  test('preserves list scroll when a refresh replaces its snapshot', async () => {
    // Given a scrolled list with a loaded snapshot.
    await openList();
    const owner = body();
    owner.scrollTop = 180;
    revision += 1;

    // When a fresh snapshot arrives for the same screen.
    await act(async () => control('Refresh').click());
    await waitFor(() => !control('Refresh').disabled);

    // Then resource replacement does not navigate or reset scroll.
    expect(owner.scrollTop).toBe(180);
  });

  test('preserves editor scroll while typing', async () => {
    // Given an editor scrolled below its header.
    await openList();
    await act(async () => control('Edit').click());
    const owner = body();
    owner.scrollTop = 240;
    const input = container.querySelector('input[aria-label="Name"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('Missing editor name');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Missing native input setter');

    // When typing updates the existing definition draft.
    await act(async () => { setter.call(input, 'Renamed draft'); input.dispatchEvent(new Event('input', { bubbles: true })); });

    // Then the same editor and its user-selected position remain.
    expect(input.value).toBe('Renamed draft');
    expect(owner.scrollTop).toBe(240);
  });

  test('preserves detail scroll while refreshing the same item', async () => {
    // Given a scrolled detail whose next read has a newer item revision.
    await openList();
    await act(async () => control('Repair parser').click());
    const owner = body();
    owner.scrollTop = 240;
    revision += 1;

    // When the same item refreshes.
    await act(async () => control('Refresh').click());
    await waitFor(() => !control('Refresh').disabled);

    // Then an updated item record does not count as another destination.
    expect(owner.scrollTop).toBe(240);
  });
});

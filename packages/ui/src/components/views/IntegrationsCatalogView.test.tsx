import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Element as HappyElement, HTMLElement, Window } from 'happy-dom';

/** A card or button found by text, narrowed to happy-dom's clickable element. */
const findClickable = (elements: HappyElement[], text: string): HTMLElement | undefined =>
  elements.find((element): element is HTMLElement =>
    element instanceof HTMLElement && Boolean(element.textContent?.includes(text)));
const browser = new Window({ url: 'http://localhost' });
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
// React DOM detects input-event support when imported, so install the DOM first.
for (const [key, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  // happy-dom has no animation frame; base-ui's Collapsible mounts one per panel.
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  getComputedStyle: browser.getComputedStyle.bind(browser),
})) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useUIStore } = await import('@/stores/useUIStore');
const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
const { useMcpStore } = await import('@/stores/useMcpStore');
const { usePluginsStore } = await import('@/stores/usePluginsStore');
const { useSkillsStore } = await import('@/stores/useSkillsStore');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { IntegrationsCatalogView } = await import('./IntegrationsCatalogView');
const initialUI = useUIStore.getState();
const initialMcpConfig = useMcpConfigStore.getState();
const initialMcp = useMcpStore.getState();
const initialPlugins = usePluginsStore.getState();
const initialSkills = useSkillsStore.getState();

beforeEach(() => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUIStore.setState({ isIntegrationsCatalogOpen: true });
  // The page's mount effect refreshes each store; keep the test offline.
  useMcpConfigStore.setState({
    loadMcpConfigs: async () => true,
    createMcp: async () => ({ ok: true }),
    deleteMcp: async () => ({ ok: true }),
  });
  useMcpStore.setState({
    refresh: async () => undefined,
    connect: async () => undefined,
  });
  usePluginsStore.setState({
    loadPlugins: async () => true,
    loadRegistryInfo: async () => true,
    createEntry: async () => ({ ok: true }),
    deleteEntry: async () => ({ ok: true }),
  });
  useSkillsStore.setState({
    loadSkills: async () => true,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  useUIStore.setState(initialUI);
  useMcpConfigStore.setState(initialMcpConfig);
  useMcpStore.setState(initialMcp);
  usePluginsStore.setState(initialPlugins);
  useSkillsStore.setState(initialSkills);
  document.body.replaceChildren();
});

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, { value: descriptor, configurable: true });
    else Reflect.deleteProperty(globalThis, key);
  }
});
test('the catalog lists entries, filters by category and opens a detail page on click', async () => {
  useMcpConfigStore.setState({
    mcpServers: [{
      name: 'linear',
      type: 'remote',
      url: 'https://mcp.linear.app/mcp',
      scope: 'user',
    }],
  });
  await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
  const body = browser.document.body;

  expect(body.textContent?.includes('Linear')).toBe(true);
  expect(body.textContent?.includes('Playwright')).toBe(true);
  expect(body.textContent?.includes('Slack')).toBe(false);

  // Clicking a card opens that integration's detail page.
  const linearCard = findClickable([...body.querySelectorAll('[role="button"], button')], 'Linear');
  if (!linearCard) throw new Error('Linear card missing');
  await act(async () => linearCard.click());
  expect(body.textContent?.includes('Connect Linear so the agent can read your issues')).toBe(true);
  expect(body.textContent?.includes('Playwright')).toBe(false);

  // The detail breadcrumb returns to the grid.
  const back = findClickable([...body.querySelectorAll('nav button')], 'Integrations');
  if (!back) throw new Error('Back button missing');
  await act(async () => back.click());
  expect(body.textContent?.includes('Playwright')).toBe(true);
});

test('the category filter narrows the grid', async () => {
    await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
    const body = browser.document.body;
    const codeChip = [...body.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Code'));
    if (!codeChip) throw new Error('Category chip missing');
    await act(async () => codeChip.click());
    expect(body.textContent?.includes('GitHub')).toBe(true);
    expect(body.textContent?.includes('Playwright')).toBe(false);
  });

test('the rail lists installed integrations and opens one', async () => {
  useMcpConfigStore.setState({
    mcpServers: [{
      name: 'atlassian',
      type: 'remote',
      url: 'https://mcp.atlassian.com/v2/mcp',
      scope: 'user',
    }],
  });
  await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
  const body = browser.document.body;
  const rail = body.querySelector('aside');
  if (!rail) throw new Error('Rail missing');
  expect(rail.textContent?.includes('Installed1')).toBe(true);
  expect(rail.textContent?.includes('Linear')).toBe(false);

  const atlassian = [...rail.querySelectorAll('button')].find((button) => button.textContent?.includes('Atlassian'));
  if (!atlassian) throw new Error('Installed entry missing');
  await act(async () => atlassian.click());
  expect(body.querySelector('main h1')?.textContent).toBe('Atlassian');
  expect(body.textContent?.includes('Connection')).toBe(true);
});

test('the catalog flag follows the mutually exclusive full-page surface contract', () => {
  const store = useUIStore.getState();
  store.setIntegrationsCatalogOpen(true);
  expect(useUIStore.getState().isIntegrationsCatalogOpen).toBe(true);

  // Opening another surface closes the catalog.
  useUIStore.getState().setArchivePageOpen(true);
  expect(useUIStore.getState().isIntegrationsCatalogOpen).toBe(false);
  expect(useUIStore.getState().isArchivePageOpen).toBe(true);

  // Opening the catalog closes the archive.
  useUIStore.getState().setIntegrationsCatalogOpen(true);
  expect(useUIStore.getState().isArchivePageOpen).toBe(false);
  expect(useUIStore.getState().isIntegrationsCatalogOpen).toBe(true);

  // Selecting a session closes every full-page surface.
  useUIStore.getState().closeMainSurfaces();
  expect(useUIStore.getState().isIntegrationsCatalogOpen).toBe(false);

  // Closing the catalog leaves the other surfaces untouched.
  useUIStore.getState().setIntegrationsCatalogOpen(true);
  useUIStore.getState().setIntegrationsCatalogOpen(false);
  expect(useUIStore.getState().isIntegrationsCatalogOpen).toBe(false);
  expect(useUIStore.getState().isUsageStatsPageOpen).toBe(false);
});

test('a needs-auth server shows the sign-in state on its detail page', async () => {
  useMcpConfigStore.setState({
    mcpServers: [{
      name: 'linear',
      type: 'remote',
      url: 'https://mcp.linear.app/mcp',
      scope: 'user',
    }],
  });
  useMcpStore.setState({
    byDirectory: { [useDirectoryStore.getState().currentDirectory ?? '__global__']: { linear: { name: 'linear', status: { status: 'needs_auth', error: 'Authorization required' } } } },
  });
  await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
  const pillBefore = browser.document.body.textContent?.includes('Sign-in required');
  expect(pillBefore).toBe(true);
  const linearCard = findClickable([...browser.document.body.querySelectorAll('[role="button"], button')], 'Linear');
  if (!linearCard) throw new Error('Linear card missing');
  await act(async () => linearCard.click());
  expect(browser.document.body.textContent?.includes('Waiting for sign-in')).toBe(true);
});

test('a same-named skill outside the catalog folder does not count as installed', async () => {
  useSkillsStore.setState({
    skills: [
      { id: 'pdf', name: 'pdf', path: '/home/user/.claude/skills/pdf/SKILL.md', scope: 'user', source: 'claude' },
      { id: 'pdf', name: 'pdf', path: '/repo/.agents/skills/pdf/SKILL.md', scope: 'project', source: 'agents' },
    ],
  });
  await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
  const railText = () => browser.document.body.querySelector('aside')?.textContent ?? '';
  expect(railText().includes('Installed0')).toBe(true);

  // The catalog's own copy, in the user's OpenCode skills folder, counts.
  await act(async () => useSkillsStore.setState({
    skills: [
      ...useSkillsStore.getState().skills,
      { id: 'pdf', name: 'pdf', path: '/home/user/.config/opencode/skills/pdf/SKILL.md', scope: 'user', source: 'opencode' },
    ],
  }));
  expect(railText().includes('Installed1')).toBe(true);
});

test('a detail page opens at its top and going back restores the browse scroll', async () => {
  await act(async () => root.render(<I18nProvider><IntegrationsCatalogView /></I18nProvider>));
  const body = browser.document.body;
  const scroller = body.querySelector('main');
  if (!scroller) throw new Error('Scroller missing');
  scroller.scrollTop = 600;
  await act(async () => scroller.dispatchEvent(new browser.Event('scroll')));

  const card = findClickable([...body.querySelectorAll('main [role="button"]')], 'Notion');
  if (!card) throw new Error('Notion row missing');
  await act(async () => card.click());
  expect(scroller.scrollTop).toBe(0);

  const back = findClickable([...body.querySelectorAll('nav button')], 'Integrations');
  if (!back) throw new Error('Back button missing');
  await act(async () => back.click());
  expect(scroller.scrollTop).toBe(600);
});

import { afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  return Response.json(url.includes('/config/mcp') ? [] : { home: '/test' });
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useAgentsStore } = await import('@/stores/useAgentsStore');
plugin({
  name: 'agent-settings-provider-logos',
  setup(build) {
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const directory = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith('.svg')).map((name) => [
        `../assets/provider-logos/${name}`, pathToFileURL(resolve(directory, name)).href,
      ]));
      return { contents: readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
    });
  },
});
const { AgentsPage } = await import('./AgentsPage');
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.unmount()); fetchSpy.mockRestore(); browser.close(); });

test('a system-scoped agent renders read-only with the managed-config note', async () => {
  const agent = { id: 'org-build', name: 'org-build', displayName: 'org-build', mode: 'subagent' as const,
    description: 'Builds things', system: 'Be helpful.',
    request: { settings: {}, headers: {}, body: {} }, hidden: false, permissions: [], scope: 'system', path: '/etc/opencode/agents/org-build.md' };
  let updateCalls = 0;
  useAgentsStore.setState({
    selectedAgentName: 'org-build', agentsByDirectory: { __default__: [agent] },
    getAgentByName: () => useAgentsStore.getState().agentsByDirectory.__default__?.[0] ?? null,
    fetchAgentEntity: async () => ({ source: 'md', scope: 'system', path: '/etc/opencode/agents/org-build.md', legacy: false, config: { description: 'Builds things', system: 'Be helpful.' } }),
    fetchAgentPermissions: async () => ({ global: [], agent: [], effective: [], source: 'md', path: '/etc/opencode/agents/org-build.md' }),
    updateAgent: async () => { updateCalls += 1; return { ok: true }; },
  });
  await act(async () => { root.render(<I18nProvider><AgentsPage /></I18nProvider>); });

  // The managed-config note names the file the agent is defined in.
  const note = [...container.querySelectorAll('p')].find((entry) => entry.textContent?.includes('system configuration'));
  expect(note).toBeDefined();
  expect(note?.textContent).toContain('/etc/opencode/agents/org-build.md');

  // Every editable field is disabled.
  const textareas = [...container.querySelectorAll<HTMLTextAreaElement>('textarea')];
  expect(textareas.length).toBeGreaterThan(0);
  expect(textareas.every((field) => field.disabled === true)).toBe(true);

  // The mode chips are disabled too.
  const modeButtons = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .filter((button) => ['Primary', 'Subagent', 'All'].includes(button.textContent?.trim() ?? ''));
  expect(modeButtons.length).toBe(3);
  expect(modeButtons.every((button) => button.disabled === true)).toBe(true);

  // The permissions editor stays away: its writes could never take effect.
  expect([...container.querySelectorAll('*')].some((entry) => entry.textContent === 'Tool permissions')).toBe(false);

  // Editing through the disabled fields is impossible; no update was sent.
  expect(updateCalls).toBe(0);
});
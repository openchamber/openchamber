import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import type { SuggestedTaskLens } from '@/lib/suggestedTasksApi';
import { installSuggestedTasksDom, settings, suggestion } from '@/lib/test-utils/suggestedTasks.fixture';
import { dict } from '@/lib/i18n/messages/en';

const dom = installSuggestedTasksDom();
const previousFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : input.toString();
  return Response.json(url.includes('/mcp-tools') ? { status: 'ready', servers: [] } : {});
}, previousFetch);
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useRoutingStore } = await import('@/stores/useRoutingStore');
const { SuggestedLensEditorDialog } = await import('./SuggestedLensEditorDialog');
const { SuggestionCard } = await import('./SuggestionCard');
let root: Root;
let saved: SuggestedTaskLens[];
const initialRouting = useRoutingStore.getState();
beforeEach(() => {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  saved = [];
  useRoutingStore.setState({ available: true, jevAvailable: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  useRoutingStore.setState(initialRouting);
  document.body.replaceChildren();
});
afterAll(async () => { globalThis.fetch = previousFetch; await dom.restore(); });
const render = async (patch: Partial<SuggestedTaskLens> = {}) => {
  const lens = settings().config.lenses[0];
  if (!lens) throw new Error('Missing lens');
  await act(async () => root.render(<I18nProvider><SuggestedLensEditorDialog
    lens={{ ...lens, action: 'session', ...patch }} projectId="app" directory="/repo" canCreateWorktree isNew={false}
    onOpenChange={() => undefined} onDelete={async () => true} onSave={async (value) => { saved.push(value); return true; }}
  /></I18nProvider>));
};
const button = (label: string) => {
  const found = [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};

describe('automatic lens session permissions', () => {
  for (const [mode, label] of [
    ['default', 'Session default'], ['ask', 'Ask every time'], ['safety', 'Safety net'], ['auto', 'Accept everything'],
  ] as const) {
    test(`saves ${mode} without dropping configured MCP tools`, async () => {
      // Given a lens with saved MCP tools absent from the catalog.
      const mcp: SuggestedTaskLens['mcp'] = [{ server: 'jira', tools: { old_tool: 'ask' } }];
      await render({ mcp, permissionMode: mode === 'default' ? 'auto' : 'default' });

      // When a session mode is chosen and the lens is saved.
      await act(async () => button(label).click());
      await act(async () => button('Save').click());

      // Then both the chosen session policy and saved MCP rules reach persistence.
      expect(saved[0]?.permissionMode).toBe(mode);
      expect(saved[0]?.mcp).toEqual(mcp);
    });
  }

  test('keeps the command warning visible when Auto is chosen', async () => {
    // Given an automatic-session action.
    await render();

    // When Auto is selected.
    await act(async () => button('Accept everything').click());

    // Then the warning is visible without a tooltip interaction.
    expect(document.querySelector('[role="status"]')?.textContent).toContain(dict['suggestedTasks.lens.editor.autoWarning']);
    expect(document.body.textContent).toContain(dict['suggestedTasks.lens.editor.mcpWarning']);
  });

  test('disables Safety and exposes its reason when the composer classifier is unavailable', async () => {
    // Given the same unavailable classification state the composer reads.
    useRoutingStore.setState({ jevAvailable: false });
    await render();

    // When the unavailable mode is pressed and the lens is saved.
    await act(async () => button('Safety net').click());
    await act(async () => button('Save').click());

    // Then no unavailable policy is admitted, and the reason remains readable on touch.
    expect(button('Safety net').disabled).toBe(true);
    expect(saved[0]?.permissionMode).toBe('default');
    expect(document.body.textContent).toContain(dict['settings.sessions.permissions.explain.safetyUnavailable']);
  });

  test('preserves an already saved Safety choice while the classifier is temporarily unavailable', async () => {
    // Given a saved Safety lens during classifier unavailability.
    useRoutingStore.setState({ jevAvailable: false });
    await render({ permissionMode: 'safety' });

    // When another lens edit is saved.
    await act(async () => button('Save').click());

    // Then the saved choice is not silently rewritten.
    expect(saved[0]?.permissionMode).toBe('safety');
  });

  for (const action of ['suggest', 'todo'] as const) {
    test(`hides session permissions for ${action}`, async () => {
      // Given an action that creates no session.
      await render({ action });

      // When its editor is shown, then no automatic-session mode is offered.
      expect(document.querySelector('[aria-label="Automatic session permissions"]')).toBeNull();
    });
  }
});

test('shows evidence as visible plain text with safe external source links', async () => {
  // Given a suggestion with linked and unlinked evidence.
  const evidence = [
    { source: 'APP-42', summary: 'Steps reproduce on the current branch.', url: 'https://jira.example/APP-42' },
    { source: 'Audit', summary: '<script>not executable</script>' },
  ];

  // When its card renders.
  await act(async () => root.render(<I18nProvider><SuggestionCard suggestion={suggestion({ evidence })} projectPath="/repo"
    issueProviders={[]} canCreateWorktree botsAvailable={false} busy={false} onDecide={() => undefined} /></I18nProvider>));

  // Then both summaries remain exposed and source navigation is isolated.
  const section = document.querySelector('[aria-label="Evidence"]');
  expect(section?.textContent).toContain(evidence[0]?.summary);
  expect(section?.textContent).toContain(evidence[1]?.summary);
  expect(section?.querySelector('script')).toBeNull();
  expect(section?.querySelector('a')?.getAttribute('href')).toBe(evidence[0]?.url);
  expect(section?.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
});

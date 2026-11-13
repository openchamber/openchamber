import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { TodoSendExecution } from './todoSendExecution';

const dom = new Window();
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

type DirectoryDefaults = { agentName?: string; providerId: string; modelId: string; variant?: string | null };
type Deferred = { directory: string; resolve: (value: DirectoryDefaults | null) => void };

let pending: Deferred[] = [];
const configState = {
  providers: [
    { id: 'fallback', models: [{ id: 'first-model' }] },
    { id: 'anthropic', models: [{ id: 'claude', variants: [{ id: 'high' }] }] },
    { id: 'picked', models: [{ id: 'picked-model', variants: [{ id: 'picked-effort' }] }] },
  ],
  agents: [],
  // The composer of whatever session is open; the dialog must not start from it.
  currentProviderId: 'elsewhere',
  currentModelId: 'composer-model',
  currentAgentName: 'review',
  loadProviders: async () => undefined,
  loadAgents: async () => true,
  getDefaultVariantForModel: () => undefined,
  resolveDirectoryDefaultSelection: (directory: string) => new Promise<DirectoryDefaults | null>((resolve) => {
    pending.push({ directory, resolve });
  }),
};

mock.module('@/stores/useConfigStore', () => ({
  selectProvidersForDirectory: (state: typeof configState) => state.providers,
  selectConfigAgentsForDirectory: (state: typeof configState) => state.agents,
  useConfigStore: Object.assign(
    <R,>(selector: (state: typeof configState) => R): R => selector(configState),
    { getState: () => configState },
  ),
}));
mock.module('@/stores/useAgentsStore', () => ({
  useAgentsStore: <R,>(selector: (state: { loadAgents: () => Promise<void> }) => R): R => selector({ loadAgents: async () => undefined }),
}));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/lib/desktop', () => ({ isVSCodeRuntime: () => false }));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: <R,>(selector: (state: { isMobile: boolean }) => R): R => selector({ isMobile: false }),
}));
mock.module('@/lib/modelEfforts', () => ({ resolveEffortForModelSelection: () => 'picked-effort' }));
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" data-action="button" onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));
mock.module('@/components/ui/checkbox', () => ({ Checkbox: () => null }));
mock.module('@/components/sections/agents/ModelSelector', () => ({
  ModelSelector: ({ providerId, modelId, onChange }: { providerId: string; modelId: string; onChange: (p: string, m: string) => void }) => (
    <button type="button" data-model={`${providerId}/${modelId}`} onClick={() => onChange('picked', 'picked-model')} />
  ),
}));
mock.module('@/components/sections/commands/AgentSelector', () => ({
  AgentSelector: ({ agentName }: { agentName: string }) => <span data-agent={agentName} />,
}));
mock.module('@/components/session/ThinkingPill', () => ({
  ThinkingPill: ({ value }: { value: string }) => <span data-variant={value} />,
}));

const { createRoot } = await import('react-dom/client');
const { TodoSendDialog } = await import('./TodoSendDialog');

const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
const confirmed: TodoSendExecution[] = [];

const render = (projectDirectory: string) => act(async () => {
  root.render(
    <TodoSendDialog
      open
      onOpenChange={() => undefined}
      target="worktree"
      projectDirectory={projectDirectory}
      onConfirm={(execution) => { confirmed.push(execution); }}
    />,
  );
});
const settle = (deferred: Deferred | undefined, value: DirectoryDefaults | null) => act(async () => {
  deferred?.resolve(value);
});
const shownModel = () => host.querySelector('[data-model]')?.getAttribute('data-model');
const shownAgent = () => host.querySelector('[data-agent]')?.getAttribute('data-agent');
const send = () => act(async () => {
  Array.from(host.querySelectorAll<HTMLElement>('[data-action="button"]'))
    .find((element) => element.textContent === 'rightSidebar.contextNotesTodo.sendDialog.actions.send')
    ?.click();
});

beforeEach(async () => {
  pending = [];
  confirmed.length = 0;
  await act(async () => root.render(null));
});

afterAll(() => {
  act(() => root.unmount());
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test('starts on the defaults of the project it sends to', async () => {
  await render('/repo-b');

  await settle(pending[0], { agentName: 'plan', providerId: 'anthropic', modelId: 'claude', variant: 'high' });
  await send();

  expect(pending.map((entry) => entry.directory)).toEqual(['/repo-b']);
  expect(confirmed).toEqual([{
    providerID: 'anthropic', modelID: 'claude', variant: 'high', agent: 'plan',
    picked: { model: false, variant: false, agent: false },
  }]);
});

test('a skeleton holds the model field and the send waits until the defaults arrive', async () => {
  await render('/repo-b');
  expect(shownModel()).toBeUndefined();
  expect(host.querySelector('[data-slot="skeleton"]')?.getAttribute('aria-label')).toBe('common.loading');
  await send();
  expect(confirmed).toEqual([]);

  await settle(pending[0], { agentName: 'plan', providerId: 'anthropic', modelId: 'claude', variant: 'high' });
  expect(host.querySelector('[data-slot="skeleton"]')).toBeNull();
  await act(async () => {
    host.querySelector<HTMLElement>('[data-model]')?.click();
  });
  await send();

  expect(confirmed).toEqual([{
    providerID: 'picked', modelID: 'picked-model', variant: 'picked-effort', agent: 'plan',
    picked: { model: true, variant: false, agent: false },
  }]);
});

test('defaults of a project the dialog left never land', async () => {
  await render('/repo-a');
  await render('/repo-b');
  await settle(pending[1], { agentName: 'plan', providerId: 'anthropic', modelId: 'claude' });
  await settle(pending[0], { agentName: 'build', providerId: 'openai', modelId: 'gpt' });

  expect(shownModel()).toBe('anthropic/claude');
  expect(shownAgent()).toBe('plan');
});

test('a configured model the catalog has not listed keeps its effort', async () => {
  await render('/repo-b');
  await settle(pending[0], { agentName: 'plan', providerId: 'unlisted', modelId: 'configured', variant: 'max' });
  await send();

  expect(confirmed[0]?.variant).toBe('max');
});

test('a project with no resolvable model falls back to the first model offered', async () => {
  await render('/repo-b');
  await settle(pending[0], null);

  expect(shownModel()).toBe('fallback/first-model');
});

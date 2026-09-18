import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { DesktopSettings } from '@/lib/desktop';

type ProviderState = {
  id: string;
  models: Array<{ id: string; variants?: Record<string, boolean> }>;
};

type ConfigState = {
  providers: ProviderState[];
  modelsMetadata: Map<string, never>;
  setProvider: () => void;
  setModel: () => void;
  setAgent: () => void;
  setCurrentVariant: () => void;
  setCurrentVariantOverride: () => void;
  setSettingsDefaultModel: () => void;
  setSettingsDefaultVariant: () => void;
  setSettingsDefaultAgent: () => void;
  selectionSource: 'auto';
};

const configState: ConfigState = {
  providers: [],
  modelsMetadata: new Map<string, never>(),
  setProvider: () => undefined,
  setModel: () => undefined,
  setAgent: () => undefined,
  setCurrentVariant: () => undefined,
  setCurrentVariantOverride: () => undefined,
  setSettingsDefaultModel: () => undefined,
  setSettingsDefaultVariant: () => undefined,
  setSettingsDefaultAgent: () => undefined,
  selectionSource: 'auto',
};

const settingsState = {
  showDeletionDialog: false,
  setShowDeletionDialog: () => undefined,
};

const selectionState = {
  getSessionModelSelection: () => undefined,
  getSessionAgentSelection: () => undefined,
};

const sessionState = { currentSessionId: null } satisfies { currentSessionId: string | null };
let savedSettings: DesktopSettings | null = null;
const updateCalls: Array<Partial<DesktopSettings>> = [];

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: <T,>(selector: (state: ConfigState) => T): T => selector(configState),
}));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: <T,>(selector: (state: typeof settingsState) => T): T => selector(settingsState),
}));
mock.module('@/sync/selection-store', () => ({
  useSelectionStore: <T,>(selector: (state: typeof selectionState) => T): T => selector(selectionState),
}));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: <T,>(selector: (state: typeof sessionState) => T): T => selector(sessionState),
}));
mock.module('@/lib/persistence', () => ({
  loadDesktopSettings: async () => savedSettings,
  updateDesktopSettings: async (changes: Partial<DesktopSettings>) => {
    updateCalls.push(changes);
    return { ok: true };
  },
}));
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async () => new Response(JSON.stringify({ authenticatedProviders: [] }), {
    headers: { 'Content-Type': 'application/json' },
  }),
}));
mock.module('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
mock.module('@/components/chat/mobileControlsUtils', () => ({
  isPrimaryMode: (mode: string | undefined) => mode === 'primary',
}));
mock.module('@/components/sections/agents/ModelSelector', () => ({
  ModelSelector: () => <button type="button">model</button>,
}));
mock.module('@/components/sections/commands/AgentSelector', () => ({
  AgentSelector: () => <button type="button">agent</button>,
}));
mock.module('@/components/sections/shared/SettingsInfoHint', () => ({
  SettingsInfoHint: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
mock.module('@/components/sections/shared/SettingsSection', () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  SettingsFieldRow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsCheckboxRow: ({ children, label }: { children?: React.ReactNode; label?: React.ReactNode }) => (
    <div>{label}{children}</div>
  ),
  SettingsInset: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsGroupTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SETTINGS_CUSTOM_TRIGGER_CLASS: '',
  SETTINGS_SELECT_ROW_TRIGGER_CLASS: '',
  SETTINGS_SELECT_SIZE: 'sm',
  SETTINGS_OPTION_STACK_CLASS: '',
}));
mock.module('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

const { DefaultsSettings } = await import('./DefaultsSettings');

describe('DefaultsSettings', () => {
  let windowInstance: Window;
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    savedSettings = {
      defaultModel: 'sidecar/model',
      defaultVariant: 'high',
    };
    updateCalls.length = 0;
    configState.providers = [{ id: 'sidecar', models: [{ id: 'model', variants: { high: true } }] }];
    windowInstance = new Window({ url: 'http://localhost/' });
    // SAFETY: the test installs a happy-dom Window for the component and restores the original global afterward.
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      Node: windowInstance.Node,
      Element: windowInstance.Element,
      HTMLElement: windowInstance.HTMLElement,
      Event: windowInstance.Event,
      MouseEvent: windowInstance.MouseEvent,
      MutationObserver: windowInstance.MutationObserver,
      getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
      requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
      cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    windowInstance.close();
  });

  test('retains a saved model variant while the model disappears and returns', async () => {
    await act(async () => {
      root.render(<DefaultsSettings />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('High');

    configState.providers = [];
    await act(async () => {
      root.render(<DefaultsSettings />);
      await Promise.resolve();
    });

    expect(host.textContent).toContain('High');
    expect(updateCalls).toEqual([]);

    configState.providers = [{ id: 'sidecar', models: [{ id: 'model', variants: { high: true } }] }];
    await act(async () => {
      root.render(<DefaultsSettings />);
      await Promise.resolve();
    });

    expect(host.textContent).toContain('sidecar/model');
    expect(host.textContent).toContain('High');
    expect(updateCalls).toEqual([]);
  });
});

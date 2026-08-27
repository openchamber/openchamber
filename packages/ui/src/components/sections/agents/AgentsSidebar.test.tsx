import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

type ClickEvent = { stopPropagation: () => void };
type ClickHandler = (event: ClickEvent) => void;
type ChildrenProps = { children?: React.ReactNode };
type ClickableProps = ChildrenProps & { onClick?: ClickHandler };
type TriggerProps = ChildrenProps & { render?: React.ReactNode };

interface AgentDraftSnapshot {
  name: string;
  scope: string;
  description?: string;
  model?: string | null;
  variant?: string;
  temperature?: number;
  top_p?: number;
  prompt?: string;
  mode?: string;
  permission?: Record<string, string>;
  disable?: boolean;
}

interface AgentRecord {
  name: string;
  description: string;
  model: { providerID: string; modelID: string };
  variant: string;
  temperature: number;
  topP: number;
  prompt: string;
  mode: string;
  permission: Array<{ permission: string; pattern: string; action: 'allow' | 'ask' | 'deny' }>;
  scope: string;
  disable: boolean;
}

interface AgentStoreState {
  selectedAgentName: string | null;
  agents: AgentRecord[];
  setAgentDraft: (draft: AgentDraftSnapshot) => void;
  setSelectedAgent: (name: string) => void;
  createAgent: () => Promise<{ ok: boolean }>;
  deleteAgent: () => Promise<{ ok: boolean }>;
  loadAgents: () => Promise<void>;
}

const sourceAgent: AgentRecord = {
  name: 'writer',
  description: 'Writes concise documentation',
  model: { providerID: 'openai', modelID: 'gpt-4.1' },
  variant: 'fast',
  temperature: 0.4,
  topP: 0.8,
  prompt: 'Write clear documentation.',
  mode: 'subagent',
  permission: [{ permission: 'bash', pattern: '*', action: 'ask' }],
  scope: 'project',
  disable: true,
};

let recordedDraft: AgentDraftSnapshot | null = null;
let selectedAgentName: string | null = null;
let duplicateMenuClick: ClickHandler | null = null;
let mobileDevice = true;

const agentStore: AgentStoreState = {
  selectedAgentName: null,
  agents: [sourceAgent],
  setAgentDraft: (draft) => {
    recordedDraft = draft;
  },
  setSelectedAgent: (name) => {
    selectedAgentName = name;
  },
  createAgent: async () => ({ ok: true }),
  deleteAgent: async () => ({ ok: true }),
  loadAgents: async () => {},
};

function useAgentsStore<Selected>(selector: (state: AgentStoreState) => Selected): Selected {
  return selector(agentStore);
}

function useShallow<Selector>(selector: Selector): Selector {
  return selector;
}

mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick }: ClickableProps) => <button onClick={onClick}>{children}</button>,
}));

mock.module('@/components/ui/input', () => ({
  Input: () => <input />,
}));

mock.module('@/components/ui', () => ({
  toast: { error: () => {}, success: () => {}, warning: () => {} },
}));

mock.module('@/lib/device', () => ({
  isMobileDeviceViaCSS: () => mobileDevice,
}));

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children }: ChildrenProps) => <>{children}</>,
  DialogContent: ({ children }: ChildrenProps) => <div>{children}</div>,
  DialogDescription: ({ children }: ChildrenProps) => <div>{children}</div>,
  DialogFooter: ({ children }: ChildrenProps) => <div>{children}</div>,
  DialogHeader: ({ children }: ChildrenProps) => <div>{children}</div>,
  DialogTitle: ({ children }: ChildrenProps) => <div>{children}</div>,
}));

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: ChildrenProps) => <>{children}</>,
  DropdownMenuContent: ({ children }: ChildrenProps) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: ClickableProps) => {
    if (React.Children.toArray(children).includes('Duplicate')) {
      duplicateMenuClick = onClick ?? null;
    }
    return <button onClick={onClick}>{children}</button>;
  },
  DropdownMenuTrigger: ({ children }: ChildrenProps) => <>{children}</>,
}));

mock.module('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: ChildrenProps) => <>{children}</>,
  ContextMenuContent: ({ children }: ChildrenProps) => <div>{children}</div>,
  ContextMenuItem: ({ children }: ChildrenProps) => <div>{children}</div>,
  ContextMenuTrigger: ({ children, render }: TriggerProps) => <>{render}{children}</>,
}));

mock.module('@/hooks/useSettingsDirectory', () => ({
  useSettingsDirectory: () => '/workspace',
}));

mock.module('@/stores/useAgentsStore', () => ({
  useAgentsStore,
  selectAgentsForDirectory: (state: AgentStoreState) => state.agents,
  isAgentBuiltIn: () => false,
  isAgentHidden: () => false,
}));

mock.module('zustand/react/shallow', () => ({ useShallow }));

mock.module('@/lib/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}));

mock.module('@/components/ui/ScrollableOverlay', () => ({
  ScrollableOverlay: ({ children }: ChildrenProps) => <div>{children}</div>,
}));

mock.module('@/components/sections/shared/SettingsProjectSelector', () => ({
  SettingsProjectSelector: () => null,
}));

mock.module('@/components/sections/shared/SidebarGroup', () => ({
  SidebarGroup: ({ children }: ChildrenProps) => <>{children}</>,
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: () => null,
}));

mock.module('@/lib/i18n', () => ({
  useI18n: () => ({
    t: (key: string) => (key === 'settings.common.actions.duplicate' ? 'Duplicate' : key),
  }),
}));

mock.module('@/components/sections/shared/SettingsSection', () => ({
  SETTINGS_PANEL_TITLE_CLASS: '',
}));

const { AgentsSidebar } = await import('./AgentsSidebar');

function getDuplicateMenuClick(): ClickHandler {
  if (!duplicateMenuClick) {
    throw new Error('Expected the duplicate action to be rendered');
  }
  return duplicateMenuClick;
}

describe('AgentsSidebar duplicate action', () => {
  test('notifies the mobile split-view parent once after preparing a prefilled agent draft', () => {
    recordedDraft = null;
    selectedAgentName = null;
    duplicateMenuClick = null;
    mobileDevice = true;
    let mobileTransitionCount = 0;

    renderToStaticMarkup(
      <AgentsSidebar onItemSelect={() => { mobileTransitionCount += 1; }} />,
    );

    getDuplicateMenuClick()({ stopPropagation: () => {} });

    expect(recordedDraft).toEqual({
      name: 'writer-copy',
      scope: 'project',
      description: 'Writes concise documentation',
      model: 'openai/gpt-4.1',
      variant: 'fast',
      temperature: 0.4,
      top_p: 0.8,
      prompt: 'Write clear documentation.',
      mode: 'subagent',
      permission: { bash: 'ask' },
      disable: true,
    });
    expect(selectedAgentName).toBe('writer-copy');
    expect(mobileTransitionCount).toBe(1);
  });

  test('does not require a mobile transition callback on desktop', () => {
    recordedDraft = null;
    selectedAgentName = null;
    duplicateMenuClick = null;
    mobileDevice = false;

    renderToStaticMarkup(<AgentsSidebar />);

    getDuplicateMenuClick()({ stopPropagation: () => {} });
    expect(selectedAgentName).toBe('writer-copy');
  });
});

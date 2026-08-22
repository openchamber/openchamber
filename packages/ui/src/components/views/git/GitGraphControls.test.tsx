import React from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import type { GitAPI } from '@/lib/api/types';
import type { GitRepositoryPaneState } from '@/stores/useUIStore';

type MockButtonProps = React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: string;
  size?: string;
}>;

type GraphQuery = {
  mode: 'auto' | 'all' | 'manual';
  refIds?: string[];
};

type MockRefsState = {
  refs: {
    refs: Array<{ id: string; name: string; revision: string; kind: 'local' | 'remote'; category: 'branches' | 'remote-branches' }>;
    current: { id: string; name: string; revision: string; kind: 'local'; category: 'branches' } | null;
    upstream: { id: string; name: string; revision: string; kind: 'remote'; category: 'remote-branches' } | null;
    base: null;
  } | null;
  refsError: string | null;
  isLoadingRefs: boolean;
};

type MockQueryState = {
  items: Array<{ id: string }>;
  outdated: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  hasMore: boolean;
} | null;

type MockUIStoreState = {
  gitRepositoryPaneStates: Record<string, GitRepositoryPaneState>;
  setGitRepositoryPaneState: typeof mockSetPaneState;
};

type MockGitStoreState = {
  ensureHistoryRefs: typeof mockEnsureHistoryRefs;
  fetchHistoryPage: typeof mockFetchHistoryPage;
};

type RenderedButton = {
  props: MockButtonProps;
  label: string;
  ariaLabel: string | undefined;
};

const renderedButtons: RenderedButton[] = [];

mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: MockButtonProps) => {
    const renderedChildren = String(children ?? '');
    const label = renderedChildren === '[object Object]' ? '' : renderedChildren;
    renderedButtons.push({ props: { ...props, children }, label, ariaLabel: props['aria-label'] });
    return React.createElement('button', props, children);
  },
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: () => React.createElement('span'),
}));

let gitPaneState: GitRepositoryPaneState = {
  changesCollapsed: false,
  graphCollapsed: false,
  graphHeight: 280,
  graphFilterMode: 'auto',
  graphManualRefIds: [],
};

const paneStateCalls: Array<[
  string,
  Partial<GitRepositoryPaneState> | ((current: GitRepositoryPaneState) => Partial<GitRepositoryPaneState>),
]> = [];
const ensureHistoryRefsCalls: Array<[string, GitAPI]> = [];
const fetchHistoryPageCalls: Array<[string, GitAPI, GraphQuery]> = [];

/* eslint-disable @typescript-eslint/no-unused-vars */
let mockSetPaneState = mock((_directory: string, _updates: Partial<GitRepositoryPaneState> | ((current: GitRepositoryPaneState) => Partial<GitRepositoryPaneState>)) => undefined);
let mockEnsureHistoryRefs = mock(async (_directory: string, _git: GitAPI) => null);
let mockFetchHistoryPage = mock(async (_directory: string, _git: GitAPI, _query: GraphQuery) => undefined);
/* eslint-enable @typescript-eslint/no-unused-vars */

const createMockRefsState = (): MockRefsState => ({
  refs: {
    refs: [
      { id: 'refs/heads/topic', name: 'topic', revision: 'commit-a', kind: 'local', category: 'branches' },
      { id: 'refs/remotes/origin/topic', name: 'origin/topic', revision: 'commit-b', kind: 'remote', category: 'remote-branches' },
    ],
    current: { id: 'refs/heads/topic', name: 'topic', revision: 'commit-a', kind: 'local', category: 'branches' },
    upstream: { id: 'refs/remotes/origin/topic', name: 'origin/topic', revision: 'commit-b', kind: 'remote', category: 'remote-branches' },
    base: null,
  },
  refsError: null,
  isLoadingRefs: false,
});

const createMockQueryState = (): NonNullable<MockQueryState> => ({
  items: [],
  outdated: false,
  isLoading: false,
  isLoadingMore: false,
  error: null,
  hasMore: false,
});

let mockRefsState = createMockRefsState();
let mockQueryState: MockQueryState = createMockQueryState();

mock.module('@/stores/useUIStore', () => ({
  DEFAULT_GIT_REPOSITORY_PANE_STATE: gitPaneState,
  gitRepositoryPanePreferenceKey: (directory: string) => directory,
  useUIStore: <T,>(selector: (state: MockUIStoreState) => T) => selector({
    gitRepositoryPaneStates: { '/repo': gitPaneState },
    setGitRepositoryPaneState: mockSetPaneState,
  }),
}));

mock.module('@/stores/useGitStore', () => ({
  useGitStore: <T,>(selector: (state: MockGitStoreState) => T) => selector({
    ensureHistoryRefs: mockEnsureHistoryRefs,
    fetchHistoryPage: mockFetchHistoryPage,
  }),
  useGitHistoryRefsState: () => mockRefsState,
  useGitHistoryQueryState: () => mockQueryState,
}));

const { GitGraphControls } = await import('./GitGraphControls');

const createUnusedGitApi = () => {
  const gitApiSource = {};
  // SAFETY: These tests only pass the git API through to mocked store actions and never call runtime methods.
  return gitApiSource as GitAPI;
};

const renderControls = (props: Partial<React.ComponentProps<typeof GitGraphControls>> = {}) => renderToStaticMarkup(
  React.createElement(
    I18nProvider,
    null,
    React.createElement(GitGraphControls, {
      directory: '/repo',
      git: createUnusedGitApi(),
      ...props,
    }),
  ),
);

const getButtonByLabel = (label: string) => {
  const button = renderedButtons.find((entry) => entry.label === label);
  if (!button) {
    throw new Error(`Expected button with label "${label}"`);
  }
  return button;
};

const getButtonByAriaLabel = (label: string) => {
  const button = renderedButtons.find((entry) => entry.ariaLabel === label);
  if (!button) {
    throw new Error(`Expected button with aria-label "${label}"`);
  }
  return button;
};

describe('GitGraphControls', () => {
  beforeEach(() => {
    renderedButtons.length = 0;
    paneStateCalls.length = 0;
    ensureHistoryRefsCalls.length = 0;
    fetchHistoryPageCalls.length = 0;
    gitPaneState = {
      changesCollapsed: false,
      graphCollapsed: false,
      graphHeight: 280,
      graphFilterMode: 'auto',
      graphManualRefIds: [],
    };
    mockSetPaneState = mock((directory: string, updates: Partial<GitRepositoryPaneState> | ((current: GitRepositoryPaneState) => Partial<GitRepositoryPaneState>)) => {
      paneStateCalls.push([directory, updates]);
      return undefined;
    });
    mockEnsureHistoryRefs = mock(async (directory: string, git: GitAPI) => {
      ensureHistoryRefsCalls.push([directory, git]);
      return null;
    });
    mockFetchHistoryPage = mock(async (directory: string, git: GitAPI, query: GraphQuery) => {
      fetchHistoryPageCalls.push([directory, git, query]);
      return undefined;
    });
    mockRefsState = createMockRefsState();
    mockQueryState = createMockQueryState();
  });

  test('writes the selected graph filter mode to the repository pane state', () => {
    renderControls();

    // SAFETY: The controls do not inspect the click event; any React-shaped mouse event is sufficient for invoking the handler.
    getButtonByLabel('Auto').props.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    // SAFETY: The controls do not inspect the click event; any React-shaped mouse event is sufficient for invoking the handler.
    getButtonByLabel('All').props.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    // SAFETY: The controls do not inspect the click event; any React-shaped mouse event is sufficient for invoking the handler.
    getButtonByLabel('Manual').props.onClick?.({} as React.MouseEvent<HTMLButtonElement>);

    expect(paneStateCalls).toEqual([
      ['/repo', { graphFilterMode: 'auto', graphManualRefIds: [] }],
      ['/repo', { graphFilterMode: 'all', graphManualRefIds: [] }],
      ['/repo', { graphFilterMode: 'manual' }],
    ]);
  });

  test('refreshes refs before the current graph history query', async () => {
    gitPaneState = {
      ...gitPaneState,
      graphFilterMode: 'manual',
      graphManualRefIds: ['refs/heads/topic'],
    };
    const refreshSequence: string[] = [];
    const git = createUnusedGitApi();
    mockEnsureHistoryRefs = mock(async (directory: string, runtimeGit: GitAPI) => {
      ensureHistoryRefsCalls.push([directory, runtimeGit]);
      refreshSequence.push('refs');
      return null;
    });
    mockFetchHistoryPage = mock(async (directory: string, runtimeGit: GitAPI, query: GraphQuery) => {
      fetchHistoryPageCalls.push([directory, runtimeGit, query]);
      refreshSequence.push('history');
      expect(query).toEqual({ mode: 'manual', refIds: ['refs/heads/topic'] });
      return undefined;
    });

    renderControls({ git });

    // SAFETY: The refresh handler does not inspect the click event; any React-shaped mouse event is sufficient for invoking the handler.
    await getButtonByAriaLabel('Refresh').props.onClick?.({} as React.MouseEvent<HTMLButtonElement>);

    expect(refreshSequence).toEqual(['refs', 'history']);
    expect(ensureHistoryRefsCalls).toEqual([['/repo', git]]);
    expect(fetchHistoryPageCalls).toEqual([['/repo', git, { mode: 'manual', refIds: ['refs/heads/topic'] }]]);
  });

  test('disables filter edits when refs are unavailable and refresh while graph loading is in flight', () => {
    mockRefsState = {
      ...createMockRefsState(),
      refsError: 'refs failed',
    };
    mockQueryState = { ...createMockQueryState(), isLoadingMore: true };

    const markup = renderControls();

    expect(getButtonByLabel('Auto').props.disabled).toBe(true);
    expect(getButtonByLabel('All').props.disabled).toBe(true);
    expect(getButtonByLabel('Manual').props.disabled).toBe(true);
    expect(getButtonByAriaLabel('Refresh').props.disabled).toBe(true);
    expect(markup).toContain('data-ui="git-graph-controls"');
  });
});

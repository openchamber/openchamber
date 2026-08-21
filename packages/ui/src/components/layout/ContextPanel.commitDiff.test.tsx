import React from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GitCommitDiffTarget } from '@/stores/useUIStore';

type MockButtonProps = React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>;

const buildTarget = (): GitCommitDiffTarget => ({
  commitHash: 'a'.repeat(40),
  parentHash: 'b'.repeat(40),
  file: {
    path: 'src/history.ts',
    originalPath: 'src/history-before.ts',
    status: 'R',
    kind: 'file',
    objectId: '1'.repeat(40),
    originalObjectId: '2'.repeat(40),
    insertions: 4,
    deletions: 2,
    isBinary: false,
  },
});

let uiState: Record<string, unknown>;

mock.module('@/components/ui/button', () => ({
  Button: React.forwardRef<HTMLButtonElement, MockButtonProps>(({ children, ...props }, ref) => React.createElement('button', { ...props, ref }, children)),
}));

mock.module('@/components/icons/FileTypeIcon', () => ({
  FileTypeIcon: () => React.createElement('span', { 'data-file-type-icon': true }),
}));

mock.module('@/components/icons/DiffIcon', () => ({
  DiffViewIcon: () => React.createElement('span', { 'data-diff-icon': true }),
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name }: { name: string }) => React.createElement('span', { 'data-icon': name }),
}));

mock.module('@/components/ui/sortable-tabs-strip', () => ({
  SortableTabsStrip: () => React.createElement('div', { 'data-tabs-strip': true }),
}));

mock.module('@/components/views/PullRequestView', () => ({ PullRequestView: () => null }));
mock.module('@/components/views/TerminalView', () => ({ TerminalView: () => null }));
mock.module('./RightSidebarTabs', () => ({ ProjectContextPanel: () => null }));
mock.module('./SidebarFilesTree', () => ({ SidebarFilesTree: () => null }));
mock.module('./ContextSidebarTab', () => ({ ContextPanelContent: () => null }));
mock.module('@/components/browser/BrowserPane', () => ({ BrowserPane: () => null }));

mock.module('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({
    themeMode: 'dark',
    setThemeMode() {},
    lightThemeId: 'light',
    darkThemeId: 'dark',
    currentTheme: 'dark',
  }),
}));

mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/repo' }));
mock.module('@/lib/i18n', () => ({
  I18nProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  useI18n: () => ({ t: (key: string) => key }),
}));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: <T,>(selector: (state: typeof uiState) => T) => selector(uiState),
}));
mock.module('@/stores/useBrowserFaviconStore', () => ({ useBrowserFaviconStore: () => ({}) }));
mock.module('@/stores/useFilesViewTabsStore', () => ({ useFilesViewTabsStore: () => (() => {}) }));
mock.module('@/sync/notification-store', () => ({ markSessionViewed() {} }));
mock.module('@/sync/sync-context', () => ({
  setExternallyViewedSession() {},
  useDirectoryStore: () => ({ subscribe: () => () => {}, getState: () => ({ session: [] }) }),
}));
mock.module('@/lib/browser/url', () => ({ browserUrlLabel: () => '' }));
mock.module('@/lib/browser/controlClient', () => ({ registerBrowserOpener: () => () => {} }));
mock.module('@/lib/runtime-auth', () => ({ getRuntimeBearerTokenSync: () => null, getRuntimeExtraHeadersSync: () => ({}) }));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeApiBaseUrl: () => '', getRuntimeKey: () => 'runtime:test' }));
mock.module('@/lib/relay/runtime-tunnel', () => ({ getActiveRelayDescriptor: () => null }));
mock.module('@/lib/surfaces/registry', () => ({ getContextSurfaceWidthFraction: () => 0.5 }));
mock.module('@/lib/terminalFocus', () => ({ isTerminalEventTarget: () => false }));

mock.module('@/lib/chunkLoadRecovery', () => ({
  lazyWithChunkRecovery: (loader: () => Promise<unknown>) => {
    const source = String(loader);
    if (source.includes('ContextCommitDiffView')) {
      return ({ target }: { target: GitCommitDiffTarget }) => React.createElement('div', {
        'data-git-commit-context-diff': 'true',
        'data-commit-hash': target.commitHash,
      });
    }
    if (source.includes('DiffView')) {
      return () => React.createElement('div', { 'data-ordinary-diff-view': 'true' });
    }
    return () => null;
  },
}));

const {
  ContextPanel,
} = await import('./ContextPanel');

beforeEach(() => {
  uiState = {
    contextPanelByDirectory: {},
    closeContextPanel() {},
    closeContextPanelTab() {},
    openContextPanelTab() {},
    toggleContextPanelExpanded() {},
    setContextPanelWidth() {},
    setActiveContextPanelTab() {},
    openContextBrowser() {},
    reorderContextPanelTabs() {},
    contextEditorTreeVisible: false,
    toggleContextEditorTree() {},
    openNewContextBrowserTab() {},
  };
});

describe('ContextPanel commit diff routing', () => {
  test('routes historical diff tabs to the historical preview and keeps ordinary diff tabs on DiffView', () => {
    uiState = {
      ...uiState,
      contextPanelByDirectory: {
        '/repo': {
          isOpen: true,
          expanded: false,
          activeTabId: 'diff',
          widthByMode: {},
          touchedAt: 1,
          tabs: [{
            id: 'diff',
            mode: 'diff',
            targetPath: 'src/history.ts',
            commitDiffTarget: buildTarget(),
            projectPlanId: null,
            dedupeKey: 'diff',
            label: null,
            sessionTitleFallback: null,
            readOnly: false,
            stagedDiff: false,
            diffScope: 'working',
            touchedAt: 1,
          }],
        },
      },
    };

    const historicalMarkup = renderToStaticMarkup(React.createElement(ContextPanel));
    expect(historicalMarkup).toContain('data-git-commit-context-diff="true"');
    expect(historicalMarkup).not.toContain('data-ordinary-diff-view="true"');

    uiState = {
      ...uiState,
      contextPanelByDirectory: {
        '/repo': {
          isOpen: true,
          expanded: false,
          activeTabId: 'diff',
          widthByMode: {},
          touchedAt: 1,
          tabs: [{
            id: 'diff',
            mode: 'diff',
            targetPath: 'src/working.ts',
            commitDiffTarget: null,
            projectPlanId: null,
            dedupeKey: 'diff',
            label: null,
            sessionTitleFallback: null,
            readOnly: false,
            stagedDiff: false,
            diffScope: 'working',
            touchedAt: 1,
          }],
        },
      },
    };

    const ordinaryMarkup = renderToStaticMarkup(React.createElement(ContextPanel));
    expect(ordinaryMarkup).toContain('data-ordinary-diff-view="true"');
  });
});

import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import type { GitCommitDiffTarget } from '@/stores/useUIStore';

type MockButtonProps = React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>;

mock.module('@/components/ui/button', () => ({
  Button: React.forwardRef<HTMLButtonElement, MockButtonProps>(({ children, ...props }, ref) => React.createElement('button', { ...props, ref }, children)),
}));
mock.module('@/components/icons/FileTypeIcon', () => ({ FileTypeIcon: () => null }));
mock.module('@/components/icons/DiffIcon', () => ({ DiffViewIcon: () => null }));
mock.module('@/components/ui/sortable-tabs-strip', () => ({ SortableTabsStrip: () => null }));
mock.module('@/components/views/PullRequestView', () => ({ PullRequestView: () => null }));
mock.module('@/components/views/TerminalView', () => ({ TerminalView: () => null }));
mock.module('./RightSidebarTabs', () => ({ ProjectContextPanel: () => null }));
mock.module('./SidebarFilesTree', () => ({ SidebarFilesTree: () => null }));
mock.module('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ themeMode: 'dark', setThemeMode() {}, lightThemeId: 'light', darkThemeId: 'dark', currentTheme: 'dark' }) }));
mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/repo' }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/stores/useBrowserFaviconStore', () => ({ useBrowserFaviconStore: () => ({}) }));
mock.module('@/stores/useFilesViewTabsStore', () => ({ useFilesViewTabsStore: () => (() => {}) }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: () => undefined }));
mock.module('@/sync/notification-store', () => ({ markSessionViewed() {} }));
mock.module('@/sync/sync-context', () => ({ setExternallyViewedSession() {}, useDirectoryStore: () => ({ subscribe: () => () => {}, getState: () => ({ session: [] }) }) }));
mock.module('./ContextSidebarTab', () => ({ ContextPanelContent: () => null }));
mock.module('@/components/browser/BrowserPane', () => ({ BrowserPane: () => null }));
mock.module('@/lib/browser/url', () => ({ browserUrlLabel: () => '' }));
mock.module('@/lib/browser/controlClient', () => ({ registerBrowserOpener: () => () => {} }));
mock.module('@/lib/runtime-auth', () => ({ getRuntimeBearerTokenSync: () => null, getRuntimeExtraHeadersSync: () => ({}) }));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeApiBaseUrl: () => '', getRuntimeKey: () => 'runtime:test' }));
mock.module('@/lib/relay/runtime-tunnel', () => ({ getActiveRelayDescriptor: () => null }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('./contextPanelEmbeddedChat', () => ({
  EMBEDDED_RUNTIME_BOOTSTRAP_REQUEST: 'req',
  EMBEDDED_RUNTIME_BOOTSTRAP_RESPONSE: 'res',
  EMBEDDED_VISIBILITY_REQUEST: 'vis-req',
  EMBEDDED_VISIBILITY_UPDATE: 'vis-update',
  getActiveEmbeddedSessionChatTab: () => null,
  getOrCreateEmbeddedSessionChatURL: () => '',
}));
mock.module('@/lib/surfaces/registry', () => ({ getContextSurfaceWidthFraction: () => 0.5 }));
mock.module('@/lib/terminalFocus', () => ({ isTerminalEventTarget: () => false }));
mock.module('@/lib/chunkLoadRecovery', () => ({ lazyWithChunkRecovery: () => () => null }));

const { getDiffTabRenderKind } = await import('./ContextPanel');

type DiffTabRenderInput = Parameters<typeof getDiffTabRenderKind>[0];
type HasExactCommitTargetContract =
  [DiffTabRenderInput] extends [{ commitDiffTarget: GitCommitDiffTarget | null }]
    ? ([{ commitDiffTarget: GitCommitDiffTarget | null }] extends [DiffTabRenderInput] ? true : false)
    : false;
const hasExactCommitTargetContract: HasExactCommitTargetContract = true;

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

describe('ContextPanel diff render kind', () => {
  test('routes historical diff tabs to the historical preview and ordinary diff tabs to DiffView', () => {
    const commitTab: DiffTabRenderInput = { commitDiffTarget: buildTarget() };
    const workingTab: DiffTabRenderInput = { commitDiffTarget: null };

    expect(hasExactCommitTargetContract).toBe(true);
    expect(getDiffTabRenderKind(commitTab)).toBe('commit');
    expect(getDiffTabRenderKind(workingTab)).toBe('working');
  });
});

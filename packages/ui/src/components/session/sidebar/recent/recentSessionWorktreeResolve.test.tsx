import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '@opencode-ai/sdk/v2';
import type { WorktreeMetadata } from '@/types/worktree';
import { installHookTestDom } from '../test-utils/testDom';
import { I18nProvider } from '@/lib/i18n';
import type { SessionTreeItemProps } from '../sessions/SessionTreeItem';

type CapturedSectionItem = {
  node: {
    session: Session;
    worktree: WorktreeMetadata | null;
  };
  projectId: string | null;
  groupDirectory: string | null;
  secondaryMeta: {
    projectLabel?: string | null;
    branchLabel?: string | null;
  } | null;
};

type CapturedSection = {
  key: string;
  items: CapturedSectionItem[];
};

const capturedSections: CapturedSection[][] = [];

mock.module('./SidebarActivitySections', () => ({
  SidebarActivitySections: (props: { sections: CapturedSection[] }) => {
    capturedSections.push(props.sections);
    return null;
  },
}));

// SAFETY: RecentSessionSection is imported after the SidebarActivitySections mock so the test observes the real resolver.
const { RecentSessionSection } = await import('./RecentSessionSection');

const noopStartSessionWorktreeMenuLoad: SessionTreeItemProps['startSessionWorktreeMenuLoad'] = () => ({
  cachedTargets: [],
  refreshTargets: Promise.resolve([]),
});

// SAFETY: fixtures use the minimal Session fields the Recent resolver reads (id/directory/title/time).
const worktreeSession = (id: string, directory: string): Session => ({
  id,
  title: id,
  directory,
  time: { created: 1, updated: 1 },
}) as Session;

const worktreeMeta = (path: string, branch: string): WorktreeMetadata => ({
  path,
  projectDirectory: '/workspace/app',
  branch,
  label: branch,
});

describe('RecentSessionSection external worktree resolve', () => {
  test('resolves sessions outside the project root via the worktree index and keeps filtered branches hidden without leaking into the worktree fallback', async () => {
    capturedSections.length = 0;
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const noop = () => undefined;
    const sessions = [
      worktreeSession('visible-feature', '/tmp/wt-feature'),
      worktreeSession('filtered-head', '/tmp/wt-detached'),
      worktreeSession('filtered-redundant', '/tmp/wt-redundant'),
    ];

    try {
      await act(async () => {
        root.render(
          <I18nProvider>
            <RecentSessionSection
              projects={[{ id: 'app', label: 'App', normalizedPath: '/workspace/app' }]}
              availableWorktreesByProject={new Map([
                ['/workspace/app', [
                  worktreeMeta('/tmp/wt-feature', 'feature-1'),
                  worktreeMeta('/tmp/wt-detached', 'HEAD'),
                  worktreeMeta('/tmp/wt-redundant', 'App'),
                ]],
              ])}
              gitBranches={new Map()}
              homeDirectory={null}
              hasSessionSearchQuery={false}
              normalizedSessionSearchQuery=""
              isDesktopShellRuntime={false}
              sessions={sessions}
              childrenMap={new Map()}
              pinnedSessionIds={new Set()}
              recentSessions={sessions}
              expandedParents={new Set()}
              notifyOnSubtasks={false}
              editingId={null}
              editTitle=""
              copiedSessionId={null}
              openSidebarMenuKey={null}
              mobileVariant={false}
              alwaysShowActions={false}
              chatSessions={[]}
              renderChatsSection={() => null}
              onNewChat={noop}
              showRecentSection
              setEditingId={noop}
              setEditTitle={noop}
              toggleParent={noop}
              setOpenSidebarMenuKey={noop}
              allowReselect={false}
              isSessionSearchOpen={false}
              sessionSearchQuery=""
              setSessionSearchQuery={noop}
              setIsSessionSearchOpen={noop}
              deleteSessionConfirm={null}
              setDeleteSessionConfirm={noop}
              startFolderRename={noop}
              setCopiedSessionId={noop}
              startSessionWorktreeMenuLoad={noopStartSessionWorktreeMenuLoad}
            />
          </I18nProvider>,
        );
      });

      const recent = capturedSections.at(-1)?.find((section) => section.key === 'active-now');
      expect(recent?.items.map((item) => item.node.session.id)).toEqual([
        'visible-feature',
        'filtered-head',
        'filtered-redundant',
      ]);
      const byId = new Map(recent?.items.map((item) => [item.node.session.id, item]));

      // (a) Worktree outside the project root resolves through the worktreeByPath index.
      const visible = byId.get('visible-feature');
      expect(visible?.projectId).toBe('app');
      expect(visible?.groupDirectory).toBe('/tmp/wt-feature');
      expect(visible?.secondaryMeta).toEqual({ projectLabel: 'App', branchLabel: 'feature-1' });
      expect(visible?.node.worktree?.path).toBe('/tmp/wt-feature');
      expect(visible?.node.worktree?.branch).toBe('feature-1');

      // (b) Filtered branches stay hidden yet keep the raw worktree branch for the project-row fallback.
      const head = byId.get('filtered-head');
      expect(head?.projectId).toBe('app');
      expect(head?.secondaryMeta).toEqual({ projectLabel: 'App', branchLabel: null });
      expect(head?.node.worktree?.branch).toBe('HEAD');

      const redundant = byId.get('filtered-redundant');
      expect(redundant?.projectId).toBe('app');
      expect(redundant?.secondaryMeta).toEqual({ projectLabel: 'App', branchLabel: null });
      expect(redundant?.node.worktree?.branch).toBe('App');

      // SessionNodeItem priority (SessionNodeItem.tsx:372-378): an explicit
      // secondaryMeta wins, so deliberate null must not fall through to the raw branch.
      const resolveTooltipBranchLabel = (
        secondaryMeta: CapturedSectionItem['secondaryMeta'],
        worktreeBranch: string | null,
      ): string | null => (secondaryMeta ? (secondaryMeta.branchLabel ?? null) : (worktreeBranch ?? null));

      expect(resolveTooltipBranchLabel(visible?.secondaryMeta ?? null, visible?.node.worktree?.branch ?? null)).toBe('feature-1');
      expect(resolveTooltipBranchLabel(head?.secondaryMeta ?? null, head?.node.worktree?.branch ?? null)).toBeNull();
      expect(resolveTooltipBranchLabel(redundant?.secondaryMeta ?? null, redundant?.node.worktree?.branch ?? null)).toBeNull();
      // Project rows pass no secondaryMeta and keep the worktree fallback.
      expect(resolveTooltipBranchLabel(null, head?.node.worktree?.branch ?? null)).toBe('HEAD');
      expect(resolveTooltipBranchLabel(null, redundant?.node.worktree?.branch ?? null)).toBe('App');
    } finally {
      await act(async () => root.unmount());
      capturedSections.length = 0;
      dom.restore();
    }
  });

  test('resolves <worktree>/sub via prefix and session-keyed metadata without leaking the project root', async () => {
    capturedSections.length = 0;
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const noop = () => undefined;
    const sessions = [
      worktreeSession('sub-outside', '/tmp/wt-feature/sub'),
      worktreeSession('sub-inside', '/workspace/app/.worktrees/inner/sub'),
      worktreeSession('sub-keyed', '/tmp/wt-feature/nested'),
      worktreeSession('root-session', '/workspace/app'),
    ];

    try {
      await act(async () => {
        root.render(
          <I18nProvider>
            <RecentSessionSection
              projects={[{ id: 'app', label: 'App', normalizedPath: '/workspace/app' }]}
              availableWorktreesByProject={new Map([
                ['/workspace/app', [
                  worktreeMeta('/tmp/wt-feature', 'feature-1'),
                  worktreeMeta('/workspace/app/.worktrees/inner', 'inner-1'),
                ]],
              ])}
              worktreeMetadata={new Map([
                ['sub-keyed', worktreeMeta('/tmp/wt-feature', 'feature-keyed')],
              ])}
              gitBranches={new Map()}
              homeDirectory={null}
              hasSessionSearchQuery={false}
              normalizedSessionSearchQuery=""
              isDesktopShellRuntime={false}
              sessions={sessions}
              childrenMap={new Map()}
              pinnedSessionIds={new Set()}
              recentSessions={sessions}
              expandedParents={new Set()}
              notifyOnSubtasks={false}
              editingId={null}
              editTitle=""
              copiedSessionId={null}
              openSidebarMenuKey={null}
              mobileVariant={false}
              alwaysShowActions={false}
              chatSessions={[]}
              renderChatsSection={() => null}
              onNewChat={noop}
              showRecentSection
              setEditingId={noop}
              setEditTitle={noop}
              toggleParent={noop}
              setOpenSidebarMenuKey={noop}
              allowReselect={false}
              isSessionSearchOpen={false}
              sessionSearchQuery=""
              setSessionSearchQuery={noop}
              setIsSessionSearchOpen={noop}
              deleteSessionConfirm={null}
              setDeleteSessionConfirm={noop}
              startFolderRename={noop}
              setCopiedSessionId={noop}
              startSessionWorktreeMenuLoad={noopStartSessionWorktreeMenuLoad}
            />
          </I18nProvider>,
        );
      });

      const recent = capturedSections.at(-1)?.find((section) => section.key === 'active-now');
      const byId = new Map(recent?.items.map((item) => [item.node.session.id, item]));

      // Prefix match outside the project root owns the session and its worktree.
      const outside = byId.get('sub-outside');
      expect(outside?.projectId).toBe('app');
      expect(outside?.groupDirectory).toBe('/tmp/wt-feature/sub');
      expect(outside?.secondaryMeta).toEqual({ projectLabel: 'App', branchLabel: 'feature-1' });
      expect(outside?.node.worktree?.path).toBe('/tmp/wt-feature');

      // Prefix match inside the project root resolves the inner worktree.
      const inside = byId.get('sub-inside');
      expect(inside?.projectId).toBe('app');
      expect(inside?.secondaryMeta).toEqual({ projectLabel: 'App', branchLabel: 'inner-1' });
      expect(inside?.node.worktree?.path).toBe('/workspace/app/.worktrees/inner');

      // Session-keyed metadata wins over the indexed worktree branch.
      const keyed = byId.get('sub-keyed');
      expect(keyed?.projectId).toBe('app');
      expect(keyed?.secondaryMeta).toEqual({ projectLabel: 'App', branchLabel: 'feature-keyed' });
      expect(keyed?.node.worktree?.path).toBe('/tmp/wt-feature');
      expect(keyed?.node.worktree?.branch).toBe('feature-keyed');

      // The project root itself never resolves to a worktree.
      const rootSession = byId.get('root-session');
      expect(rootSession?.projectId).toBe('app');
      expect(rootSession?.node.worktree).toBeNull();
    } finally {
      await act(async () => root.unmount());
      capturedSections.length = 0;
      dom.restore();
    }
  });

  test('prefers live git branch over stored worktree metadata, including <worktree>/sub', async () => {
    capturedSections.length = 0;
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const noop = () => undefined;
    const sessions = [
      worktreeSession('desync-exact', '/tmp/wt-feature'),
      worktreeSession('desync-sub', '/tmp/wt-feature/sub'),
    ];

    try {
      await act(async () => {
        root.render(
          <I18nProvider>
            <RecentSessionSection
              projects={[{ id: 'app', label: 'App', normalizedPath: '/workspace/app' }]}
              availableWorktreesByProject={new Map([
                ['/workspace/app', [worktreeMeta('/tmp/wt-feature', 'stored-1')]],
              ])}
              gitBranches={new Map([
                ['/tmp/wt-feature', 'live-1'],
              ])}
              homeDirectory={null}
              hasSessionSearchQuery={false}
              normalizedSessionSearchQuery=""
              isDesktopShellRuntime={false}
              sessions={sessions}
              childrenMap={new Map()}
              pinnedSessionIds={new Set()}
              recentSessions={sessions}
              expandedParents={new Set()}
              notifyOnSubtasks={false}
              editingId={null}
              editTitle=""
              copiedSessionId={null}
              openSidebarMenuKey={null}
              mobileVariant={false}
              alwaysShowActions={false}
              chatSessions={[]}
              renderChatsSection={() => null}
              onNewChat={noop}
              showRecentSection
              setEditingId={noop}
              setEditTitle={noop}
              toggleParent={noop}
              setOpenSidebarMenuKey={noop}
              allowReselect={false}
              isSessionSearchOpen={false}
              sessionSearchQuery=""
              setSessionSearchQuery={noop}
              setIsSessionSearchOpen={noop}
              deleteSessionConfirm={null}
              setDeleteSessionConfirm={noop}
              startFolderRename={noop}
              setCopiedSessionId={noop}
              startSessionWorktreeMenuLoad={noopStartSessionWorktreeMenuLoad}
            />
          </I18nProvider>,
        );
      });

      const recent = capturedSections.at(-1)?.find((section) => section.key === 'active-now');
      const byId = new Map(recent?.items.map((item) => [item.node.session.id, item]));
      // Live-first: the stored branch is visible only through node.worktree,
      // never as the displayed branch label.
      expect(byId.get('desync-exact')?.secondaryMeta).toEqual({ projectLabel: 'App', branchLabel: 'live-1' });
      expect(byId.get('desync-exact')?.node.worktree?.branch).toBe('stored-1');
      // Subdirectory sessions reuse the worktree-root live branch.
      expect(byId.get('desync-sub')?.secondaryMeta).toEqual({ projectLabel: 'App', branchLabel: 'live-1' });
      expect(byId.get('desync-sub')?.node.worktree?.path).toBe('/tmp/wt-feature');
    } finally {
      await act(async () => root.unmount());
      capturedSections.length = 0;
      dom.restore();
    }
  });
});

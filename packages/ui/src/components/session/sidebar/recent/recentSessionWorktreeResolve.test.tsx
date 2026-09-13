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
});

import React from 'react';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { useGitDiffTabsStore, type GitDiffTab } from '@/stores/useGitDiffTabsStore';
import { getGitDiffTabLabel, getGitDiffTabTitle } from './gitDiffTabLabels';

// Lazy-load heavy diff views to avoid bloating the initial bundle
const DiffView = lazyWithChunkRecovery(() =>
  import('@/components/views/DiffView').then((m) => ({ default: m.DiffView })),
);

const ContextCommitDiffView = lazyWithChunkRecovery(() =>
  import('@/components/views/git/ContextCommitDiffView').then((m) => ({
    default: m.ContextCommitDiffView,
  })),
);

type GitDiffTabsPaneProps = {
  directory: string;
};

// Stable fallbacks so the store selector returns a referentially equal
// snapshot for directories with no open diff tabs (an inline fallback object
// would re-render on every store update).
const EMPTY_TABS: readonly GitDiffTab[] = Object.freeze([]);

export const GitDiffTabsPane: React.FC<GitDiffTabsPaneProps> = ({ directory }) => {
  const { t } = useI18n();

  // Subscribe to the store for this directory (narrow selectors with stable
  // fallbacks; the store clamps the empty-directory entry out on persist).
  const tabs = useGitDiffTabsStore(
    (state) => state.byDirectory[directory]?.tabs ?? EMPTY_TABS,
  );
  const activeTabId = useGitDiffTabsStore(
    (state) => state.byDirectory[directory]?.activeTabId ?? null,
  );

  // If no tabs, render nothing
  if (tabs.length === 0) {
    return null;
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[tabs.length - 1];

  // Build strip items
  const stripItems: SortableTabsStripItem[] = tabs.map((tab) => ({
    id: tab.id,
    label: getGitDiffTabLabel(tabs, tab),
    title: getGitDiffTabTitle(tab),
    closable: true,
    closeLabel: t('contextPanel.tab.closeTabAria', {
      label: getGitDiffTabLabel(tabs, tab),
    }),
  }));

  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col',
        'border-border bg-background',
      )}
      data-git-diff-tabs-pane="true"
    >
      <div
        data-git-diff-tabs-header="true"
        className="flex h-10 shrink-0 items-stretch border-b border-border"
      >
        <SortableTabsStrip
          items={stripItems}
          activeId={activeTabId}
          onSelect={(id) => useGitDiffTabsStore.getState().setActiveTab(directory, id)}
          onClose={(id) => useGitDiffTabsStore.getState().closeTab(directory, id)}
          onReorder={(activeId, overId) =>
            useGitDiffTabsStore.getState().reorderTabs(directory, activeId, overId)
          }
        />
      </div>

      {/* Active tab content below the strip */}
      {activeTab && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <React.Suspense fallback={null}>
            {activeTab.kind === 'commit' && (
              <ContextCommitDiffView
                directory={directory}
                target={activeTab.target}
              />
            )}
            {activeTab.kind === 'working' && (
              <DiffView
                hideStackedFileSidebar
                stackedDefaultCollapsedAll
                pinSelectedFileHeaderToTopOnNavigate
                showOpenInEditorAction
                diffScope={activeTab.scope}
                onDiffScopeChange={(scope) =>
                  useGitDiffTabsStore.getState().updateWorkingScope(directory, activeTab.id, scope)
                }
                singleFilePath={activeTab.path}
                flushContent
              />
            )}
          </React.Suspense>
        </div>
      )}
    </div>
  );
};

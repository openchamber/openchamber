import React from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';

const renderedRows: Array<{
  hash: string;
  isExpanded: boolean;
  commitDetailsController?: unknown;
  commitComparison?: { directory: string; commitHash: string; parentHash: string | null };
}> = [];

mock.module('./HistoryCommitRow', () => ({
  HistoryCommitRow: ({
    entry,
    isExpanded,
    commitDetailsController,
    commitComparison,
  }: {
    entry: { hash: string };
    isExpanded: boolean;
    commitDetailsController?: unknown;
    commitComparison?: { directory: string; commitHash: string; parentHash: string | null };
  }) => {
    renderedRows.push({ hash: entry.hash, isExpanded, commitDetailsController, commitComparison });
    return React.createElement('li', { 'data-history-row': entry.hash });
  },
}));

mock.module('@/components/ui/collapsible', () => ({
  Collapsible: ({ children }: React.PropsWithChildren) => React.createElement('section', null, children),
  CollapsibleContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  CollapsibleTrigger: ({ children }: React.PropsWithChildren) => React.createElement('button', null, children),
}));

mock.module('@/components/ui/select', () => ({
  Select: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectItem: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectTrigger: ({ children }: React.PropsWithChildren) => React.createElement('button', null, children),
  SelectValue: () => React.createElement('span'),
}));

mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>) => React.createElement('button', props, children),
}));

mock.module('@/components/ui/ScrollableOverlay', () => ({
  ScrollableOverlay: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: () => React.createElement('span'),
}));

const { HistorySection } = await import('./HistorySection');

describe('HistorySection', () => {
  beforeEach(() => {
    renderedRows.length = 0;
  });

  test('forwards the shared commit details controller and per-entry comparison to rendered rows', () => {
    const controller = {
      getCommitSnapshot: () => ({ status: 'idle' as const }),
      subscribeCommit: () => () => {},
      isExpanded: () => true,
      subscribeExpanded: () => () => {},
      toggleExpanded: () => {},
      retryCommit: () => {},
      selectFile: () => {},
      confirmLargePreview: () => {},
      retryPreview: () => {},
      clearSelection: () => {},
      getPreviewSnapshot: () => ({ status: 'idle' as const }),
      subscribePreview: () => () => {},
      dispose: () => {},
    };

    renderToStaticMarkup(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(HistorySection, {
          log: {
            all: [{
              hash: 'commit-a',
              message: 'Commit A',
              body: '',
              author_name: 'Ada',
              author_email: 'ada@example.com',
              date: '2026-01-01T00:00:00.000Z',
              refs: '',
              parents: ['commit-root'],
              filesChanged: 1,
              insertions: 2,
              deletions: 1,
            }],
          },
          isLogLoading: false,
          logMaxCount: 25,
          onLogMaxCountChange: () => {},
          commitDetailsController: controller,
          onCopyHash: () => {},
          directory: '/repo',
          showHeader: false,
        }),
      ),
    );

    expect(renderedRows).toEqual([{
      hash: 'commit-a',
      isExpanded: true,
      commitDetailsController: controller,
      commitComparison: {
        directory: '/repo',
        commitHash: 'commit-a',
        parentHash: 'commit-root',
      },
    }]);
  });
});

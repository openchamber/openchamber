import React from 'react';
import { describe, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import type { GitCommitChangedFile } from '@/lib/api/types';

type MockButtonProps = React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>;

mock.module('@/components/ui/button', () => ({
  Button: React.forwardRef<HTMLButtonElement, MockButtonProps>(({ children, ...props }, ref) => React.createElement('button', { ...props, ref }, children)),
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => React.createElement('span', { 'data-icon': name, className }),
}));

mock.module('@/components/views/PierreDiffViewer', () => ({
  PierreDiffViewer: ({ fileName }: { fileName?: string; original?: string; modified?: string }) => React.createElement('div', { 'data-diff-viewer': true, 'data-file-name': String(fileName ?? '') }),
}));

const {
  GitCommitDiffSidePanel,
} = await import('./GitCommitDiffSidePanel');

type SidePanelProps = React.ComponentProps<typeof GitCommitDiffSidePanel>;
type SidePanelController = SidePanelProps['controller'];
type PreviewSnapshot = ReturnType<SidePanelController['getPreviewSnapshot']>;

const buildFile = (overrides: Partial<GitCommitChangedFile> = {}): GitCommitChangedFile => ({
  path: 'src/example.ts',
  status: 'M',
  kind: 'file',
  insertions: 8,
  deletions: 3,
  isBinary: false,
  ...overrides,
});

const buildReadySnapshot = (fileOverrides: Partial<GitCommitChangedFile> = {}, overrides: Partial<Extract<PreviewSnapshot, { status: 'ready' }>> = {}): PreviewSnapshot => ({
  status: 'ready',
  comparison: { directory: '/repo', commitHash: 'abc', parentHash: 'def' },
  file: buildFile(fileOverrides),
  original: 'const before = 1;\n',
  modified: 'const after = 2;\n',
  ...overrides,
});

const createMockController = (initialSnapshot: PreviewSnapshot) => {
  let snapshot = initialSnapshot;
  const listeners = new Set<() => void>();
  let clearSelectionCallCount = 0;

  const controller: SidePanelController & { setSnapshot: (next: PreviewSnapshot) => void; readonly clearSelectionCallCount: number } = {
    getPreviewSnapshot: () => snapshot,
    getCommitSnapshot: () => ({ status: 'idle' as const }),
    subscribeCommit: () => () => {},
    isExpanded: () => false,
    subscribeExpanded: () => () => {},
    toggleExpanded() {},
    retryCommit() {},
    selectFile() {},
    subscribePreview(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    confirmLargePreview() {},
    retryPreview() {},
    clearSelection() {
      clearSelectionCallCount += 1;
    },
    dispose() {},
    setSnapshot(next) {
      snapshot = next;
      for (const listener of listeners) {
        listener();
      }
    },
    // Live getter, not a snapshot taken at construction time, so tests can
    // read the up-to-date call count after invoking clearSelection().
    get clearSelectionCallCount() {
      return clearSelectionCallCount;
    },
  };

  return controller;
};

const renderSidePanelMarkup = (controller: SidePanelController, props: Partial<SidePanelProps> = {}) => renderToStaticMarkup(
  React.createElement(
    I18nProvider,
    null,
    React.createElement(GitCommitDiffSidePanel, {
      controller,
      width: 420,
      onWidthChange: () => {},
      ...props,
    }),
  ),
);

describe('GitCommitDiffSidePanel', () => {
  test('renders nothing when preview snapshot is idle', () => {
    const controller = createMockController({ status: 'idle' });
    const markup = renderSidePanelMarkup(controller);
    
    // Should not have the side panel root element
    if (markup.includes('data-git-commit-diff-side-panel')) {
      throw new Error('Expected no side panel to be rendered when idle');
    }
  });

  test('renders side panel with separator and preview when snapshot is ready', () => {
    const controller = createMockController(buildReadySnapshot());
    const markup = renderSidePanelMarkup(controller);
    
    if (!markup.includes('data-git-commit-diff-side-panel="true"')) {
      throw new Error('Expected side panel to be rendered with data-git-commit-diff-side-panel="true"');
    }
    
    if (!markup.includes('role="separator"')) {
      throw new Error('Expected separator role');
    }
    
    if (!markup.includes('aria-orientation="vertical"')) {
      throw new Error('Expected vertical orientation');
    }
    
    if (!markup.includes('data-git-commit-diff-preview="true"')) {
      throw new Error('Expected GitCommitDiffPreview to be rendered');
    }
  });

  test('the rendered preview is wired to the same controller passed in, so closing clears its selection', () => {
    const controller = createMockController(buildReadySnapshot());
    const markup = renderSidePanelMarkup(controller);

    if (!markup.includes('data-git-commit-diff-preview-close="true"')) {
      throw new Error('Expected the close control to be rendered');
    }

    controller.clearSelection();

    if (controller.clearSelectionCallCount !== 1) {
      throw new Error(`Expected clearSelection to be called once, got ${controller.clearSelectionCallCount}`);
    }
  });
});

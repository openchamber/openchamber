import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import type { GitCommitChangedFile } from '@/lib/api/types';
import type { GitCommitComparison } from './HistoryCommitRow';

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem() { return null; },
    setItem() {},
    removeItem() {},
  },
});

type TestPressEvent = {
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
};

type MockButtonProps = React.PropsWithChildren<{
  type?: 'button' | 'submit' | 'reset';
  className?: string;
  title?: string;
  'aria-label'?: string;
  style?: React.CSSProperties;
  onClick?: (event: TestPressEvent) => void;
  'data-git-commit-changed-file-row'?: string;
}>;
type MockWrapperProps = React.PropsWithChildren<{ asChild?: boolean }>;

const buttonRegistry: MockButtonProps[] = [];

mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: MockButtonProps) => {
    buttonRegistry.push({ children, ...props });
    const domProps: React.ButtonHTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, string | undefined> = {
      type: props.type,
      className: props.className,
      title: props.title,
      'aria-label': props['aria-label'],
      style: props.style,
      'data-git-commit-changed-file-row': props['data-git-commit-changed-file-row'],
    };

    return React.createElement('button', domProps, children);
  },
}));

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: MockWrapperProps) => <>{children}</>,
  DropdownMenuContent: ({ children }: MockWrapperProps) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: MockWrapperProps) => <button type="button">{children}</button>,
  DropdownMenuTrigger: ({ children }: MockWrapperProps) => <>{children}</>,
}));

mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: MockWrapperProps) => <>{children}</>,
  TooltipContent: ({ children }: MockWrapperProps) => <span>{children}</span>,
  TooltipTrigger: ({ children }: MockWrapperProps) => <>{children}</>,
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => <span data-icon={name} className={className} />,
}));

mock.module('@/components/icons/FileTypeIcon', () => ({
  FileTypeIcon: ({ filePath, className }: { filePath: string; className?: string }) => (
    <span data-file-type-icon={filePath} className={className} />
  ),
}));

mock.module('@/components/views/PierreDiffViewer', () => ({
  PierreDiffViewer: () => <div data-diff-viewer />,
}));

mock.module('@/components/ui/toast', () => ({
  toast: {
    success() {},
    error() {},
  },
}));

mock.module('./GitCommitHoverPopover', () => ({
  GitCommitHoverPopover: Object.assign(
    ({ rowButton }: { rowButton: React.ReactElement }) => rowButton,
    {
      createCoordinator: () => ({
        claim() {},
        release() {},
      }),
    },
  ),
}));

const { HistoryCommitRow } = await import('./HistoryCommitRow');

const createPressEvent = () => {
  const event = {
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
  };

  return event;
};

const invokeClick = (handler: MockButtonProps['onClick'] | undefined, event: TestPressEvent) => {
  if (!handler) {
    return;
  }

  handler(event);
};

const createChangedFile = (overrides: Partial<GitCommitChangedFile> & Pick<GitCommitChangedFile, 'path' | 'status'>): GitCommitChangedFile => ({
  path: overrides.path,
  status: overrides.status,
  kind: overrides.kind ?? 'file',
  insertions: overrides.insertions ?? 0,
  deletions: overrides.deletions ?? 0,
  isBinary: overrides.isBinary ?? false,
  originalPath: overrides.originalPath,
  originalObjectId: overrides.originalObjectId,
  objectId: overrides.objectId,
});

describe('HistoryCommitRow compact graph regression', () => {
  test('renders collapsed compact graph rows inline without date hash or copy controls', () => {
    buttonRegistry.length = 0;
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ul>
          <HistoryCommitRow
            entry={{
              id: 'abcdef1234567890',
              parentIds: ['fedcba0987654321'],
              subject: 'Compact subject that should truncate when space is limited',
              message: 'Compact subject that should truncate when space is limited',
              author: 'Taylor Developer',
              authorEmail: 'taylor@example.com',
              timestamp: '2024-01-02T03:04:00.000Z',
              statistics: { files: 1, insertions: 2, deletions: 1 },
              references: [],
            }}
            mode="graph"
            compactGraph={true}
            viewModel={{
              historyItem: {
                id: 'abcdef1234567890',
                parentIds: ['fedcba0987654321'],
                subject: 'Compact subject that should truncate when space is limited',
                message: 'Compact subject that should truncate when space is limited',
                author: 'Taylor Developer',
                authorEmail: 'taylor@example.com',
                timestamp: '2024-01-02T03:04:00.000Z',
                statistics: { files: 1, insertions: 2, deletions: 1 },
                references: [
                  { id: 'HEAD', name: 'topic', revision: 'abcdef1234567890', kind: 'head', category: 'branches' },
                  { id: 'refs/heads/topic', name: 'topic', revision: 'abcdef1234567890', kind: 'local', category: 'branches' },
                  { id: 'refs/remotes/origin/topic', name: 'origin/topic', revision: 'abcdef1234567890', kind: 'remote', category: 'remote-branches' },
                  { id: 'refs/tags/v1', name: 'v1', revision: 'abcdef1234567890', kind: 'tag', category: 'tags' },
                ],
              },
              inputSwimlanes: [],
              outputSwimlanes: [{ id: 'fedcba0987654321', color: 'var(--chart-1)' }],
              kind: 'node',
            }}
            totalColumns={1}
            isExpanded={false}
            onToggle={() => {}}
            files={[]}
            isLoadingFiles={false}
            onCopyHash={() => {}}
            directory="/repo"
          />
        </ul>
      </I18nProvider>,
    );

    expect(markup.indexOf('Compact subject that should truncate when space is limited')).toBeLessThan(markup.indexOf('topic'));
    expect(markup.indexOf('topic')).toBeLessThan(markup.indexOf('Taylor Developer'));
    expect(markup).toContain('h-[22px]');
    expect(markup).toContain('whitespace-nowrap');
    expect(markup.match(/>topic<\/span>/g)).toHaveLength(1);
    expect(markup).not.toContain('origin/topic');
    expect(markup).toContain('>v1</span>');
    expect(markup).not.toContain('<code');
    expect(markup).not.toContain('2024');
    expect(markup).not.toContain('data-icon="file-copy"');
  });

  test('renders controller-backed changed files with aria wiring and isolates nested button presses', () => {
    buttonRegistry.length = 0;
    const toggleCalls: number[] = [];
    const onToggle = mock(() => {
      toggleCalls.push(1);
    });
    const copiedHashes: string[] = [];
    const selectedFiles: Array<{ comparison: GitCommitComparison; file: GitCommitChangedFile }> = [];
    const retriedComparisons: GitCommitComparison[] = [];
    const onCopyHash = mock((hash: string) => {
      copiedHashes.push(hash);
    });
    const selectFile = mock((comparison: GitCommitComparison, file: GitCommitChangedFile) => {
      selectedFiles.push({ comparison, file });
    });
    const retryCommit = mock((comparison: GitCommitComparison) => {
      retriedComparisons.push(comparison);
    });
    const comparison: GitCommitComparison = {
      directory: '/repo',
      commitHash: 'abcdef1234567890',
      parentHash: 'fedcba0987654321',
    };

    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ul>
          <HistoryCommitRow
            entry={{
              hash: 'abcdef1234567890',
              date: '2024-01-02T03:04:00.000Z',
              message: 'Add changed file rows',
              refs: '',
              body: '',
              author_name: 'Taylor Developer',
              author_email: 'taylor@example.com',
              filesChanged: 2,
              insertions: 4,
              deletions: 2,
              parents: ['fedcba0987654321'],
            }}
            isExpanded={true}
            onToggle={onToggle}
            files={[]}
            isLoadingFiles={false}
            onCopyHash={onCopyHash}
            directory="/repo"
            commitComparison={comparison}
            commitDetailsController={{
              getCommitSnapshot: () => ({
                status: 'ready',
                files: [
                  createChangedFile({ path: 'src/new-name.ts', originalPath: 'src/old-name.ts', status: 'R', insertions: 4, deletions: 2 }),
                ],
              }),
              subscribeCommit: () => () => {},
              retryCommit,
              selectFile,
            }}
            selectedChangedFilePath="src/new-name.ts"
          />
        </ul>
      </I18nProvider>,
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-controls="history-commit-details-abcdef1234567890"');
    expect(markup).toContain('id="history-commit-details-abcdef1234567890"');
    expect(markup).toContain('data-git-commit-changed-files="flat"');
    expect(markup).toContain('data-git-commit-changed-file-row="src/new-name.ts"');
    expect(markup).toContain('data-file-type-icon="src/new-name.ts"');
    expect(markup).toContain('data-git-commit-changed-file-name="src/new-name.ts"');
    expect(markup).toContain('>new-name.ts<');
    expect(markup).toContain('data-git-commit-changed-file-directory="src/new-name.ts"');
    expect(markup).toContain('>src/old-name.ts → src/new-name.ts<');
    expect(markup).toContain('data-git-commit-changed-file-status="src/new-name.ts"');
    expect(markup).toContain('>R<');
    expect(markup).not.toContain('data-git-commit-changed-directory-row=');
    expect(markup).not.toContain('>Binary<');
    expect(markup).not.toContain('>+4<');
    expect(markup).not.toContain('>-2<');
    expect(markup).not.toContain('data-diff-viewer');

    const fileRowButton = buttonRegistry.find((props) => props['data-git-commit-changed-file-row'] === 'src/new-name.ts');
    expect(fileRowButton).toBeDefined();
    const fileEvent = createPressEvent();
    invokeClick(fileRowButton?.onClick, fileEvent);
    expect(fileEvent.defaultPrevented).toBe(true);
    expect(fileEvent.propagationStopped).toBe(true);
    expect(selectedFiles).toEqual([
      {
        comparison,
        file: createChangedFile({ path: 'src/new-name.ts', originalPath: 'src/old-name.ts', status: 'R', insertions: 4, deletions: 2 }),
      },
    ]);
    expect(retriedComparisons).toEqual([]);

    const copyButton = buttonRegistry.find((props) => props['aria-label'] === 'Copy SHA');
    expect(copyButton).toBeDefined();
    const copyEvent = createPressEvent();
    invokeClick(copyButton?.onClick, copyEvent);
    expect(copyEvent.propagationStopped).toBe(true);
    expect(copiedHashes).toEqual(['abcdef1234567890']);
    expect(toggleCalls).toEqual([]);
  });

  test('hides graph mutation controls for read-only graph consumers while keeping changed file selection', () => {
    buttonRegistry.length = 0;
    const selectedFiles: Array<{ comparison: GitCommitComparison; file: GitCommitChangedFile }> = [];
    const comparison: GitCommitComparison = {
      directory: '/repo',
      commitHash: 'abcdef1234567890',
      parentHash: 'fedcba0987654321',
    };

    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ul>
          <HistoryCommitRow
            entry={{
              id: 'abcdef1234567890',
              parentIds: ['fedcba0987654321'],
              subject: 'Read-only graph row',
              message: 'Read-only graph row',
              author: 'Taylor Developer',
              authorEmail: 'taylor@example.com',
              timestamp: '2024-01-02T03:04:00.000Z',
              statistics: { files: 1, insertions: 2, deletions: 1 },
              references: [],
            }}
            mode="graph"
            isExpanded={true}
            onToggle={() => {}}
            files={[]}
            isLoadingFiles={false}
            onCopyHash={() => {}}
            directory="/repo"
            showGraphActions={false}
            commitComparison={comparison}
            commitDetailsController={{
              getCommitSnapshot: () => ({
                status: 'ready',
                files: [
                  createChangedFile({ path: 'src/readonly.ts', status: 'M', insertions: 2, deletions: 1 }),
                ],
              }),
              subscribeCommit: () => () => {},
              retryCommit: () => {},
              selectFile: (nextComparison, file) => {
                selectedFiles.push({ comparison: nextComparison, file });
              },
            }}
            selectedChangedFilePath="src/readonly.ts"
          />
        </ul>
      </I18nProvider>,
    );

    expect(markup).toContain('data-git-commit-changed-file-row="src/readonly.ts"');
    expect(markup).not.toContain('>Checkout</button>');
    expect(markup).not.toContain('>Create branch</button>');
    expect(markup).not.toContain('>Cherry-pick</button>');
    expect(markup).not.toContain('>Revert</button>');
    expect(markup).not.toContain('>Reset</button>');
    expect(markup).not.toContain('>Soft</button>');
    expect(markup).not.toContain('>Mixed</button>');
    expect(markup).not.toContain('>Hard</button>');
    expect(markup).not.toContain('>Merge</button>');
    expect(markup).not.toContain('>Rebase</button>');

    const fileRowButton = buttonRegistry.find((props) => props['data-git-commit-changed-file-row'] === 'src/readonly.ts');
    expect(fileRowButton).toBeDefined();
    const fileEvent = createPressEvent();
    invokeClick(fileRowButton?.onClick, fileEvent);
    expect(fileEvent.defaultPrevented).toBe(true);
    expect(fileEvent.propagationStopped).toBe(true);
    expect(selectedFiles).toEqual([
      {
        comparison,
        file: createChangedFile({ path: 'src/readonly.ts', status: 'M', insertions: 2, deletions: 1 }),
      },
    ]);
  });
});

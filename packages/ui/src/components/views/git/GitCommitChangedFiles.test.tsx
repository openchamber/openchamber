import React from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import type { GitCommitChangedFile } from '@/lib/api/types';

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

type TestKeyEvent = TestPressEvent & {
  key: string;
};

type MockButtonProps = React.PropsWithChildren<{
  type?: 'button' | 'submit' | 'reset';
  className?: string;
  title?: string;
  'aria-label'?: string;
  'aria-pressed'?: boolean;
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
  style?: React.CSSProperties;
  onClick?: (event: TestPressEvent) => void;
  onKeyDown?: (event: TestKeyEvent) => void;
  variant?: string;
  size?: string;
  'data-git-commit-changed-files-retry'?: string;
  'data-git-commit-changed-directory-toggle'?: string;
  'data-git-commit-changed-file-row'?: string;
}>;

const buttonRegistry: MockButtonProps[] = [];

mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: MockButtonProps) => {
    buttonRegistry.push({ children, ...props });
    const domProps: React.ButtonHTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, string | undefined> = {
      type: props.type,
      className: props.className,
      title: props.title,
      'aria-label': props['aria-label'],
      'aria-pressed': props['aria-pressed'],
      'aria-expanded': props['aria-expanded'],
      'aria-controls': props['aria-controls'],
      style: props.style,
      'data-git-commit-changed-files-retry': props['data-git-commit-changed-files-retry'],
      'data-git-commit-changed-directory-toggle': props['data-git-commit-changed-directory-toggle'],
      'data-git-commit-changed-file-row': props['data-git-commit-changed-file-row'],
    };

    return React.createElement('button', domProps, children);
  },
}));

mock.module('@/components/icons/FileTypeIcon', () => ({
  FileTypeIcon: ({ filePath, className }: { filePath: string; className?: string }) => (
    <span data-file-type-icon={filePath} className={className} />
  ),
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => (
    <span data-icon={name} className={className} />
  ),
}));

const { GitCommitChangedFiles } = await import('./GitCommitChangedFiles');

const createFile = (overrides: Partial<GitCommitChangedFile> & Pick<GitCommitChangedFile, 'path' | 'status'>): GitCommitChangedFile => ({
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

const renderMarkup = (element: React.ReactElement) => renderToStaticMarkup(<I18nProvider>{element}</I18nProvider>);

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

const invokeKeyDown = (
  handler: MockButtonProps['onKeyDown'] | undefined,
  event: TestKeyEvent,
) => {
  if (!handler) {
    return;
  }

  handler(event);
};

describe('GitCommitChangedFiles', () => {
  beforeEach(() => {
    buttonRegistry.length = 0;
  });

  test('renders list rows with status badges, file icons, rename label, stats, and selected state', () => {
    const markup = renderMarkup(
      <GitCommitChangedFiles
        snapshot={{
          status: 'ready',
          files: [
            createFile({ path: 'src/new-name.ts', originalPath: 'src/old-name.ts', status: 'R', insertions: 4, deletions: 2 }),
            createFile({ path: 'README.md', status: 'M', insertions: 1, deletions: 0 }),
          ],
        }}
        view="list"
        selectedPath="src/new-name.ts"
      />,
    );

    expect(markup).toContain('data-git-commit-changed-files="list"');
    expect(markup).toContain('data-git-commit-changed-file-row="src/new-name.ts"');
    expect(markup).toContain('data-file-type-icon="src/new-name.ts"');
    expect(markup).toContain('data-file-type-icon="README.md"');
    expect(markup).toContain('>R<');
    expect(markup).toContain('>M<');
    expect(markup).toContain('src/old-name.ts');
    expect(markup).toContain('src/new-name.ts');
    expect(markup).toContain('data-icon="arrow-right"');
    expect(markup).toContain('+4');
    expect(markup).toContain('-2');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('role="list"');
    expect(markup).toContain('role="listitem"');
  });

  test('uses list semantics only for ready snapshots and preserves tree row behavior', () => {
    const retryCalls: number[] = [];
    const selectCalls: GitCommitChangedFile[] = [];
    const toggledDirectories: string[] = [];
    const onRetry = mock(() => {
      retryCalls.push(1);
    });
    const onSelectFile = mock((file: GitCommitChangedFile) => {
      selectCalls.push(file);
    });
    const onToggleDirectory = mock((path: string) => {
      toggledDirectories.push(path);
    });
    const nestedFile = createFile({ path: 'src/lib/example.ts', status: 'A', insertions: 3, deletions: 1 });
    const binaryFile = createFile({ path: 'assets/logo.png', status: 'M', isBinary: true });

    const loadingMarkup = renderMarkup(
      <GitCommitChangedFiles snapshot={{ status: 'loading' }} />,
    );
    expect(loadingMarkup).not.toContain('role="list"');

    buttonRegistry.length = 0;
    const errorMarkup = renderMarkup(
      <GitCommitChangedFiles snapshot={{ status: 'error', error: new Error('offline'), retryCount: 1 }} onRetry={onRetry} />,
    );
    expect(errorMarkup).not.toContain('role="list"');

    const retryButton = buttonRegistry.find((props) => props['data-git-commit-changed-files-retry'] === 'true');
    expect(retryButton).toBeDefined();
    const retryEvent = createPressEvent();
    invokeClick(retryButton?.onClick, retryEvent);
    expect(retryEvent.defaultPrevented).toBe(true);
    expect(retryEvent.propagationStopped).toBe(true);
    expect(retryCalls.length).toBe(1);

    const emptyMarkup = renderMarkup(
      <GitCommitChangedFiles snapshot={{ status: 'empty' }} />,
    );
    expect(emptyMarkup).not.toContain('role="list"');

    buttonRegistry.length = 0;
    const collapsedTreeMarkup = renderMarkup(
      <GitCommitChangedFiles
        snapshot={{ status: 'ready', files: [nestedFile, binaryFile] }}
        view="tree"
        expandedDirectories={new Set()}
        onToggleDirectory={onToggleDirectory}
        onSelectFile={onSelectFile}
      />,
    );
    expect(collapsedTreeMarkup).toContain('data-git-commit-changed-files="tree"');
    expect(collapsedTreeMarkup).toContain('role="list"');
    expect(collapsedTreeMarkup).toContain('role="listitem"');
    expect(collapsedTreeMarkup).toContain('data-git-commit-changed-directory-row="src"');
    expect(collapsedTreeMarkup).toContain('aria-expanded="false"');
    expect(collapsedTreeMarkup).not.toContain('aria-controls="git-commit-changed-files-directory-src"');

    const directoryButton = buttonRegistry.find((props) => props['data-git-commit-changed-directory-toggle'] === 'src');
    expect(directoryButton).toBeDefined();
    const directoryEvent = createPressEvent();
    invokeClick(directoryButton?.onClick, directoryEvent);
    expect(directoryEvent.defaultPrevented).toBe(true);
    expect(directoryEvent.propagationStopped).toBe(true);
    expect(toggledDirectories).toEqual(['src']);
    expect(selectCalls).toEqual([]);

    buttonRegistry.length = 0;
    const expandedTreeMarkup = renderMarkup(
      <GitCommitChangedFiles
        snapshot={{ status: 'ready', files: [nestedFile, binaryFile] }}
        view="tree"
        expandedDirectories={new Set(['assets', 'src', 'src/lib'])}
        onToggleDirectory={onToggleDirectory}
        onSelectFile={onSelectFile}
      />,
    );
    expect(expandedTreeMarkup).toContain('aria-expanded="true"');
    expect(expandedTreeMarkup).toContain('aria-controls="git-commit-changed-files-directory-src"');
    expect(expandedTreeMarkup).toContain('data-git-commit-changed-file-row="src/lib/example.ts"');
    expect(expandedTreeMarkup).toContain('Binary');

    const fileButton = buttonRegistry.find((props) => props['data-git-commit-changed-file-row'] === 'src/lib/example.ts');
    expect(fileButton).toBeDefined();

    const enterEvent = createPressEvent();
    const enterKeyEvent = Object.assign(enterEvent, { key: 'Enter' });
    invokeKeyDown(fileButton?.onKeyDown, enterKeyEvent);
    expect(enterEvent.defaultPrevented).toBe(true);
    expect(enterEvent.propagationStopped).toBe(true);
    expect(selectCalls).toEqual([nestedFile]);

    const spaceEvent = createPressEvent();
    const spaceKeyEvent = Object.assign(spaceEvent, { key: ' ' });
    invokeKeyDown(fileButton?.onKeyDown, spaceKeyEvent);
    expect(spaceEvent.defaultPrevented).toBe(true);
    expect(spaceEvent.propagationStopped).toBe(true);
    expect(selectCalls).toEqual([nestedFile, nestedFile]);
  });
});

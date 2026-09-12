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
  style?: React.CSSProperties;
  onClick?: (event: TestPressEvent) => void;
  onKeyDown?: (event: TestKeyEvent) => void;
  variant?: string;
  size?: string;
  'data-git-commit-changed-files-retry'?: string;
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
      style: props.style,
      'data-git-commit-changed-files-retry': props['data-git-commit-changed-files-retry'],
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

  test('renders compact flat rows with filename, dimmed path, rename meaning, and status letters', () => {
    const markup = renderMarkup(
      <GitCommitChangedFiles
        snapshot={{
          status: 'ready',
          files: [
            createFile({ path: 'src/new-name.ts', originalPath: 'src/old-name.ts', status: 'R', insertions: 4, deletions: 2 }),
            createFile({ path: 'src/lib/example.ts', status: 'A', insertions: 1, deletions: 0 }),
            createFile({ path: 'README.md', status: 'M', insertions: 2, deletions: 1 }),
            createFile({ path: 'assets/logo.png', status: 'D', isBinary: true }),
          ],
        }}
        selectedPath="src/new-name.ts"
      />,
    );

    expect(markup).toContain('data-git-commit-changed-files="flat"');
    expect(markup).toContain('data-git-commit-changed-file-row="src/new-name.ts"');
    expect(markup).toContain('data-git-commit-changed-file-name="src/new-name.ts"');
    expect(markup).toContain('>new-name.ts<');
    expect(markup).toContain('data-git-commit-changed-file-directory="src/new-name.ts"');
    expect(markup).toContain('>src/old-name.ts → src/new-name.ts<');
    expect(markup).toContain('data-git-commit-changed-file-status="src/new-name.ts"');
    expect(markup).toContain('>R<');
    expect(markup).toContain('data-git-commit-changed-file-name="src/lib/example.ts"');
    expect(markup).toContain('>example.ts<');
    expect(markup).toContain('data-git-commit-changed-file-directory="src/lib/example.ts"');
    expect(markup).toContain('>src/lib<');
    expect(markup).toContain('data-git-commit-changed-file-status="src/lib/example.ts"');
    expect(markup).toContain('data-git-commit-changed-file-status="README.md"');
    expect(markup).toContain('data-git-commit-changed-file-status="assets/logo.png"');
    expect(markup).toContain('data-file-type-icon="src/new-name.ts"');
    expect(markup).toContain('data-file-type-icon="README.md"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('role="list"');
    expect(markup).toContain('role="listitem"');
    expect(markup).not.toContain('data-git-commit-changed-directory-row=');
    expect(markup).not.toContain('>Binary<');
    expect(markup).not.toContain('>+4<');
    expect(markup).not.toContain('>-2<');
  });

  test('preserves loading, retry, empty, and file selection behavior without directory toggles', () => {
    const retryCalls: number[] = [];
    const selectCalls: GitCommitChangedFile[] = [];
    const onRetry = mock(() => {
      retryCalls.push(1);
    });
    const onSelectFile = mock((file: GitCommitChangedFile) => {
      selectCalls.push(file);
    });
    const nestedFile = createFile({ path: 'src/lib/example.ts', status: 'A', insertions: 3, deletions: 1 });

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
    const readyMarkup = renderMarkup(
      <GitCommitChangedFiles
        snapshot={{ status: 'ready', files: [nestedFile] }}
        onSelectFile={onSelectFile}
      />,
    );
    expect(readyMarkup).toContain('data-git-commit-changed-files="flat"');
    expect(readyMarkup).toContain('data-git-commit-changed-file-row="src/lib/example.ts"');

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

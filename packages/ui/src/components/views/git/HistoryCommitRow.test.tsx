import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';

type MockButtonProps = React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>;
type MockWrapperProps = React.PropsWithChildren<{ asChild?: boolean }>;

mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: MockButtonProps) => <button {...props}>{children}</button>,
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

mock.module('@/components/views/PierreDiffViewer', () => ({
  PierreDiffViewer: () => <div data-diff-viewer />,
}));

mock.module('@/components/ui/toast', () => ({
  toast: {
    success() {},
    error() {},
  },
}));

mock.module('@/stores/useUIStore', () => ({
  useUIStore: <T,>(selector: (state: { timeFormatPreference: 'absolute-12h' }) => T) => selector({ timeFormatPreference: 'absolute-12h' }),
}));

const { HistoryCommitRow } = await import('./HistoryCommitRow');

describe('HistoryCommitRow compact graph regression', () => {
  test('renders collapsed compact graph rows inline without date hash or copy controls', () => {
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
});

import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { Session } from '@opencode-ai/sdk/v2';
import type {
  SessionTreeMoveIntent,
  SessionTreeMoveMessages,
} from '@/lib/worktrees/sessionWorktreeMove';

type MockDialogProps = React.PropsWithChildren<{
  open?: boolean;
  id?: string;
  className?: string;
}>;

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children, open = true }: MockDialogProps) => (open ? <>{children}</> : null),
  DialogContent: ({ children, id, className }: MockDialogProps) => (
    <div id={id} className={className}>{children}</div>
  ),
  DialogDescription: ({ children }: MockDialogProps) => <p>{children}</p>,
  DialogFooter: ({ children, className }: MockDialogProps) => <div className={className}>{children}</div>,
  DialogHeader: ({ children }: MockDialogProps) => <div>{children}</div>,
  DialogTitle: ({ children }: MockDialogProps) => <h2>{children}</h2>,
}));

const { SessionWorktreeMoveConfirmDialog } = await import('./SessionWorktreeMoveConfirmDialog');

const makeMoveMessages = (): SessionTreeMoveMessages => ({
  success: 'move succeeded',
  failure: 'move failed',
  sourceVerificationFailed: 'source verification failed',
  applyChangesFailed: 'apply changes failed',
});

const makeExistingIntent = (): SessionTreeMoveIntent => ({
  kind: 'existing',
  root: {
    id: 'root',
    slug: 'root',
    projectID: 'project-1',
    directory: '/source',
    title: 'Root session',
    version: '1',
    time: { created: 0, updated: 0 },
  } satisfies Session,
  descendants: [],
  sourceDirectory: '/source',
  destination: {
    path: '/destination',
    projectDirectory: '/repo',
    branch: 'feature',
    label: 'Destination',
    worktreeStatus: 'ready',
    worktreeSource: 'existing',
  },
  messages: makeMoveMessages(),
});

describe('SessionWorktreeMoveConfirmDialog', () => {
  test('renders stable semantic hooks, dirty file count, and the staged warning', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <SessionWorktreeMoveConfirmDialog
          value={{
            intent: makeExistingIntent(),
            dirtyFileCount: 2,
            stagedFileCount: 1,
          }}
          onMoveSessionOnly={() => {}}
          onMoveAllChanges={() => {}}
          onCancel={() => {}}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('id="session-worktree-move-confirm-dialog"');
    expect(markup).toContain('data-session-worktree-move-action="session-only"');
    expect(markup).toContain('data-session-worktree-move-action="all-changes"');
    expect(markup).toContain('data-session-worktree-move-action="cancel"');
    expect(markup).toContain('autofocus=""');
    expect(markup).toContain('2');
    expect(markup).toContain('data-session-worktree-move-staged-warning="true"');
  });

  test('omits the staged warning when no staged files are present', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <SessionWorktreeMoveConfirmDialog
          value={{
            intent: makeExistingIntent(),
            dirtyFileCount: 3,
            stagedFileCount: 0,
          }}
          onMoveSessionOnly={() => {}}
          onMoveAllChanges={() => {}}
          onCancel={() => {}}
        />
      </I18nProvider>,
    );

    expect(markup).not.toContain('data-session-worktree-move-staged-warning="true"');
  });
});

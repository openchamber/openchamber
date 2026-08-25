import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionNodeItemProps } from './SessionNodeItem';
import { installHookTestDom } from '../test-utils/testDom';
import { I18nProvider } from '@/lib/i18n';

const renderedRows: SessionNodeItemProps[] = [];

mock.module('./SessionNodeItem', () => ({
  SessionNodeItem: (props: SessionNodeItemProps) => {
    renderedRows.push(props);
    return null;
  },
}));

mock.module('./hooks/useSessionActions', () => ({
  useSessionActions: (args: {
    setEditingId: (id: string | null) => void;
    setEditTitle: (title: string) => void;
  }) => ({
    copiedSessionId: null,
    handleSaveEdit: () => undefined,
    handleCancelEdit: () => undefined,
    handleSessionSelect: () => undefined,
    handleSessionDoubleClick: (id: string, title: string) => {
      args.setEditingId(id);
      args.setEditTitle(title);
    },
    handleShareSession: () => undefined,
    handleCopyShareUrl: () => undefined,
    handleCopySessionId: () => undefined,
    handleUnshareSession: () => undefined,
    handleDeleteSession: () => undefined,
    handleRestoreSession: () => undefined,
  }),
}));

const { SessionTreeItem } = await import('./SessionTreeItem');

const session = (id: string): Session => ({
  id,
  slug: id,
  projectID: 'project',
  title: 'Shared title',
  version: '1',
  directory: '/workspace',
  time: { created: 1, updated: 1 },
});

describe('SessionTreeItem public behavior', () => {
  test('coordinates duplicate project and Recent rows through their shared visible-list state', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const sharedSession = session('same-session');
    const rowNode = { session: sharedSession, children: [], worktree: null };
    const noop = () => undefined;

    const Harness = () => {
      const [editingId, setEditingId] = React.useState<string | null>(null);
      const [editTitle, setEditTitle] = React.useState('');
      const [menuKey, setMenuKey] = React.useState<string | null>(null);
      const [copiedSessionId, setCopiedSessionId] = React.useState<string | null>(null);
      const rows = [
        { renderContext: 'project' as const, groupDirectory: '/workspace' },
        { renderContext: 'recent' as const, groupDirectory: '/workspace' },
      ];
      return <>{rows.map((context) => <SessionTreeItem
        key={context.renderContext}
        node={rowNode}
        pinnedSessionIds={new Set()}
        expandedParents={new Set()}
        hasSessionSearchQuery={false}
        normalizedSessionSearchQuery=""
        notifyOnSubtasks={false}
        editingId={editingId}
        setEditingId={setEditingId}
        editTitle={editTitle}
        setEditTitle={setEditTitle}
        toggleParent={noop}
        copiedSessionId={copiedSessionId}
        openSidebarMenuKey={menuKey}
        setOpenSidebarMenuKey={setMenuKey}
        allowReselect={false}
        isSessionSearchOpen={false}
        sessionSearchQuery=""
        setSessionSearchQuery={noop}
        setIsSessionSearchOpen={noop}
        deleteSessionConfirm={null}
        setDeleteSessionConfirm={noop}
        startFolderRename={noop}
        setCopiedSessionId={setCopiedSessionId}
        mobileVariant={false}
        alwaysShowActions={false}
        {...context}
      />)}</>;
    };

    try {
      await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
      expect(renderedRows).toHaveLength(2);

      await act(async () => renderedRows[0]?.handleSessionDoubleClick(sharedSession.id, sharedSession.title));
      expect(renderedRows).toHaveLength(4);
      expect(renderedRows.slice(-2).map((row) => [row.editingId, row.editTitle]))
        .toEqual([[sharedSession.id, sharedSession.title], [sharedSession.id, sharedSession.title]]);

      await act(async () => renderedRows[3]?.setOpenSidebarMenuKey('recent:active:same-session'));
      expect(renderedRows).toHaveLength(6);
      expect(renderedRows.slice(-2).map((row) => row.openSidebarMenuKey))
        .toEqual(['recent:active:same-session', 'recent:active:same-session']);
    } finally {
      await act(async () => root.unmount());
      renderedRows.length = 0;
      dom.restore();
    }
  });
});

import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionNodeItemProps } from './SessionNodeItem';
import type { SessionTreeItemProps } from './SessionTreeItem';
import { installHookTestDom } from '../test-utils/testDom';
import { I18nProvider } from '@/lib/i18n';

const renderedRows: SessionNodeItemProps[] = [];

mock.module('./SessionNodeItem', () => ({
  SessionNodeItem: (props: SessionNodeItemProps) => {
    renderedRows.push(props);
    return <>{props.children}</>;
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

const noopStartSessionWorktreeMenuLoad: SessionTreeItemProps['startSessionWorktreeMenuLoad'] = () => ({
  cachedTargets: [],
  refreshTargets: Promise.resolve([]),
});

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
        { renderContext: 'project' as const, groupDirectory: '/workspace', selectionScopeKey: '/workspace', rowKey: 'project:session:same-session' },
        { renderContext: 'recent' as const, groupDirectory: '/workspace', selectionScopeKey: '/workspace', rowKey: 'activity:active-now:same-session:0:session:same-session' },
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
        resetSessionSearch={noop}
        deleteSessionConfirm={null}
        setDeleteSessionConfirm={noop}
        startFolderRename={noop}
        setCopiedSessionId={setCopiedSessionId}
        startSessionWorktreeMenuLoad={noopStartSessionWorktreeMenuLoad}
        mobileVariant={false}
        alwaysShowActions={false}
        {...context}
      />)}</>;
    };

    try {
      await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
      expect(renderedRows).toHaveLength(2);
      expect(renderedRows.map((row) => row.rowKey)).toEqual([
        'project:session:same-session',
        'activity:active-now:same-session:0:session:same-session',
      ]);
      expect(renderedRows.map((row) => row.dragKey)).toEqual([
        'project:session:same-session',
        'activity:active-now:same-session:0:session:same-session',
      ]);
      expect(renderedRows.map((row) => row.selectionScopeKey)).toEqual(['/workspace', '/workspace']);

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

  test('derives distinct drag keys for normal tree and duplicate child occurrences', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const noop = () => undefined;
    const duplicateChild = (id: string): SessionNodeItemProps['node'] => ({
      session: session(id),
      children: [],
      worktree: null,
    });
    const rootNode: SessionNodeItemProps['node'] = {
      session: session('normal-root'),
      children: [duplicateChild('normal-child'), duplicateChild('normal-child')],
      worktree: null,
    };
    const rootRowKey = 'project:main:folder:/workspace\u0000folder-a:session:normal-root';

    try {
      await act(async () => root.render(
        <I18nProvider>
          <SessionTreeItem
            node={rootNode}
            pinnedSessionIds={new Set()}
            expandedParents={new Set()}
            hasSessionSearchQuery={false}
            normalizedSessionSearchQuery=""
            notifyOnSubtasks={false}
            editingId={null}
            setEditingId={noop}
            editTitle=""
            setEditTitle={noop}
            toggleParent={noop}
            copiedSessionId={null}
            openSidebarMenuKey={null}
            setOpenSidebarMenuKey={noop}
            allowReselect={false}
            resetSessionSearch={noop}
            deleteSessionConfirm={null}
            setDeleteSessionConfirm={noop}
            startFolderRename={noop}
            setCopiedSessionId={noop}
            startSessionWorktreeMenuLoad={noopStartSessionWorktreeMenuLoad}
            mobileVariant={false}
            alwaysShowActions={false}
            rowKey={rootRowKey}
          />
        </I18nProvider>,
      ));

      const rows = renderedRows.map((row) => ({
        id: row.node.session.id,
        rowKey: row.rowKey,
        dragKey: row.dragKey,
      }));
      expect(rows).toEqual([
        { id: 'normal-root', rowKey: rootRowKey, dragKey: rootRowKey },
        {
          id: 'normal-child',
          rowKey: `${rootRowKey}/child:normal-child`,
          dragKey: `${rootRowKey}/child:normal-child`,
        },
        {
          id: 'normal-child',
          rowKey: `${rootRowKey}/child:normal-child:1`,
          dragKey: `${rootRowKey}/child:normal-child:1`,
        },
      ]);
      expect(new Set(rows.map((row) => `session-drag:${row.dragKey}`)).size).toBe(3);
    } finally {
      await act(async () => root.unmount());
      renderedRows.length = 0;
      dom.restore();
    }
  });
});

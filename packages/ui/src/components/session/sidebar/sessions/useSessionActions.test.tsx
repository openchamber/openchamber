import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '@opencode-ai/sdk/v2';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { I18nProvider } from '@/lib/i18n';
import type { DeleteSessionConfirmState } from '../shell/ConfirmDialogs';
import { useSessionActions } from './useSessionActions';
import { installHookTestDom } from '../test-utils/testDom';

const session = (id: string): Session => ({
  id,
  slug: id,
  projectID: 'project',
  title: id,
  version: '1',
  directory: '/workspace',
  time: { created: 1, updated: 1 },
});

describe('explicit session row behavior', () => {
  test('shares edit and menu state across project and Recent render contexts', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    type SharedRowCapture = {
      actions?: ReturnType<typeof useSessionActions>;
      editingId?: string | null;
      editTitle?: string;
      menuKey?: string | null;
      setMenuKey?: (key: string | null) => void;
      project?: { editingId: string | null; editTitle: string; menuKey: string | null };
      recent?: { editingId: string | null; editTitle: string; menuKey: string | null };
    };
    const capture: SharedRowCapture = {};
    const RowConsumer = ({ context, editingId, editTitle, menuKey }: {
      context: 'project' | 'recent';
      editingId: string | null;
      editTitle: string;
      menuKey: string | null;
    }) => {
      capture[context] = { editingId, editTitle, menuKey };
      return null;
    };
    const Harness = () => {
      const [editingId, setEditingId] = React.useState<string | null>(null);
      const [editTitle, setEditTitle] = React.useState('');
      const [menuKey, setMenuKey] = React.useState<string | null>(null);
      const [confirmation, setConfirmation] = React.useState<DeleteSessionConfirmState>(null);
      capture.actions = useSessionActions({
        mobileVariant: false,
        allowReselect: false,
        isSessionSearchOpen: false,
        sessionSearchQuery: '',
        setSessionSearchQuery: () => undefined,
        setIsSessionSearchOpen: () => undefined,
        descendantIds: [],
        showDeletionDialog: true,
        setDeleteSessionConfirm: setConfirmation,
        deleteSessionConfirm: confirmation,
        editingId,
        setEditingId,
        editTitle,
        setEditTitle,
        copiedSessionId: null,
        setCopiedSessionId: () => undefined,
      });
      capture.editingId = editingId;
      capture.editTitle = editTitle;
      capture.menuKey = menuKey;
      capture.setMenuKey = setMenuKey;
      return React.createElement(React.Fragment, null,
        React.createElement(RowConsumer, { context: 'project', editingId, editTitle, menuKey }),
        React.createElement(RowConsumer, { context: 'recent', editingId, editTitle, menuKey }),
      );
    };
    try {
      await act(async () => root.render(React.createElement(I18nProvider, null, React.createElement(Harness))));
      await act(async () => capture.actions!.handleSessionDoubleClick('same-session', 'Shared title'));
      expect(capture.editingId).toBe('same-session');
      expect(capture.editTitle).toBe('Shared title');
      expect(capture.project).toEqual(capture.recent);
      await act(async () => capture.setMenuKey!('recent:active:same-session'));
      expect(capture.menuKey).toBe('recent:active:same-session');
      expect(capture.project).toEqual(capture.recent);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('executes the immutable descendant snapshot captured when confirmation opens', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const original = useSessionUIStore.getState();
    const archivedCalls: string[][] = [];
    useSessionUIStore.setState({
      archiveSessions: async (ids) => {
        archivedCalls.push(ids);
        return { archivedIds: ids, failedIds: [] };
      },
    });
    const descendants = ['child-a', 'child-b'];
    type ConfirmationCapture = {
      actions?: ReturnType<typeof useSessionActions>;
      confirmation?: DeleteSessionConfirmState;
    };
    const capture: ConfirmationCapture = {};
    const Harness = () => {
      const [editingId, setEditingId] = React.useState<string | null>(null);
      const [editTitle, setEditTitle] = React.useState('');
      const [confirmation, setConfirmation] = React.useState<DeleteSessionConfirmState>(null);
      capture.confirmation = confirmation;
      capture.actions = useSessionActions({
        mobileVariant: false,
        allowReselect: false,
        isSessionSearchOpen: false,
        sessionSearchQuery: '',
        setSessionSearchQuery: () => undefined,
        setIsSessionSearchOpen: () => undefined,
        descendantIds: descendants,
        showDeletionDialog: true,
        setDeleteSessionConfirm: setConfirmation,
        deleteSessionConfirm: confirmation,
        editingId,
        setEditingId,
        editTitle,
        setEditTitle,
        copiedSessionId: null,
        setCopiedSessionId: () => undefined,
      });
      return null;
    };
    try {
      await act(async () => root.render(React.createElement(I18nProvider, null, React.createElement(Harness))));
      await act(async () => capture.actions!.handleDeleteSession(session('root')));
      expect(capture.confirmation?.descendantIds).toEqual(['child-a', 'child-b']);
      await act(async () => capture.actions!.confirmDeleteSession());
      expect(archivedCalls).toEqual([['root', 'child-a', 'child-b']]);
    } finally {
      await act(async () => root.unmount());
      useSessionUIStore.setState({ archiveSessions: original.archiveSessions });
      dom.restore();
    }
  });
});

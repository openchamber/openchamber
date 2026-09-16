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
        resetSessionSearch: () => undefined,
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
        resetSessionSearch: () => undefined,
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

  test('selection resets search through the stable intent callback', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const original = useSessionUIStore.getState();
    const selected: string[] = [];
    type SearchResetCapture = {
      actions: ReturnType<typeof useSessionActions> | null;
      query: string;
      open: boolean;
      setQuery: ((value: string) => void) | null;
      setOpen: ((open: boolean) => void) | null;
      resetCalls: number;
    };
    const capture: SearchResetCapture = {
      actions: null,
      query: 'release',
      open: true,
      setQuery: null,
      setOpen: null,
      resetCalls: 0,
    };
    const Harness = () => {
      const [query, setQuery] = React.useState('release');
      const [open, setOpen] = React.useState(true);
      // Mirrors SessionSidebar.resetSessionSearch: dependency-free functional
      // updates keep the intent callback stable while the user types.
      const resetSessionSearch = React.useCallback(() => {
        capture.resetCalls += 1;
        setQuery((current) => (current.length === 0 ? current : ''));
        setOpen((current) => (current ? false : current));
      }, []);
      capture.query = query;
      capture.open = open;
      capture.setQuery = setQuery;
      capture.setOpen = setOpen;
      capture.actions = useSessionActions({
        mobileVariant: false,
        allowReselect: false,
        resetSessionSearch,
        descendantIds: [],
        showDeletionDialog: false,
        setDeleteSessionConfirm: () => undefined,
        deleteSessionConfirm: null,
        setEditingId: () => undefined,
        setEditTitle: () => undefined,
        editingId: null,
        editTitle: '',
        copiedSessionId: null,
        setCopiedSessionId: () => undefined,
      });
      return null;
    };

    useSessionUIStore.setState({
      currentSessionId: 'current-session',
      setCurrentSession: (sessionId) => {
        if (sessionId) selected.push(sessionId);
        useSessionUIStore.setState({ currentSessionId: sessionId });
      },
    });

    try {
      await act(async () => root.render(React.createElement(I18nProvider, null, React.createElement(Harness))));
      const stableSelect = capture.actions!.handleSessionSelect;

      // Typing must not rebuild the row select callback: raw search state is
      // no longer part of the hook's inputs.
      act(() => capture.setQuery!('release-2'));
      expect(capture.actions!.handleSessionSelect).toBe(stableSelect);

      // Query + open -> both reset when another session is selected.
      await act(async () => capture.actions!.handleSessionSelect('next-session'));
      expect(selected).toEqual(['next-session']);
      expect(capture.query).toBe('');
      expect(capture.open).toBe(false);
      expect(capture.resetCalls).toBe(1);

      // Already empty + closed -> the reset is an observable no-op.
      await act(async () => capture.actions!.handleSessionSelect('third-session'));
      expect(capture.query).toBe('');
      expect(capture.open).toBe(false);
      expect(capture.resetCalls).toBe(2);

      // Reselecting the current session also resets.
      act(() => {
        capture.setQuery!('release-3');
        capture.setOpen!(true);
      });
      await act(async () => capture.actions!.handleSessionSelect('third-session'));
      expect(capture.query).toBe('');
      expect(capture.open).toBe(false);
      expect(capture.resetCalls).toBe(3);
    } finally {
      await act(async () => root.unmount());
      useSessionUIStore.setState({
        currentSessionId: original.currentSessionId,
        setCurrentSession: original.setCurrentSession,
      });
      dom.restore();
    }
  });
});

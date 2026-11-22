import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { useSessionDraftsStore, type SessionDraft } from '@/stores/useSessionDraftsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionDraftRow } from './useSessionDraftRow';

describe('discarding an open draft', () => {
  test('keeps its folder destination in the fresh composer', async () => {
    const win = new Window({ url: 'http://localhost' });
    for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    const draft: SessionDraft = { id: 'draft', directory: '/repo', projectId: 'project', targetFolderId: 'folder', text: 'hello', mentions: [], attachments: [], createdAt: 1, updatedAt: 1 };
    const previousUI = useSessionUIStore.getState();
    const discard = useSessionDraftsStore.getState().discard;
    useSessionDraftsStore.setState({ discard: async () => {} });
    useSessionUIStore.setState({ currentSessionId: null, newSessionDraft: { ...previousUI.newSessionDraft, open: true, workDraftId: draft.id } });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const Row = () => {
      const row = useSessionDraftRow(draft, () => {});
      return <button onClick={row.discard}>Discard</button>;
    };
    try {
      await act(async () => root.render(<I18nProvider><Row /></I18nProvider>));
      await act(async () => container.querySelector('button')?.click());
      expect(useSessionUIStore.getState().newSessionDraft.targetFolderId).toBe('folder');
    } finally {
      await act(async () => root.unmount());
      useSessionDraftsStore.setState({ discard });
      useSessionUIStore.setState({ currentSessionId: previousUI.currentSessionId, newSessionDraft: previousUI.newSessionDraft });
    }
  });
});

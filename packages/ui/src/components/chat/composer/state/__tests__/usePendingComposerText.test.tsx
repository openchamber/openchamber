import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import {
    ChatColumnActionsContext,
    ChatColumnSessionContext,
    useChatColumnActions,
    type ChatColumnSession,
} from '../../../chatColumnSession';
import { usePendingComposerText } from '../usePendingComposerText';

type Column = { session: ChatColumnSession | null; pinned: boolean; /** Overrides the column address the composer takes text for. */ target?: string | null; /** Overrides the session this composer shows. */ shownSessionId?: string | null };

function renderComposer(initial: Column) {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const result = { text: '' };

    function Probe({ target, sessionId }: { target: string | null; sessionId: string | null }) {
        const [message, setMessage] = React.useState('');
        usePendingComposerText({ target, sessionId, setMessage, focus: () => undefined });
        result.text = message;
        return null;
    }

    function Column({ column }: { column: Column }) {
        const actions = useChatColumnActions();
        const target = column.target !== undefined ? column.target : column.pinned ? column.session?.sessionId ?? null : null;
        const sessionId = column.shownSessionId !== undefined ? column.shownSessionId : column.session?.sessionId ?? null;
        return React.createElement(
            ChatColumnActionsContext.Provider,
            { value: { ...actions, pinned: column.pinned } },
            React.createElement(
                ChatColumnSessionContext.Provider,
                { value: column.session },
                React.createElement(Probe, { target, sessionId }),
            ),
        );
    }

    const render = (column: Column) => {
        act(() => { root.render(React.createElement(Column, { column })); });
    };
    render(initial);
    return {
        result,
        render,
        teardown: () => {
            act(() => { root.unmount(); });
            dom.restore();
        },
    };
}

beforeEach(() => {
    useSessionUIStore.setState({ currentSessionId: 'ses_previous' });
    useInputStore.getState().setPendingInputText(null);
    useInputStore.setState({ pendingSessionRestores: new Map() });
});

afterEach(() => {
    useInputStore.getState().setPendingInputText(null);
});

describe('pending composer text', () => {
    test('waits for the main column to show a new draft opened with a prompt', () => {
        const previous = { sessionId: 'ses_previous', directory: '/repo' };
        const composer = renderComposer({ session: previous, pinned: false });
        try {
            // A new draft clears the selection and leaves its prompt in the same
            // update; the deferred column still shows the previous session.
            act(() => {
                useSessionUIStore.setState({ currentSessionId: null });
                useInputStore.getState().setPendingInputText('Resolve the conflict');
            });
            expect(composer.result.text).toBe('');
            expect(useInputStore.getState().pendingInputText).toBe('Resolve the conflict');

            composer.render({ session: { sessionId: null, directory: null }, pinned: false });
            expect(composer.result.text).toBe('Resolve the conflict');
            expect(useInputStore.getState().pendingInputText).toBeNull();
        } finally {
            composer.teardown();
        }
    });

    test('takes text at once when the column already shows the selection', () => {
        const composer = renderComposer({ session: { sessionId: 'ses_previous', directory: '/repo' }, pinned: false });
        try {
            act(() => { useInputStore.getState().setPendingInputText('one', 'append'); });
            act(() => { useInputStore.getState().setPendingInputText('two', 'append'); });
            expect(composer.result.text).toBe('one\n\ntwo\n\n');
        } finally {
            composer.teardown();
        }
    });

    test('a pinned column takes its own text while the main chat is elsewhere', () => {
        const composer = renderComposer({ session: { sessionId: 'ses_pinned', directory: '/repo' }, pinned: true });
        try {
            act(() => { useInputStore.getState().setPendingInputText('for the main chat'); });
            expect(composer.result.text).toBe('');
            act(() => { useInputStore.getState().setPendingInputText('> quoted', 'replace', 'ses_pinned'); });
            expect(composer.result.text).toBe('> quoted');
        } finally {
            composer.teardown();
        }
    });

    test('a composer on a /btw fork takes the chat text and leaves another session\'s restore waiting', () => {
        const composer = renderComposer({
            session: { sessionId: 'ses_parent', directory: '/repo' },
            pinned: false,
            target: null,
            shownSessionId: 'ses_fork',
        });
        try {
            act(() => { useSessionUIStore.setState({ currentSessionId: 'ses_parent' }); });
            // Written by a surface acting on the chat on screen, so the fork,
            // being that composer, takes it now.
            act(() => { useInputStore.getState().setPendingInputText('> quoted', 'append'); });
            expect(composer.result.text).toBe('> quoted\n\n');

            // A restore addressed to the parent waits: the fork must not eat the
            // parent's prompt, and the parent takes it once it is back on screen.
            act(() => { useInputStore.getState().setPendingSessionRestore('ses_parent', 'parent prompt'); });
            expect(composer.result.text).toBe('> quoted\n\n');
            expect(useInputStore.getState().pendingSessionRestores.get('ses_parent')).toBe('parent prompt');

            act(() => { useInputStore.getState().setPendingInputText('plugin text', 'append'); });
            expect(composer.result.text).toBe('> quoted\n\nplugin text\n\n');

            // Its own session's restore goes in.
            act(() => { useInputStore.getState().setPendingSessionRestore('ses_fork', 'fork prompt'); });
            expect(composer.result.text).toBe('fork prompt');
            composer.render({ session: { sessionId: 'ses_parent', directory: '/repo' }, pinned: false });
            expect(composer.result.text).toBe('parent prompt');
            expect(useInputStore.getState().consumePendingSessionRestore('ses_parent')).toBeNull();
        } finally {
            composer.teardown();
        }
    });

    test('a pinned fork takes column quotes but leaves the parent restore until collapse', () => {
        const column = { session: { sessionId: 'ses_pinned', directory: '/repo' }, pinned: true };
        const composer = renderComposer({ ...column, shownSessionId: 'ses_fork' });
        try {
            act(() => { useInputStore.getState().setPendingInputText('> quoted', 'append', 'ses_pinned'); });
            expect(composer.result.text).toBe('> quoted\n\n');
            act(() => { useInputStore.getState().setPendingSessionRestore('ses_pinned', 'parent prompt'); });
            expect(composer.result.text).toBe('> quoted\n\n');
            expect(useInputStore.getState().pendingSessionRestores.get('ses_pinned')).toBe('parent prompt');
            act(() => { useInputStore.getState().setPendingInputText('> another quote', 'append', 'ses_pinned'); });
            expect(composer.result.text).toBe('> quoted\n\n> another quote\n\n');
            composer.render(column);
            expect(composer.result.text).toBe('parent prompt');
            expect(useInputStore.getState().pendingInputText).toBeNull();
        } finally {
            composer.teardown();
        }
    });
});

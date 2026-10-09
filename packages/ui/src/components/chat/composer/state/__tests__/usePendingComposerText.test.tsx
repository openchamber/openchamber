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

type Column = { session: ChatColumnSession | null; pinned: boolean };

function renderComposer(initial: Column) {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const result = { text: '' };

    function Probe({ target }: { target: string | null }) {
        const [message, setMessage] = React.useState('');
        usePendingComposerText({ enabled: true, target, setMessage, focus: () => undefined });
        result.text = message;
        return null;
    }

    function Column({ column }: { column: Column }) {
        const actions = useChatColumnActions();
        const target = column.pinned ? column.session?.sessionId ?? null : null;
        return React.createElement(
            ChatColumnActionsContext.Provider,
            { value: { ...actions, pinned: column.pinned } },
            React.createElement(
                ChatColumnSessionContext.Provider,
                { value: column.session },
                React.createElement(Probe, { target }),
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
});

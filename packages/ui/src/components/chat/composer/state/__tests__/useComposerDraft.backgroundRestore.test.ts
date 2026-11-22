import { beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { readChatDraft, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { useInputStore } from '@/sync/input-store';
import { createComposerText } from '../composerText';
import { useComposerDraft, type ComposerDraftControls } from '../useComposerDraft';

// A send that waited on a background goal gives its text back through
// restoreDraft when the goal is not written. By then the user may have typed
// a new message, in the same composer or in a new draft. Oracle: nothing the
// user wrote is lost, both messages exist, and each stays with the chat it
// was written for.

const newDraft: ChatDraftIdentity = { runtimeKey: 'runtime-a', directory: '/repo-a', sessionId: null };
const createdSession: ChatDraftIdentity = { ...newDraft, sessionId: 'created' };
const otherSession: ChatDraftIdentity = { ...newDraft, sessionId: 'other' };

function renderComposer(initialIdentity: ChatDraftIdentity) {
    const dom = installHookTestDom();
    // The draft hook schedules its caret callbacks on a frame; none of them matter here.
    const originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 0;
    const root = createRoot(dom.container);
    interface ProbeState {
        text: string;
        controls: ComposerDraftControls | null;
        setText: (text: string) => void;
    }
    const state: ProbeState = {
        text: '',
        controls: null,
        setText: () => undefined,
    };

    function Probe({ identity }: { identity: ChatDraftIdentity }) {
        const [text] = React.useState(() => createComposerText(''));
        const [, setRevision] = React.useState(0);
        const setMessage = React.useCallback((next: string) => {
            text.set(next);
            setRevision((revision) => revision + 1);
        }, [text]);
        const confirmedMentionsRef = React.useRef(new Set<string>());
        state.controls = useComposerDraft({
            text, setMessage, confirmedMentionsRef, identity,
            initialDraft: { text: '', identity: initialIdentity },
            newSessionDraftId: identity.sessionId === null ? 1 : null,
        });
        state.text = text.get();
        state.setText = setMessage;
        return null;
    }

    const render = (identity: ChatDraftIdentity) => {
        act(() => { root.render(React.createElement(Probe, { identity })); });
    };
    render(initialIdentity);
    return {
        state,
        render,
        type: (text: string) => act(() => { state.setText(text); }),
        restore: (identity: ChatDraftIdentity, text: string) => act(() => { state.controls?.restoreDraft(identity, text, new Set()); }),
        teardown: () => {
            act(() => { root.unmount(); });
            globalThis.requestAnimationFrame = originalRaf;
            dom.restore();
        },
    };
}

beforeEach(() => {
    getDeferredSafeStorage().removeItem('openchamber.chatDrafts.v2');
    useInputStore.setState({ pendingComposerRestore: null, attachmentDraftKey: null, attachmentDrafts: new Map() });
});

describe('a background send that fails after the user moved on', () => {
    test('a reply comes back below what the user typed since in the same composer', () => {
        const composer = renderComposer(otherSession);
        try {
            composer.type('a newer message');
            composer.restore(otherSession, 'the reply that waited');
            expect(composer.state.text).toBe('a newer message\n\nthe reply that waited');
            expect(readChatDraft(otherSession).text).toBe('a newer message\n\nthe reply that waited');
        } finally {
            composer.teardown();
        }
    });

    test('a new task goes to the session it created, and the new draft keeps its own text', () => {
        const composer = renderComposer(newDraft);
        try {
            composer.type('the next task');
            composer.restore(createdSession, 'the task that waited');

            expect(composer.state.text).toBe('the next task');
            expect(readChatDraft(createdSession).text).toBe('the task that waited');

            composer.render(createdSession);
            expect(composer.state.text).toBe('the task that waited');
            composer.render(newDraft);
            expect(composer.state.text).toBe('the next task');
        } finally {
            composer.teardown();
        }
    });

    test('a reply to a chat the user left joins the text left in that chat', () => {
        const composer = renderComposer(otherSession);
        try {
            composer.type('half-written follow-up');
            composer.render(newDraft);
            composer.type('working elsewhere');

            composer.restore(otherSession, 'the reply that waited');
            expect(composer.state.text).toBe('working elsewhere');

            composer.render(otherSession);
            expect(composer.state.text).toBe('half-written follow-up\n\nthe reply that waited');
        } finally {
            composer.teardown();
        }
    });
});

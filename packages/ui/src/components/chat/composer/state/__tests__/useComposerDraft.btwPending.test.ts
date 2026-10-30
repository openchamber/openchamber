import { beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { clearChatDraft, readChatDraft, writeChatDraft, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { useInputStore } from '@/sync/input-store';
import { useComposerDraft, type ComposerDraftControls } from '../useComposerDraft';

const parent: ChatDraftIdentity = { runtimeKey: 'runtime-a', directory: '/repo', sessionId: 'parent' };
const pending: ChatDraftIdentity = { ...parent, sessionId: 'btw-pending:parent' };
const fork: ChatDraftIdentity = { ...parent, sessionId: 'fork-1' };

function renderComposer(initialText: string) {
    const dom = installHookTestDom();
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancelRaf = globalThis.cancelAnimationFrame;
    // Restoring a draft asks for a frame; the text is what this file asserts.
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => undefined;
    const root = createRoot(dom.container);
    const mentionsRef: React.RefObject<Set<string>> = { current: new Set() };
    let controlsForTest: ComposerDraftControls | undefined;
    const result = { text: initialText, mentionsRef, controls: () => controlsForTest };

    function Probe({ identity }: { identity: ChatDraftIdentity }) {
        const [message, setMessage] = React.useState(initialText);
        const messageRef = React.useRef(message);
        React.useEffect(() => { messageRef.current = message; }, [message]);
        const controls = useComposerDraft({
            message, messageRef, setMessage, confirmedMentionsRef: mentionsRef, identity,
            initialDraft: { text: '', identity },
        });
        result.text = message;
        controlsForTest = controls;
        return null;
    }

    const render = (identity: ChatDraftIdentity) => {
        act(() => { root.render(React.createElement(Probe, { identity })); });
    };
    render(pending);
    return {
        result,
        render,
        teardown: () => {
            act(() => { root.unmount(); });
            globalThis.requestAnimationFrame = originalRaf;
            globalThis.cancelAnimationFrame = originalCancelRaf;
            dom.restore();
        },
    };
}

beforeEach(() => {
    getDeferredSafeStorage().removeItem('openchamber.chatDrafts.v2');
    useInputStore.setState({ pendingComposerRestore: null, attachmentDraftKey: null, attachmentDrafts: new Map() });
    useInputStore.getState().clearAttachedFiles();
});

describe('/btw fork still being created', () => {
    test('discard clears pending memory so a repeated /btw starts empty', () => {
        const composer = renderComposer('discard me');
        try {
            composer.render(parent);
            act(() => { clearChatDraft(pending, true); });
            composer.render(pending);
            expect(composer.result.text).toBe('');
            expect(readChatDraft(pending).text).toBe('');
        } finally {
            composer.teardown();
        }
    });

    for (const destination of [parent, { ...parent, sessionId: 'another-chat' }]) {
        test(`keeps text across a switch to ${destination.sessionId} before migration to the fork`, () => {
            const composer = renderComposer('typed while creating');
            try {
                composer.render(destination);
                act(() => { composer.result.controls()?.migrateDraft(pending, fork); });
                composer.render(fork);
                expect(composer.result.text).toBe('typed while creating');
                expect(readChatDraft(fork).text).toBe('typed while creating');
                expect(readChatDraft(pending).text).toBe('');
                composer.render(pending);
                expect(composer.result.text).toBe('');
            } finally {
                composer.teardown();
            }
        });
    }

    test('failure recovery stays in memory and survives collapse', () => {
        const composer = renderComposer('next text');
        try {
            act(() => { composer.result.controls()?.restoreDraft(pending, 'failed question', new Set()); });
            expect(composer.result.text).toBe('next text\n\nfailed question');
            expect(readChatDraft(pending).text).toBe('');
            composer.render(parent);
            composer.render(pending);
            expect(composer.result.text).toBe('next text\n\nfailed question');
        } finally {
            composer.teardown();
        }
    });

    test('restores a failed question to its pending owner after navigation', () => {
        const composer = renderComposer('next text');
        try {
            composer.render(parent);
            act(() => { composer.result.controls()?.restoreDraft(pending, 'failed question', new Set()); });
            expect(composer.result.text).toBe('');
            expect(readChatDraft(pending).text).toBe('');
            composer.render(pending);
            expect(composer.result.text).toBe('next text\n\nfailed question');
        } finally {
            composer.teardown();
        }
    });

    test('a By the way handoff and recovery never persist the pending key', () => {
        const composer = renderComposer('replace me');
        try {
            act(() => { composer.result.controls()?.handoffDraft(pending, 'new question'); });
            expect(composer.result.text).toBe('new question');
            act(() => { composer.result.controls()?.persistNow(pending, ''); });
            act(() => { composer.result.controls()?.restoreDraft(pending, 'new question', new Set()); });
            expect(readChatDraft(pending).text).toBe('');
            composer.render(parent);
            composer.render(pending);
            expect(composer.result.text).toBe('new question');
        } finally {
            composer.teardown();
        }
    });

    test('keeps nothing under its placeholder identity', () => {
        const composer = renderComposer('first question');
        try {
            // Typing under the placeholder persists nothing, even on a flush.
            composer.result.controls()?.persistNow(pending, 'first question');
            expect(readChatDraft(pending).text).toBe('');
        } finally {
            composer.teardown();
        }
    });

    test('carries the draft to the fork instead of leaving a copy behind', () => {
        const composer = renderComposer('first question');
        try {
            // The fork exists now: the flow moves the draft, then the composer
            // switches identity, which saves the outgoing draft as usual.
            act(() => { composer.result.controls()?.migrateDraft(pending, fork); });
            composer.render(fork);

            expect(composer.result.text).toBe('first question');
            expect(readChatDraft(fork).text).toBe('first question');
            expect(readChatDraft(pending).text).toBe('');
        } finally {
            composer.teardown();
        }
    });

    test('ignores a placeholder draft an older build left in storage', () => {
        writeChatDraft(pending, 'text from the previous /btw', []);
        const composer = renderComposer('');
        try {
            composer.render(pending);
            expect(composer.result.text).toBe('');
        } finally {
            composer.teardown();
        }
    });
});

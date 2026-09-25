import { beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { readChatDraft, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { useInputStore } from '@/sync/input-store';
import { useComposerDraft } from '../useComposerDraft';
import { useDictationOrigin, type DictationOriginControls } from '../useDictationOrigin';

const started: ChatDraftIdentity = { runtimeKey: 'runtime-a', directory: '/repo', sessionId: 'started' };
const switchedTo: ChatDraftIdentity = { ...started, sessionId: 'switched-to' };

function renderComposer(persistEnabled: boolean, initialText = '') {
    const dom = installHookTestDom();
    // Restoring a non-empty draft schedules a selection frame; nothing here depends on it.
    const originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 0;
    const root = createRoot(dom.container);
    const result = { text: '', keptNotices: 0, dictation: null as DictationOriginControls | null };

    function Probe({ identity }: { identity: ChatDraftIdentity }) {
        const [message, setMessage] = React.useState(initialText);
        const messageRef = React.useRef(message);
        const confirmedMentionsRef = React.useRef(new Set<string>());
        const identityRef = React.useRef<ChatDraftIdentity | null>(identity);
        React.useEffect(() => { messageRef.current = message; }, [message]);
        React.useEffect(() => { identityRef.current = identity; }, [identity]);
        const { restoreDraft } = useComposerDraft({
            message, messageRef, setMessage, confirmedMentionsRef, identity, persistEnabled,
            initialDraft: { text: initialText, identity: started },
        });
        result.dictation = useDictationOrigin({
            identityRef,
            restoreDraft,
            onKeptForOrigin: () => { result.keptNotices += 1; },
        });
        result.text = message;
        return null;
    }

    const render = (identity: ChatDraftIdentity) => {
        act(() => { root.render(React.createElement(Probe, { identity })); });
    };
    render(started);
    return {
        result,
        render,
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

describe('dictation origin', () => {
    test('a transcript for the rendered draft is left to the composer', () => {
        const composer = renderComposer(true);
        try {
            composer.result.dictation?.markDictationStart();
            let kept = true;
            act(() => { kept = composer.result.dictation?.keepTranscriptForOrigin('hello') ?? true; });

            expect(kept).toBe(false);
            expect(composer.result.keptNotices).toBe(0);
            expect(readChatDraft(started).text).toBe('');
        } finally {
            composer.teardown();
        }
    });

    for (const persistEnabled of [true, false]) {
        test(`a session switch keeps the transcript out of the visible composer, persistence=${persistEnabled}`, () => {
            const composer = renderComposer(persistEnabled);
            try {
                composer.result.dictation?.markDictationStart();
                composer.render(switchedTo);

                let kept = false;
                act(() => { kept = composer.result.dictation?.keepTranscriptForOrigin('  dictated text ') ?? false; });

                expect(kept).toBe(true);
                expect(composer.result.keptNotices).toBe(1);
                expect(composer.result.text).toBe('');
                expect(readChatDraft(switchedTo).text).toBe('');
                expect(readChatDraft(started).text).toBe(persistEnabled ? 'dictated text' : '');

                // Returning to the session that started the dictation shows it.
                composer.render(started);
                expect(composer.result.text).toBe('dictated text');
            } finally {
                composer.teardown();
            }
        });
    }

    test('the transcript is appended to text already drafted in the originating session', () => {
        const composer = renderComposer(true, 'typed before dictating');
        try {
            composer.result.dictation?.markDictationStart();
            composer.render(switchedTo);

            act(() => { composer.result.dictation?.keepTranscriptForOrigin('dictated text'); });

            expect(readChatDraft(started).text).toBe('typed before dictating\n\ndictated text');
        } finally {
            composer.teardown();
        }
    });

    test('an origin is used once, so a later transcript follows the rendered draft', () => {
        const composer = renderComposer(true);
        try {
            composer.result.dictation?.markDictationStart();
            composer.render(switchedTo);
            act(() => { composer.result.dictation?.keepTranscriptForOrigin('first'); });

            composer.result.dictation?.markDictationStart();
            let kept = true;
            act(() => { kept = composer.result.dictation?.keepTranscriptForOrigin('second') ?? true; });

            expect(kept).toBe(false);
            expect(readChatDraft(started).text).toBe('first');
        } finally {
            composer.teardown();
        }
    });
});

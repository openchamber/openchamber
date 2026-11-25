import { beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { readChatDraft, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { useInputStore } from '@/sync/input-store';
import { useComposerDraft } from '../useComposerDraft';
import { createComposerText } from '../composerText';
import { followMovedNewSessionDraft, useDictationOrigin, type DictationOrigin, type DictationOriginControls } from '../useDictationOrigin';

const started: ChatDraftIdentity = { runtimeKey: 'runtime-a', directory: '/repo', sessionId: 'started' };
const switchedTo: ChatDraftIdentity = { ...started, sessionId: 'switched-to' };


/** The composer's text the way ChatInput holds it: outside state, with a render per write. */
function useProbeText(initial: string) {
    const [text] = React.useState(() => createComposerText(initial));
    const [, setRevision] = React.useState(0);
    const setMessage = React.useCallback((next: string) => {
        text.set(next);
        setRevision((revision) => revision + 1);
    }, [text]);
    return { text, setMessage };
}

function renderComposer(initialText = '') {
    const dom = installHookTestDom();
    // Restoring a non-empty draft schedules a selection frame; nothing here depends on it.
    const originalRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = () => 0;
    const root = createRoot(dom.container);
    const result = { text: '', keptNotices: 0, dictation: null as DictationOriginControls | null };

    function Probe({ identity, newSessionDraftId }: { identity: ChatDraftIdentity; newSessionDraftId: number | null }) {
        const { text, setMessage } = useProbeText(initialText);
        const confirmedMentionsRef = React.useRef(new Set<string>());
        const originRef = React.useRef<DictationOrigin | null>(null);
        const { restoreDraft } = useComposerDraft({
            text, setMessage, confirmedMentionsRef, identity,
            initialDraft: { text: initialText, identity: started },
            newSessionDraftId,
            onNewSessionDraftMoved: (moved) => followMovedNewSessionDraft(originRef, moved),
        });
        result.dictation = useDictationOrigin({
            originRef,
            newSessionDraftId,
            identity,
            restoreDraft,
            onKeptForOrigin: () => { result.keptNotices += 1; },
        });
        result.text = text.get();
        return null;
    }

    const render = (identity: ChatDraftIdentity, newSessionDraftId: number | null = null) => {
        act(() => { root.render(React.createElement(Probe, { identity, newSessionDraftId })); });
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
        const composer = renderComposer();
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

    test('a project switch of the same new-session draft leaves the transcript to the composer', () => {
        const composer = renderComposer();
        const inProject: ChatDraftIdentity = { runtimeKey: 'runtime-a', directory: '/repo/a', sessionId: 'draft:work-7' };
        const movedProject: ChatDraftIdentity = { ...inProject, directory: '/repo/b' };
        const movedToChat: ChatDraftIdentity = { runtimeKey: 'runtime-a', directory: 'openchamber:chats', sessionId: null };
        try {
            for (const moved of [movedProject, movedToChat]) {
                composer.render(inProject, 7);
                composer.result.dictation?.markDictationStart();
                composer.render(moved, 7);

                let kept = true;
                act(() => { kept = composer.result.dictation?.keepTranscriptForOrigin('dictated text') ?? true; });

                expect(kept).toBe(false);
                expect(readChatDraft(inProject).text).toBe('');
            }
            expect(composer.result.keptNotices).toBe(0);
        } finally {
            composer.teardown();
        }
    });

    test('a moved draft keeps the transcript at its destination after another session opens', () => {
        const composer = renderComposer();
        const inA: ChatDraftIdentity = { runtimeKey: 'runtime-a', directory: '/repo/a', sessionId: 'draft:work-7' };
        const inB: ChatDraftIdentity = { ...inA, directory: '/repo/b' };
        try {
            composer.render(inA, 7);
            composer.result.dictation?.markDictationStart();
            composer.render(inB, 7);
            composer.render(switchedTo);

            let kept = false;
            act(() => { kept = composer.result.dictation?.keepTranscriptForOrigin('dictated text') ?? false; });

            expect(kept).toBe(true);
            expect(composer.result.keptNotices).toBe(1);
            expect(composer.result.text).toBe('');
            expect(readChatDraft(inA).text).toBe('');
            expect(readChatDraft(inB).text).toBe('dictated text');
            expect(readChatDraft(switchedTo).text).toBe('');
        } finally {
            composer.teardown();
        }
    });

    test('a draft with the same id in another runtime is another composer', () => {
        const composer = renderComposer();
        const inA: ChatDraftIdentity = { runtimeKey: 'runtime-a', directory: '/repo/a', sessionId: 'draft:work-7' };
        try {
            composer.render(inA, 7);
            composer.result.dictation?.markDictationStart();
            composer.render({ ...inA, runtimeKey: 'runtime-b' }, 7);

            let kept = false;
            act(() => { kept = composer.result.dictation?.keepTranscriptForOrigin('dictated text') ?? false; });

            expect(kept).toBe(true);
            expect(readChatDraft(inA).text).toBe('dictated text');
        } finally {
            composer.teardown();
        }
    });

    test('a new chat draft that shares the origin draft slot leaves the transcript to the composer', () => {
        const composer = renderComposer();
        const chatDraft: ChatDraftIdentity = { runtimeKey: 'runtime-a', directory: 'openchamber:chats', sessionId: null };
        try {
            composer.render(chatDraft, 7);
            composer.result.dictation?.markDictationStart();
            composer.render(chatDraft, 8);

            let kept = true;
            act(() => { kept = composer.result.dictation?.keepTranscriptForOrigin('dictated text') ?? true; });

            expect(kept).toBe(false);
            expect(composer.result.keptNotices).toBe(0);
        } finally {
            composer.teardown();
        }
    });

    {
        test('a session switch keeps the transcript out of the visible composer', () => {
            const composer = renderComposer();
            try {
                composer.result.dictation?.markDictationStart();
                composer.render(switchedTo);

                let kept = false;
                act(() => { kept = composer.result.dictation?.keepTranscriptForOrigin('  dictated text ') ?? false; });

                expect(kept).toBe(true);
                expect(composer.result.keptNotices).toBe(1);
                expect(composer.result.text).toBe('');
                expect(readChatDraft(switchedTo).text).toBe('');
                expect(readChatDraft(started).text).toBe('dictated text');

                // Returning to the session that started the dictation shows it.
                composer.render(started);
                expect(composer.result.text).toBe('dictated text');
            } finally {
                composer.teardown();
            }
        });
    }

    test('the transcript is appended to text already drafted in the originating session', () => {
        const composer = renderComposer('typed before dictating');
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
        const composer = renderComposer();
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

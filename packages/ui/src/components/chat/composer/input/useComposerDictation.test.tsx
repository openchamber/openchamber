import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { readChatDraft, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { createComposerText } from '../state/composerText';
import { useComposerDraft } from '../state/useComposerDraft';
import { followMovedNewSessionDraft, type DictationOrigin } from '../state/useDictationOrigin';
import { useComposerDictation } from './useComposerDictation';

const inA: ChatDraftIdentity = { runtimeKey: 'runtime-a', directory: '/repo/a', sessionId: 'draft:work-7' };
const inB: ChatDraftIdentity = { ...inA, directory: '/repo/b' };
const newSessionDraft = { ...useSessionUIStore.getState().newSessionDraft, draftId: 7, open: true };

const composerText = createComposerText('');
const sent: Array<string | undefined> = [];
let released = 0;
let dictation: ReturnType<typeof useComposerDictation>;
let dom: ReturnType<typeof installHookTestDom>;
let root: Root;

const setMessage = (text: string) => { composerText.set(text); };
const handleSubmitRef = { current: async (options?: { presetText?: string }) => { sent.push(options?.presetText); } };
const composerRef = { current: null };
const dictationOriginRef = React.createRef<DictationOrigin>();
const dictationState = {
    dictationOriginRef,
    dictationSendInFlightRef: { current: false },
    dictationSendEndRef: { current: () => { released += 1; } },
};

function Probe({ identity }: { identity: ChatDraftIdentity }) {
    const confirmedMentionsRef = React.useRef(new Set<string>());
    const { restoreDraft } = useComposerDraft({
        text: composerText, setMessage, confirmedMentionsRef, identity,
        initialDraft: { text: '', identity: inA },
        newSessionDraftId: newSessionDraft.draftId,
        onNewSessionDraftMoved: (moved) => followMovedNewSessionDraft(dictationOriginRef, moved),
    });
    dictation = useComposerDictation({
        draftText: { composerText, setMessage },
        i18n: { t: (key) => key },
        dictationState,
        editorState: { composerRef },
        draftHistory: { restoreDraft },
        sendHandlers: { handleSubmitRef },
        sessionScope: {
            chatDraftIdentity: identity, currentSessionId: null, isBtwActive: false,
            newSessionDraft, newSessionDraftOpen: true,
        },
    });
    return null;
}

const render = (identity: ChatDraftIdentity) => act(() => { root.render(<Probe identity={identity} />); });

beforeEach(() => {
    getDeferredSafeStorage().removeItem('openchamber.chatDrafts.v2');
    dom = installHookTestDom();
    root = createRoot(dom.container);
    composerText.set('');
    sent.length = 0;
    released = 0;
    render(inA);
    composerText.set('typed');
});

afterEach(() => {
    act(() => { root.unmount(); });
    dom.restore();
});

describe('insert and send for a moved new-session draft', () => {
    test('a move after confirming keeps the transcript in the draft without sending', () => {
        dictation.markDictationStart();
        dictation.markDictationSendConfirmed();
        render(inB);
        act(() => { dictation.handleDictationInsertAndSend('dictated'); });

        expect(sent).toEqual([]);
        expect(composerText.get()).toBe('typed dictated ');
        expect(released).toBe(1);
        act(() => { root.render(null); });
        expect(readChatDraft(inB).text).toBe('typed dictated ');
        expect(readChatDraft(inA).text).toBe('');
    });

    test('a move away and back after confirming still keeps the transcript unsent', () => {
        dictation.markDictationStart();
        dictation.markDictationSendConfirmed();
        render(inB);
        render(inA);
        act(() => { dictation.handleDictationInsertAndSend('dictated'); });

        expect(sent).toEqual([]);
        expect(composerText.get()).toBe('typed dictated ');
        expect(released).toBe(1);
    });

    test('a move before confirming sends to the new project', async () => {
        dictation.markDictationStart();
        render(inB);
        dictation.markDictationSendConfirmed();
        await act(async () => { dictation.handleDictationInsertAndSend('dictated'); });

        expect(sent).toEqual(['typed dictated ']);
        expect(released).toBe(1);
    });

    test('an earlier confirmation does not hold a later dictation', async () => {
        dictation.markDictationStart();
        dictation.markDictationSendConfirmed();
        render(inB);
        act(() => { dictation.handleDictationInsertAndSend('first'); });
        dictation.markDictationStart();
        dictation.markDictationSendConfirmed();
        await act(async () => { dictation.handleDictationInsertAndSend('second'); });

        expect(sent).toEqual(['typed first second ']);
    });
});

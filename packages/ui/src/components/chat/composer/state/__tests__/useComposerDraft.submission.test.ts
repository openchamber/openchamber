import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { useComposerDraft } from '../useComposerDraft';

const identity = (sessionId: string | null, directory = '/repo'): ChatDraftIdentity => ({
    runtimeKey: 'runtime',
    directory,
    sessionId,
});

function mountTransferredDraft() {
    const windowInstance = new Window();
    Object.assign(globalThis, {
        window: windowInstance,
        document: windowInstance.document,
        IS_REACT_ACT_ENVIRONMENT: true,
        requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root: Root = createRoot(host);
    const draftIdentity = identity(null);
    const sessionIdentity = identity('session-1', '/managed/repo');
    const messageRef = { current: 'important prompt' };
    const mentionsRef = { current: new Set<string>() };
    let message = messageRef.current;
    let clearSubmittedDraft: (
        submittedIdentity: ChatDraftIdentity | null,
        submittedText: string,
        submittedMentions: ReadonlySet<string>,
    ) => boolean = () => false;
    let restoreFailedDraft: typeof clearSubmittedDraft = () => false;

    function Probe(props: { currentIdentity: ChatDraftIdentity; materializedSessionId: string | null }) {
        ({ clearSubmittedDraft, restoreFailedDraft } = useComposerDraft({
            message,
            messageRef,
            setMessage: (next) => { message = next; },
            confirmedMentionsRef: mentionsRef,
            identity: props.currentIdentity,
            persistEnabled: true,
            initialDraft: { text: message, identity: draftIdentity },
            submittedDraftSessionId: props.materializedSessionId,
        }));
        return null;
    }

    act(() => root.render(React.createElement(Probe, {
        currentIdentity: draftIdentity,
        materializedSessionId: null,
    })));
    act(() => root.render(React.createElement(Probe, {
        currentIdentity: sessionIdentity,
        materializedSessionId: 'session-1',
    })));
    act(() => root.render(React.createElement(Probe, {
        currentIdentity: sessionIdentity,
        materializedSessionId: null,
    })));

    return {
        acknowledge: () => clearSubmittedDraft(draftIdentity, 'important prompt', new Set()),
        fail: () => restoreFailedDraft(draftIdentity, 'important prompt', new Set()),
        getMessage: () => message,
        getMentions: () => mentionsRef.current,
        replaceDraft: (text: string, mentions: Set<string>) => {
            message = text;
            messageRef.current = text;
            mentionsRef.current = mentions;
        },
        dispose: () => {
            act(() => root.unmount());
            windowInstance.close();
        },
    };
}

describe('submitted composer drafts', () => {
    test('preserves a store-rewritten draft when acknowledgement arrives', () => {
        const draft = mountTransferredDraft();
        draft.replaceDraft('restored prompt', new Set(['restored-file']));

        expect(draft.acknowledge()).toBe(false);
        expect(draft.getMessage()).toBe('restored prompt');
        expect(draft.getMentions()).toEqual(new Set(['restored-file']));

        draft.dispose();
    });

    test('clears an unchanged transferred draft after acknowledgement', () => {
        const draft = mountTransferredDraft();

        expect(draft.acknowledge()).toBe(true);
        expect(draft.getMessage()).toBe('');

        draft.dispose();
    });

    test('merges a failed prompt into a store-rewritten draft without overwriting it', () => {
        const draft = mountTransferredDraft();
        draft.replaceDraft('restored prompt', new Set(['restored-file']));

        expect(draft.fail()).toBe(true);
        expect(draft.getMessage()).toBe('restored prompt\n\nimportant prompt\n\n');
        expect(draft.getMentions()).toEqual(new Set(['restored-file']));

        draft.dispose();
    });

    test('does not duplicate a failed prompt that the current draft still contains', () => {
        const draft = mountTransferredDraft();
        draft.replaceDraft('important prompt\n\nnew context', new Set());

        expect(draft.fail()).toBe(false);
        expect(draft.getMessage()).toBe('important prompt\n\nnew context');

        draft.dispose();
    });

    test('does not resurrect an acknowledged draft when an existing session switch commits', () => {
        const windowInstance = new Window();
        Object.assign(globalThis, {
            window: windowInstance,
            document: windowInstance.document,
            IS_REACT_ACT_ENVIRONMENT: true,
            requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
        });
        const root = createRoot(document.body.appendChild(document.createElement('div')));
        const sourceIdentity = identity('session-1');
        const destinationIdentity = identity('session-2');
        const messageRef = { current: 'important prompt' };
        const mentionsRef = { current: new Set<string>() };
        let message = messageRef.current;
        let acknowledgementResult: boolean | null = null;

        function Probe(props: { currentIdentity: ChatDraftIdentity; acknowledge?: boolean }) {
            const controls = useComposerDraft({
                message,
                messageRef,
                setMessage: (next) => { message = next; },
                confirmedMentionsRef: mentionsRef,
                identity: props.currentIdentity,
                persistEnabled: true,
                initialDraft: { text: message, identity: sourceIdentity },
            });
            React.useLayoutEffect(() => {
                if (props.acknowledge) {
                    acknowledgementResult = controls.clearSubmittedDraft(sourceIdentity, 'important prompt', new Set());
                }
            }, [controls, props.acknowledge]);
            return null;
        }

        act(() => root.render(React.createElement(Probe, { currentIdentity: sourceIdentity })));
        act(() => root.render(React.createElement(Probe, {
            currentIdentity: destinationIdentity,
            acknowledge: true,
        })));

        expect(acknowledgementResult).toBe(true);
        expect(message).toBe('');
        expect(messageRef.current).toBe('');

        act(() => root.unmount());
        windowInstance.close();
    });
});

afterEach(() => {
    globalThis.document?.body.replaceChildren();
});

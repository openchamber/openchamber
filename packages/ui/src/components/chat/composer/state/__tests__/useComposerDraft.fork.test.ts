import { beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { readChatDraft, writeChatDraft, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { useInputStore } from '@/sync/input-store';
import { useComposerDraft } from '../useComposerDraft';

const source: ChatDraftIdentity = { runtimeKey: 'runtime-a', directory: '/repo', sessionId: 'source' };
const fork: ChatDraftIdentity = { ...source, sessionId: 'fork' };
const replayFile = { url: 'data:text/plain;base64,aGVsbG8=', mimeType: 'text/plain', filename: 'replay.txt' };

function renderComposer(persistEnabled: boolean) {
    const dom = installHookTestDom();
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancelRaf = globalThis.cancelAnimationFrame;
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    globalThis.requestAnimationFrame = (callback) => {
        frames.set(++frameId, callback);
        return frameId;
    };
    globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
    const root = createRoot(dom.container);
    const restored: string[] = [];
    const result = { text: '', mentions: new Set<string>(), restored };

    function Probe({ identity }: { identity: ChatDraftIdentity }) {
        const [message, setMessage] = React.useState('source draft @source.ts');
        const messageRef = React.useRef(message);
        const confirmedMentionsRef = React.useRef(new Set(['source.ts']));
        React.useEffect(() => { messageRef.current = message; }, [message]);
        useComposerDraft({
            message, messageRef, setMessage, confirmedMentionsRef, identity, persistEnabled,
            initialDraft: { text: '', identity: source },
            onDraftRestored: (reason) => { result.restored.push(reason); },
        });
        result.text = message;
        result.mentions = confirmedMentionsRef.current;
        return null;
    }

    const render = (identity: ChatDraftIdentity) => {
        act(() => { root.render(React.createElement(Probe, { identity })); });
    };
    render(source);
    return {
        result,
        render,
        flushFrames: () => {
            const pending = [...frames.values()];
            frames.clear();
            act(() => { for (const callback of pending) callback(0); });
        },
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
    useInputStore.setState({ pendingComposerRestore: null });
    useInputStore.getState().clearAttachedFiles();
});

describe('fork composer restoration', () => {
    for (const persistEnabled of [true, false]) {
        test(`waits for the rendered fork and preserves the source, persistence=${persistEnabled}`, () => {
            writeChatDraft(fork, 'previous fork draft @old.ts', ['old.ts']);
            useInputStore.getState().addRestoredAttachment({ ...replayFile, filename: 'source.txt' });
            const sourceFiles = useInputStore.getState().attachedFiles;
            const composer = renderComposer(persistEnabled);
            try {
                // Selection already changed, but the deferred chat column still renders source.
                act(() => {
                    useInputStore.setState({ pendingComposerRestore: { target: fork, text: 'replay prompt', files: [replayFile] } });
                });
                expect(composer.result.text).toBe('source draft @source.ts');
                expect(useInputStore.getState().attachedFiles).toBe(sourceFiles);
                expect(useInputStore.getState().pendingComposerRestore).not.toBeNull();

                composer.render(fork);
                expect(composer.result.text).toBe('replay prompt');
                expect(composer.result.mentions.size).toBe(0);
                expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(['replay.txt']);
                expect(useInputStore.getState().pendingComposerRestore).toBeNull();
                composer.flushFrames();
                expect(composer.result.restored).toContain('fork');
                expect(readChatDraft(source).text).toBe(persistEnabled ? 'source draft @source.ts' : '');

                composer.render(source);
                expect(composer.result.text).toBe('source draft @source.ts');
                expect(readChatDraft(fork).text).toBe(persistEnabled ? 'replay prompt' : '');
            } finally {
                composer.teardown();
            }
        });
    }

    test('waits through unrelated session, directory, and runtime renders', () => {
        const composer = renderComposer(true);
        try {
            act(() => {
                useInputStore.setState({ pendingComposerRestore: { target: fork, text: 'replay', files: [] } });
            });
            for (const identity of [
                { ...fork, sessionId: 'other' },
                { ...fork, directory: '/other' },
                { ...fork, runtimeKey: 'runtime-b' },
            ]) {
                composer.render(identity);
                expect(composer.result.text).toBe('');
                expect(useInputStore.getState().pendingComposerRestore).not.toBeNull();
            }
            composer.render(fork);
            expect(composer.result.text).toBe('replay');
            expect(useInputStore.getState().pendingComposerRestore).toBeNull();
        } finally {
            composer.teardown();
        }
    });

    test('persists a replay even when its text equals the outgoing source draft', async () => {
        const composer = renderComposer(true);
        try {
            const text = composer.result.text;
            act(() => {
                useInputStore.setState({ pendingComposerRestore: { target: fork, text, files: [] } });
            });
            composer.render(fork);
            await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
            expect(readChatDraft(fork)).toEqual({ text, confirmedMentions: new Set() });
            expect(readChatDraft(source)).toEqual({ text, confirmedMentions: new Set(['source.ts']) });
        } finally {
            composer.teardown();
        }
    });

    test('restores file-only and empty prompts without keeping destination text or files', () => {
        const composer = renderComposer(true);
        try {
            writeChatDraft(fork, 'stale destination text', []);
            act(() => {
                useInputStore.setState({ pendingComposerRestore: { target: fork, text: '', files: [replayFile] } });
            });
            composer.render(fork);
            expect(composer.result.text).toBe('');
            expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(['replay.txt']);
            act(() => {
                useInputStore.setState({ pendingComposerRestore: { target: fork, text: '', files: [] } });
            });
            expect(composer.result.text).toBe('');
            expect(useInputStore.getState().attachedFiles).toEqual([]);
        } finally {
            composer.teardown();
        }
    });
});

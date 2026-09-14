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

function renderComposer(persistEnabled: boolean, submittedDraftSessionId: string | null = null) {
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
    const result = {
        text: '',
        mentions: new Set<string>(),
        restored,
        // SAFETY: Probe assigns both fields before renderComposer returns.
        controls: null as ReturnType<typeof useComposerDraft> | null,
        // SAFETY: Probe assigns both fields before renderComposer returns.
        setMessage: null as ((text: string) => void) | null,
    };

    function Probe({ identity }: { identity: ChatDraftIdentity }) {
        const [message, setMessage] = React.useState('source draft @source.ts');
        const messageRef = React.useRef(message);
        const confirmedMentionsRef = React.useRef(new Set(['source.ts']));
        React.useEffect(() => { messageRef.current = message; }, [message]);
        result.controls = useComposerDraft({
            message, messageRef, setMessage, confirmedMentionsRef, identity, persistEnabled,
            initialDraft: { text: '', identity: source },
            submittedDraftSessionId,
            onDraftRestored: (reason) => { result.restored.push(reason); },
        });
        result.text = message;
        result.mentions = confirmedMentionsRef.current;
        result.setMessage = setMessage;
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

describe('submitted draft acknowledgement', () => {
    test('clears only the submitted snapshot after a new-session draft materializes', () => {
        const draft: ChatDraftIdentity = { runtimeKey: 'runtime-a', directory: '/repo', sessionId: null };
        const materialized: ChatDraftIdentity = { ...draft, sessionId: 'created-session' };
        const composer = renderComposer(true, 'created-session');
        try {
            composer.render(draft);
            act(() => composer.result.setMessage?.('source draft @source.ts'));
            composer.render(materialized);
            const controls = composer.result.controls;
            expect(controls).not.toBeNull();

            let cleared = false;
            act(() => {
                cleared = controls!.clearSubmittedDraft(draft, 'source draft @source.ts', new Set());
            });

            expect(cleared).toBe(true);
            expect(composer.result.text).toBe('');
            expect(readChatDraft(materialized)).toEqual({ text: '', confirmedMentions: new Set() });
            expect(readChatDraft(draft)).toEqual({ text: '', confirmedMentions: new Set() });
        } finally {
            composer.teardown();
        }
    });

    test('does not clear text typed after a submitted snapshot', () => {
        const composer = renderComposer(true);
        try {
            const controls = composer.result.controls;
            expect(controls).not.toBeNull();
            act(() => composer.result.setMessage?.('newer text'));
            const cleared = controls!.clearSubmittedDraft(source, 'source draft @source.ts', new Set(['source.ts']));

            expect(cleared).toBe(false);
            expect(composer.result.text).toBe('newer text');
        } finally {
            composer.teardown();
        }
    });

    test('clears an accepted draft from its materialized owner without waiting for transfer effects', () => {
        const draft: ChatDraftIdentity = { runtimeKey: 'runtime-a', directory: '/repo', sessionId: null };
        const materialized: ChatDraftIdentity = { ...draft, sessionId: 'created-session' };
        const composer = renderComposer(true, 'created-session');
        try {
            composer.render(draft);
            act(() => composer.result.setMessage?.('source draft @source.ts'));
            composer.render(materialized);
            const controls = composer.result.controls;

            let cleared = false;
            act(() => {
                cleared = controls!.clearSubmittedDraft(draft, 'source draft @source.ts', new Set(), materialized);
            });

            expect(cleared).toBe(true);
            expect(composer.result.text).toBe('');
            expect(readChatDraft(materialized).text).toBe('');
        } finally {
            composer.teardown();
        }
    });

    test('clears the exact accepted draft after the composer remounts', () => {
        const original = renderComposer(true);
        const oldControls = original.result.controls;
        original.teardown();

        const remounted = renderComposer(true);
        try {
            expect(remounted.result.text).toBe('source draft @source.ts');
            act(() => {
                oldControls!.clearSubmittedDraft(source, 'source draft @source.ts', new Set(['source.ts']));
            });
            expect(remounted.result.text).toBe('');
        } finally {
            remounted.teardown();
        }
    });

    test('preserves newer text when an accepted draft settles after remount', () => {
        const original = renderComposer(true);
        const oldControls = original.result.controls;
        original.teardown();

        const remounted = renderComposer(true);
        try {
            act(() => remounted.result.setMessage?.('newer text'));
            act(() => {
                oldControls!.clearSubmittedDraft(source, 'source draft @source.ts', new Set(['source.ts']));
            });
            expect(remounted.result.text).toBe('newer text');
            expect(readChatDraft(source).text).toBe('newer text');
        } finally {
            remounted.teardown();
        }
    });

    test('does not cancel another session draft write when an accepted draft settles', async () => {
        const composer = renderComposer(true);
        try {
            const controls = composer.result.controls;
            composer.render(fork);
            act(() => composer.result.setMessage?.('fork draft'));
            act(() => {
                controls!.clearSubmittedDraft(source, 'source draft @source.ts', new Set(['source.ts']));
            });

            await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
            expect(readChatDraft(fork).text).toBe('fork draft');
        } finally {
            composer.teardown();
        }
    });
});

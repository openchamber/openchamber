import { beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { getChatDraftIdentityKey, readChatDraft, writeChatDraft, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { useInputStore } from '@/sync/input-store';
import { useComposerDraft } from '../useComposerDraft';

const projectDraft: ChatDraftIdentity = { runtimeKey: 'runtime-a', directory: '/repo-a', sessionId: null };
const otherProjectDraft: ChatDraftIdentity = { ...projectDraft, directory: '/repo-b' };
const session: ChatDraftIdentity = { ...projectDraft, sessionId: 'session-1' };
const file = { url: 'data:text/plain;base64,aGVsbG8=', mimeType: 'text/plain', filename: 'notes.txt' };

function renderComposer(initialText: string) {
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
    const mentionsRef: React.RefObject<Set<string>> = { current: new Set() };
    const result = { text: '', mentionsRef, restored };

    function Probe({ identity, draftId }: { identity: ChatDraftIdentity; draftId: number | null }) {
        const [message, setMessage] = React.useState(initialText);
        const messageRef = React.useRef(message);
        const confirmedMentionsRef = React.useRef(new Set(initialText.includes('@a.ts') ? ['a.ts'] : []));
        React.useEffect(() => { messageRef.current = message; }, [message]);
        useComposerDraft({
            message, messageRef, setMessage, confirmedMentionsRef, identity,
            initialDraft: { text: '', identity: projectDraft },
            newSessionDraftId: draftId,
            onDraftRestored: (reason) => { result.restored.push(reason); },
        });
        result.text = message;
        result.mentionsRef = confirmedMentionsRef;
        return null;
    }

    const render = (identity: ChatDraftIdentity, draftId: number | null = 1) => {
        act(() => { root.render(React.createElement(Probe, { identity, draftId })); });
    };
    render(projectDraft);
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
    useInputStore.setState({ pendingComposerRestore: null, attachmentDraftKey: null, attachmentDrafts: new Map() });
    useInputStore.getState().clearAttachedFiles();
});

describe('new-session draft changing its directory', () => {
    test('takes the typed text and files along and leaves nothing behind', () => {
        useInputStore.getState().selectAttachmentDraft(projectDraft);
        useInputStore.getState().addRestoredAttachment(file);
        const composer = renderComposer('fix the login form @a.ts');
        try {
            composer.render(otherProjectDraft);
            composer.flushFrames();

            expect(composer.result.text).toBe('fix the login form @a.ts');
            // The mention named a file of the old directory.
            expect(composer.result.mentionsRef.current.size).toBe(0);
            // The text stays where the caret is, not selected as a restored draft.
            expect(composer.result.restored).toEqual([]);
            expect(readChatDraft(otherProjectDraft).text).toBe('fix the login form @a.ts');
            expect(readChatDraft(projectDraft).text).toBe('');

            const input = useInputStore.getState();
            expect(input.attachmentDraftKey).toBe(getChatDraftIdentityKey(otherProjectDraft));
            expect(input.attachedFiles.map((attached) => attached.filename)).toEqual(['notes.txt']);
            expect(input.attachmentDrafts.get(getChatDraftIdentityKey(projectDraft)) ?? []).toEqual([]);

            // Going back does not bring a second copy.
            composer.render(projectDraft);
            expect(composer.result.text).toBe('fix the login form @a.ts');
            expect(readChatDraft(otherProjectDraft).text).toBe('');
        } finally {
            composer.teardown();
        }
    });

    test('keeps a draft already saved for the new directory above the typed text', () => {
        writeChatDraft(otherProjectDraft, 'older draft', []);
        const composer = renderComposer('typed now');
        try {
            composer.render(otherProjectDraft);
            expect(composer.result.text).toBe('older draft\n\ntyped now');
            expect(readChatDraft(otherProjectDraft).text).toBe('older draft\n\ntyped now');
        } finally {
            composer.teardown();
        }
    });

    test('an empty draft still restores what the new directory had', () => {
        writeChatDraft(otherProjectDraft, 'older draft', []);
        const composer = renderComposer('');
        try {
            composer.render(otherProjectDraft);
            composer.flushFrames();
            expect(composer.result.text).toBe('older draft');
            expect(composer.result.restored).toEqual(['saved']);
        } finally {
            composer.teardown();
        }
    });

    test('switching to a session keeps the drafts apart', () => {
        writeChatDraft(session, 'session draft', []);
        const composer = renderComposer('new chat text');
        try {
            composer.render(session, null);
            expect(composer.result.text).toBe('session draft');
            expect(readChatDraft(projectDraft).text).toBe('new chat text');
        } finally {
            composer.teardown();
        }
    });

    test('a new chat opened in another directory leaves the typed text where it was', () => {
        useInputStore.getState().selectAttachmentDraft(projectDraft);
        useInputStore.getState().addRestoredAttachment(file);
        const composer = renderComposer('typed in project a');
        try {
            // Another feature opens a new draft (new id) for another directory.
            composer.render(otherProjectDraft, 2);
            expect(composer.result.text).toBe('');
            expect(readChatDraft(projectDraft).text).toBe('typed in project a');
            expect(useInputStore.getState().attachmentDrafts.get(getChatDraftIdentityKey(projectDraft))?.map((attached) => attached.filename)).toEqual(['notes.txt']);
        } finally {
            composer.teardown();
        }
    });

    test('attached files move even without text', () => {
        useInputStore.getState().selectAttachmentDraft(projectDraft);
        useInputStore.getState().addRestoredAttachment(file);
        const composer = renderComposer('');
        try {
            composer.render(otherProjectDraft);
            expect(useInputStore.getState().attachedFiles.map((attached) => attached.filename)).toEqual(['notes.txt']);
            expect(useInputStore.getState().attachmentDrafts.get(getChatDraftIdentityKey(projectDraft)) ?? []).toEqual([]);
        } finally {
            composer.teardown();
        }
    });
});

describe('session moved to another directory', () => {
    const movedSession: ChatDraftIdentity = { ...session, directory: '/repo-a-worktree' };

    test('takes the typed text and files along and leaves nothing behind', () => {
        writeChatDraft(session, 'typed before the move', []);
        const composer = renderComposer('');
        try {
            composer.render(session, null);
            useInputStore.getState().addRestoredAttachment(file);
            composer.flushFrames();
            composer.result.restored.length = 0;

            composer.render(movedSession, null);
            composer.flushFrames();

            expect(composer.result.text).toBe('typed before the move');
            expect(composer.result.restored).toEqual([]);
            expect(readChatDraft(movedSession).text).toBe('typed before the move');
            expect(readChatDraft(session).text).toBe('');
            const input = useInputStore.getState();
            expect(input.attachmentDraftKey).toBe(getChatDraftIdentityKey(movedSession));
            expect(input.attachedFiles.map((attached) => attached.filename)).toEqual(['notes.txt']);
            expect(input.attachmentDrafts.get(getChatDraftIdentityKey(session)) ?? []).toEqual([]);
        } finally {
            composer.teardown();
        }
    });

    test('another session keeps its own draft', () => {
        const otherSession: ChatDraftIdentity = { ...movedSession, sessionId: 'session-2' };
        writeChatDraft(session, 'session one', []);
        writeChatDraft(otherSession, 'session two', []);
        const composer = renderComposer('');
        try {
            composer.render(session, null);
            composer.render(otherSession, null);
            expect(composer.result.text).toBe('session two');
            expect(readChatDraft(session).text).toBe('session one');
        } finally {
            composer.teardown();
        }
    });
});

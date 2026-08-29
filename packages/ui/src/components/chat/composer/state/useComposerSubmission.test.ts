import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { useComposerSubmission } from './useComposerSubmission';

const identity = (sessionId: string | null): ChatDraftIdentity => ({
    runtimeKey: 'runtime',
    directory: '/repo',
    sessionId,
});

describe('useComposerSubmission', () => {
    let windowInstance: Window;
    let root: Root;
    let submission: ReturnType<typeof useComposerSubmission>;

    beforeEach(() => {
        windowInstance = new Window();
        Object.assign(globalThis, {
            window: windowInstance,
            document: windowInstance.document,
            IS_REACT_ACT_ENVIRONMENT: true,
        });
        root = createRoot(document.body.appendChild(document.createElement('div')));
    });

    afterEach(() => {
        act(() => root.unmount());
        windowInstance.close();
    });

    function Probe({
        currentIdentity,
        materializedSessionId,
    }: {
        currentIdentity: ChatDraftIdentity;
        materializedSessionId: string | null;
    }) {
        submission = useComposerSubmission(currentIdentity, materializedSessionId);
        return null;
    }

    const render = (currentIdentity: ChatDraftIdentity, materializedSessionId: string | null = null) => {
        act(() => root.render(React.createElement(Probe, { currentIdentity, materializedSessionId })));
    };

    test('keeps pending state with its session while another session submits', () => {
        render(identity('session-1'));
        let first: ReturnType<typeof submission.begin> = null;
        act(() => { first = submission.begin(); });
        expect(first).not.toBeNull();
        expect(submission.isPending).toBe(true);
        expect(submission.begin()).toBeNull();

        render(identity('session-2'));
        expect(submission.isPending).toBe(false);
        let second: ReturnType<typeof submission.begin> = null;
        act(() => { second = submission.begin(); });
        expect(second).not.toBeNull();

        act(() => first!.finish());
        expect(submission.isPending).toBe(true);
        act(() => second!.finish());
        expect(submission.isPending).toBe(false);
    });

    test('moves a new-session submission to its materialized session', () => {
        render(identity(null));
        let active: ReturnType<typeof submission.begin> = null;
        act(() => { active = submission.begin(); });

        render(identity('session-1'), 'session-1');
        expect(submission.isPending).toBe(true);
        render(identity('session-1'));
        expect(submission.isPending).toBe(true);
        act(() => active!.finish());
        expect(submission.isPending).toBe(false);
    });
});

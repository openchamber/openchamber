import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import type { ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { useComposerSubmission } from '../useComposerSubmission';

const sessionA: ChatDraftIdentity = { runtimeKey: 'runtime', directory: '/repo', sessionId: 'a' };
const sessionB: ChatDraftIdentity = { runtimeKey: 'runtime', directory: '/repo', sessionId: 'b' };
const runtimeA: ChatDraftIdentity = { runtimeKey: 'runtime-a', directory: '/repo', sessionId: 'session' };
const runtimeB: ChatDraftIdentity = { runtimeKey: 'runtime-b', directory: '/repo', sessionId: 'session' };

test('keeps session submission leases independent', () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    let current = sessionA;
    let controls: ReturnType<typeof useComposerSubmission> | null = null;

    function Probe() {
        controls = useComposerSubmission(current);
        return null;
    }

    try {
        act(() => { root.render(React.createElement(Probe)); });
        let a: ReturnType<ReturnType<typeof useComposerSubmission>['begin']> = null;
        act(() => { a = controls!.begin(); });
        expect(a).not.toBeNull();
        expect(controls!.isPending).toBe(true);

        current = sessionB;
        act(() => { root.render(React.createElement(Probe)); });
        expect(controls!.isPending).toBe(false);
        let b: ReturnType<ReturnType<typeof useComposerSubmission>['begin']> = null;
        act(() => { b = controls!.begin(); });
        expect(b).not.toBeNull();

        act(() => { a!.finish(); });
        expect(controls!.isPending).toBe(true);
        act(() => { b!.finish(); });
        expect(controls!.isPending).toBe(false);
    } finally {
        act(() => { root.unmount(); });
        dom.restore();
    }
});

test('transfers a submitted new-session lease to its materialized session', () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const draft: ChatDraftIdentity = { runtimeKey: 'runtime', directory: '/repo', sessionId: null };
    const materialized: ChatDraftIdentity = { ...draft, sessionId: 'created' };
    let current = draft;
    let controls: ReturnType<typeof useComposerSubmission> | null = null;

    function Probe() {
        controls = useComposerSubmission(current);
        return null;
    }

    try {
        act(() => { root.render(React.createElement(Probe)); });
        let submission: ReturnType<ReturnType<typeof useComposerSubmission>['begin']> = null;
        act(() => { submission = controls!.begin(); });
        expect(submission).not.toBeNull();

        act(() => { submission!.transfer(materialized); });
        current = materialized;
        act(() => { root.render(React.createElement(Probe)); });
        expect(controls!.isPending).toBe(true);
        let duplicate: ReturnType<ReturnType<typeof useComposerSubmission>['begin']> = null;
        act(() => { duplicate = controls!.begin(); });
        expect(duplicate).toBeNull();

        act(() => { submission!.finish(); });
        expect(controls!.isPending).toBe(false);
    } finally {
        act(() => { root.unmount(); });
        dom.restore();
    }
});

test('transfers a submitted new-session lease after directory canonicalization', () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const draft: ChatDraftIdentity = { runtimeKey: 'runtime', directory: '/requested', sessionId: null };
    const materialized: ChatDraftIdentity = { runtimeKey: 'runtime', directory: '/canonical', sessionId: 'created' };
    let current = draft;
    let controls: ReturnType<typeof useComposerSubmission> | null = null;

    function Probe() {
        controls = useComposerSubmission(current);
        return null;
    }

    try {
        act(() => { root.render(React.createElement(Probe)); });
        let submission: ReturnType<ReturnType<typeof useComposerSubmission>['begin']> = null;
        act(() => { submission = controls!.begin(); });

        act(() => { submission!.transfer(materialized); });
        current = materialized;
        act(() => { root.render(React.createElement(Probe)); });
        expect(controls!.isPending).toBe(true);

        act(() => { submission!.finish(); });
    } finally {
        act(() => { root.unmount(); });
        dom.restore();
    }
});

test('retains a submission lease across remounts and runtime A-to-B-to-A switching', () => {
    const dom = installHookTestDom();
    let root = createRoot(dom.container);
    let current = runtimeA;
    let controls: ReturnType<typeof useComposerSubmission> | null = null;

    function Probe() {
        controls = useComposerSubmission(current);
        return null;
    }

    try {
        act(() => { root.render(React.createElement(Probe)); });
        let submission: ReturnType<ReturnType<typeof useComposerSubmission>['begin']> = null;
        act(() => { submission = controls!.begin(); });
        expect(submission).not.toBeNull();

        act(() => { root.unmount(); });
        root = createRoot(dom.container);
        current = runtimeB;
        act(() => { root.render(React.createElement(Probe)); });
        expect(controls!.isPending).toBe(false);
        let otherSubmission: ReturnType<ReturnType<typeof useComposerSubmission>['begin']> = null;
        act(() => { otherSubmission = controls!.begin(); });
        expect(otherSubmission).not.toBeNull();

        current = runtimeA;
        act(() => { root.render(React.createElement(Probe)); });
        expect(controls!.isPending).toBe(true);
        expect(controls!.begin()).toBeNull();

        act(() => { submission!.finish(); });
        expect(controls!.isPending).toBe(false);

        current = runtimeB;
        act(() => { root.render(React.createElement(Probe)); });
        expect(controls!.isPending).toBe(true);
        act(() => { otherSubmission!.finish(); });
        expect(controls!.isPending).toBe(false);
    } finally {
        act(() => { root.unmount(); });
        dom.restore();
    }
});

test('keeps a completed submission pending through a browser paint', () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalRaf = globalThis.requestAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback) => {
        frames.push(callback);
        return frames.length;
    };
    let controls: ReturnType<typeof useComposerSubmission> | null = null;

    function Probe() {
        controls = useComposerSubmission(sessionA);
        return null;
    }

    try {
        act(() => { root.render(React.createElement(Probe)); });
        let submission: ReturnType<ReturnType<typeof useComposerSubmission>['begin']> = null;
        act(() => { submission = controls!.begin(); });
        act(() => { submission!.finishAfterPaint(); });
        expect(controls!.isPending).toBe(true);

        act(() => { frames.shift()?.(0); });
        expect(controls!.isPending).toBe(true);

        act(() => { frames.shift()?.(16); });
        expect(controls!.isPending).toBe(false);
    } finally {
        act(() => { root.unmount(); });
        globalThis.requestAnimationFrame = originalRaf;
        dom.restore();
    }
});

test('exposes the submitted text after remount', () => {
    const dom = installHookTestDom();
    let root = createRoot(dom.container);
    let controls: ReturnType<typeof useComposerSubmission> | null = null;

    function Probe() {
        controls = useComposerSubmission(sessionA);
        return null;
    }

    try {
        act(() => { root.render(React.createElement(Probe)); });
        let submission: ReturnType<ReturnType<typeof useComposerSubmission>['begin']> = null;
        act(() => { submission = controls!.begin('pending draft'); });

        act(() => { root.unmount(); });
        root = createRoot(dom.container);
        act(() => { root.render(React.createElement(Probe)); });
        expect(controls!.isPending).toBe(true);
        expect(controls!.pendingText).toBe('pending draft');

        act(() => { submission!.finish(); });
    } finally {
        act(() => { root.unmount(); });
        dom.restore();
    }
});

test('exposes confirmed mentions with the submitted text after remount', () => {
    const dom = installHookTestDom();
    let root = createRoot(dom.container);
    let controls: ReturnType<typeof useComposerSubmission> | null = null;

    function Probe() {
        controls = useComposerSubmission(sessionA);
        return null;
    }

    try {
        act(() => { root.render(React.createElement(Probe)); });
        let submission: ReturnType<ReturnType<typeof useComposerSubmission>['begin']> = null;
        act(() => { submission = controls!.begin('pending @README', new Set(['README'])); });

        act(() => { root.unmount(); });
        root = createRoot(dom.container);
        act(() => { root.render(React.createElement(Probe)); });
        expect(controls!.pendingText).toBe('pending @README');
        expect(controls!.pendingConfirmedMentions).toEqual(new Set(['README']));

        act(() => { submission!.finish(); });
    } finally {
        act(() => { root.unmount(); });
        dom.restore();
    }
});

test('transfers only the submitted new-session operation', () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const draftA: ChatDraftIdentity = { runtimeKey: 'runtime', directory: '/repo-a', sessionId: null };
    const draftB: ChatDraftIdentity = { runtimeKey: 'runtime', directory: '/repo-b', sessionId: null };
    const materialized: ChatDraftIdentity = { runtimeKey: 'runtime', directory: '/canonical', sessionId: 'created' };
    let current = draftA;
    let controls: ReturnType<typeof useComposerSubmission> | null = null;

    function Probe() {
        controls = useComposerSubmission(current);
        return null;
    }

    try {
        act(() => { root.render(React.createElement(Probe)); });
        let submissionA: ReturnType<ReturnType<typeof useComposerSubmission>['begin']> = null;
        act(() => { submissionA = controls!.begin('draft A'); });
        current = draftB;
        act(() => { root.render(React.createElement(Probe)); });
        let submissionB: ReturnType<ReturnType<typeof useComposerSubmission>['begin']> = null;
        act(() => { submissionB = controls!.begin('draft B'); });

        act(() => { submissionA!.transfer(materialized); });
        current = materialized;
        act(() => { root.render(React.createElement(Probe)); });
        expect(controls!.isPending).toBe(true);
        expect(controls!.pendingText).toBe('draft A');

        act(() => {
            submissionA!.finish();
            submissionB!.finish();
        });
    } finally {
        act(() => { root.unmount(); });
        dom.restore();
    }
});

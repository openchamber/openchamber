import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { createChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { readComposerAttachmentTarget, readComposerDraftTarget, useComposerDraftTarget } from './useComposerAddress';

const mounted: Array<() => void> = [];

const renderInlineTarget = (directory: string | null) => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    let lastTarget: ReturnType<typeof useComposerDraftTarget> = null;

    function Probe() {
        lastTarget = useComposerDraftTarget(directory);
        return null;
    }

    act(() => { root.render(React.createElement(Probe)); });
    const teardown = () => {
        act(() => { root.unmount(); });
        dom.restore();
    };
    mounted.push(teardown);
    return { target: () => lastTarget, teardown };
};

beforeEach(() => {
    useInputStore.setState({ composerAddress: null });
    useSessionUIStore.setState({ currentSessionId: 'ses_parent' });
});

afterEach(() => {
    while (mounted.length > 0) mounted.pop()?.();
    useInputStore.setState({ composerAddress: null });
});

describe('composer address', () => {
    test('falls back to the open session while no composer publishes one', () => {
        const probe = renderInlineTarget('/repo');
        expect(probe.target()).toEqual({ directory: '/repo', sessionKey: 'ses_parent' });
        expect(readComposerDraftTarget('/repo')).toEqual({ directory: '/repo', sessionKey: 'ses_parent' });
        expect(readComposerAttachmentTarget()).toBeNull();
    });

    test('takes the address the composer published, a /btw fork included', () => {
        const probe = renderInlineTarget('/repo');
        const fork = { directory: '/repo', sessionKey: 'ses_fork' };
        const attachments = createChatDraftIdentity(getRuntimeKey(), '/repo', 'ses_fork');

        act(() => { useInputStore.getState().setComposerAddress({ inline: fork, attachments }); });

        expect(probe.target()).toBe(fork);
        expect(readComposerDraftTarget('/repo')).toBe(fork);
        expect(readComposerAttachmentTarget()).toBe(attachments);
    });

    test('has nothing to file into without a session or a published target', () => {
        useSessionUIStore.setState({ currentSessionId: null });
        const probe = renderInlineTarget('/repo');
        expect(probe.target()).toBeNull();
        expect(readComposerDraftTarget('/repo')).toBeNull();
    });
});

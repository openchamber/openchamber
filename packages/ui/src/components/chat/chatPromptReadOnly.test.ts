import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';

import { resolveChatPromptReadOnly } from './chatPromptReadOnly';
import { withReviewSessionMarker } from '@/lib/sessionReviewMetadata';

const session = (parentID?: string): Session => ({
    id: 'session',
    title: 'Session',
    projectID: 'project',
    directory: '/repo',
    parentID,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
});

describe('resolveChatPromptReadOnly', () => {
    test('allows prompting a subagent without requiring its parent record', () => {
        expect(resolveChatPromptReadOnly(session('parent'), true, true)).toBe(false);
    });

    test('keeps a subagent read-only when prompting is disabled', () => {
        expect(resolveChatPromptReadOnly(session('parent'), false, false)).toBe(true);
    });

    test('preserves the surface read-only state for root sessions', () => {
        expect(resolveChatPromptReadOnly(session(), true, true)).toBe(true);
        expect(resolveChatPromptReadOnly(session(), true, false)).toBe(false);
    });

    test('treats a marked code review as an independent session even with a stale parent ID', () => {
        const reviewSession = {
            ...session('original'),
            metadata: withReviewSessionMarker({}, 'original'),
        } as Session;

        expect(resolveChatPromptReadOnly(reviewSession, false, false)).toBe(false);
        expect(resolveChatPromptReadOnly(reviewSession, true, true)).toBe(true);
    });
});

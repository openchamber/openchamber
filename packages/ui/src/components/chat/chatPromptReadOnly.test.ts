import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import { resolveChatPromptReadOnly } from './chatPromptReadOnly';

const session = (parentID?: string): Session => ({
    id: 'session',
    slug: 'session',
    title: 'Session',
    version: '1',
    projectID: 'project',
    directory: '/repo',
    parentID,
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
});

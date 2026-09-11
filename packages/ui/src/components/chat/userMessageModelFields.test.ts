import { describe, expect, test } from 'bun:test';

import { readUserMessageModelFields } from './userMessageModelFields';

describe('readUserMessageModelFields', () => {
    test('reads nested model fields from a server-confirmed user message', () => {
        expect(readUserMessageModelFields({
            providerID: 'ignored-provider',
            modelID: 'ignored-model',
            variant: 'ignored-variant',
            model: {
                providerID: 'anthropic',
                modelID: 'claude-sonnet-4-6',
                variant: 'high',
            },
        })).toEqual({
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-6',
            variant: 'high',
        });
    });

    test('falls back to top-level fields when model is a provider/model string', () => {
        expect(readUserMessageModelFields({
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-6',
            variant: 'high',
            model: 'anthropic/claude-sonnet-4-6',
        })).toEqual({
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-6',
            variant: 'high',
        });
    });

    test('does not throw when model is null, absent, or a non-object, and falls back', () => {
        const topLevel = {
            providerID: 'openai',
            modelID: 'gpt-4.1',
            variant: 'none',
        };

        expect(readUserMessageModelFields({ ...topLevel, model: null })).toEqual(topLevel);
        expect(readUserMessageModelFields(topLevel)).toEqual(topLevel);
        expect(readUserMessageModelFields({ ...topLevel, model: false })).toEqual(topLevel);
    });
});

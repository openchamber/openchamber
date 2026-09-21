import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2';

import { getActiveAssistantContext } from './useAssistantStatus';

const userMessage = (id: string, providerID: string, modelID: string): Message => ({
    id,
    role: 'user',
    sessionID: 'ses_1',
    time: { created: 1 },
    model: { providerID, modelID },
} as Message);

const assistantMessage = (id: string, parentID: string): Message => ({
    id,
    role: 'assistant',
    sessionID: 'ses_1',
    parentID,
    time: { created: 2 },
} as Message);

describe('getActiveAssistantContext', () => {
    test('uses the active assistant parent model instead of the latest user selection', () => {
        const activeParent = userMessage('user_1', 'anthropic', 'claude-opus-4-1');
        const assistant = assistantMessage('assistant_1', activeParent.id);
        const laterSelection = userMessage('user_2', 'openai', 'gpt-5.6-sol');

        expect(getActiveAssistantContext([activeParent, assistant, laterSelection])).toEqual({
            assistantId: assistant.id,
            model: {
                providerId: 'anthropic',
                modelId: 'claude-opus-4-1',
            },
        });
    });

    test('switches models only when a newer assistant links to the newer user message', () => {
        const firstUser = userMessage('user_1', 'anthropic', 'claude-opus-4-1');
        const firstAssistant = assistantMessage('assistant_1', firstUser.id);
        const secondUser = userMessage('user_2', 'openai', 'gpt-5.6-sol');
        const secondAssistant = assistantMessage('assistant_2', secondUser.id);

        expect(getActiveAssistantContext([firstUser, firstAssistant, secondUser, secondAssistant])).toEqual({
            assistantId: secondAssistant.id,
            model: {
                providerId: 'openai',
                modelId: 'gpt-5.6-sol',
            },
        });
    });

    test('does not guess a model when the parent message is unavailable', () => {
        const assistant = assistantMessage('assistant_1', 'missing_user');

        expect(getActiveAssistantContext([assistant])).toEqual({
            assistantId: assistant.id,
            model: null,
        });
    });

    test('shows no model while an Auto-routed message waits for its answer', () => {
        const previousUser = userMessage('user_1', 'anthropic', 'claude-opus-4-1');
        const previousAssistant = assistantMessage('assistant_1', previousUser.id);
        const autoUser = userMessage('user_2', 'openchamber', 'auto');

        expect(getActiveAssistantContext([previousUser, previousAssistant, autoUser])).toEqual({
            assistantId: previousAssistant.id,
            model: null,
        });

        // The optimistic copy names the model with top-level ids instead of a `model` object.
        const optimisticAuto = { ...autoUser, model: 'openchamber/auto', providerID: 'openchamber', modelID: 'auto' } as unknown as Message;
        expect(getActiveAssistantContext([previousUser, previousAssistant, optimisticAuto]).model).toBeNull();

        // Once OpenCode has answered, the user message carries the real model again.
        const routedUser = userMessage('user_2', 'openai', 'gpt-6-astra');
        const answer = assistantMessage('assistant_2', routedUser.id);
        expect(getActiveAssistantContext([previousUser, previousAssistant, routedUser, answer]).model).toEqual({
            providerId: 'openai',
            modelId: 'gpt-6-astra',
        });
    });

    test('shows the new turn model right away once the previous turn has completed', () => {
        const firstUser = userMessage('user_1', 'anthropic', 'claude-opus-4-1');
        const completedAssistant = { ...assistantMessage('assistant_1', firstUser.id), time: { created: 2, completed: 3 } } as Message;
        const nextUser = userMessage('user_2', 'openai', 'gpt-6-astra');

        expect(getActiveAssistantContext([firstUser, completedAssistant, nextUser]).model).toEqual({
            providerId: 'openai',
            modelId: 'gpt-6-astra',
        });
    });
});

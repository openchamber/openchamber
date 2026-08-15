import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2';

import { getActiveAssistantContext } from './useAssistantStatus';
import { isSessionStatusAuthoritative } from './useSessionActivity';

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

    test('uses latest user model when the last assistant is completed and a newer user message exists', () => {
        const firstUser = userMessage('user_1', 'anthropic', 'claude-opus-4-1');
        const completedAssistant = {
            ...assistantMessage('assistant_1', firstUser.id),
            time: { created: 2, completed: 3 },
        } as Message;
        const secondUser = userMessage('user_2', 'openai', 'gpt-5.6-sol');

        expect(getActiveAssistantContext([firstUser, completedAssistant, secondUser])).toEqual({
            assistantId: completedAssistant.id,
            model: {
                providerId: 'openai',
                modelId: 'gpt-5.6-sol',
            },
        });
    });

    test('falls back to parent model when the last assistant is completed but no newer user message exists', () => {
        const firstUser = userMessage('user_1', 'anthropic', 'claude-opus-4-1');
        const completedAssistant = {
            ...assistantMessage('assistant_1', firstUser.id),
            time: { created: 2, completed: 3 },
        } as Message;

        expect(getActiveAssistantContext([firstUser, completedAssistant])).toEqual({
            assistantId: completedAssistant.id,
            model: {
                providerId: 'anthropic',
                modelId: 'claude-opus-4-1',
            },
        });
    });

    test('uses assistant model string when user message has no model info', () => {
        const user = { id: 'user_1', role: 'user', sessionID: 'ses_1', time: { created: 1 } } as unknown as Message;
        const assistant = {
            id: 'assistant_1',
            role: 'assistant',
            sessionID: 'ses_1',
            parentID: 'user_1',
            time: { created: 2 },
            model: 'openai/gpt-5.6-luna',
        } as unknown as Message;

        expect(getActiveAssistantContext([user, assistant])).toEqual({
            assistantId: assistant.id,
            model: {
                providerId: 'openai',
                modelId: 'gpt-5.6-luna',
            },
        });
    });

    test('uses SDK assistant providerID and modelID when user message has no model info', () => {
        const user = { id: 'user_1', role: 'user', sessionID: 'ses_1', time: { created: 1 } } as unknown as Message;
        const assistant = {
            id: 'assistant_1',
            role: 'assistant',
            sessionID: 'ses_1',
            parentID: 'user_1',
            time: { created: 2 },
            providerID: 'openai',
            modelID: 'gpt-5.6-luna',
        } as unknown as Message;

        expect(getActiveAssistantContext([user, assistant])).toEqual({
            assistantId: assistant.id,
            model: {
                providerId: 'openai',
                modelId: 'gpt-5.6-luna',
            },
        });
    });

    test('uses the current selection while a newer user message awaits its assistant', () => {
        const firstUser = userMessage('user_1', 'openai', 'gpt-5.6-luna');
        const completedAssistant = {
            id: 'assistant_1',
            role: 'assistant',
            sessionID: 'ses_1',
            parentID: 'user_1',
            time: { created: 2, completed: 3 },
            providerID: 'openai',
            modelID: 'gpt-5.6-luna',
        } as unknown as Message;
        const newerUser = {
            id: 'user_2',
            role: 'user',
            sessionID: 'ses_1',
            time: { created: 4 },
        } as unknown as Message;

        expect(getActiveAssistantContext([firstUser, completedAssistant, newerUser], {
            providerId: 'ark',
            modelId: 'glm-5.2',
        })).toEqual({
            assistantId: completedAssistant.id,
            model: {
                providerId: 'ark',
                modelId: 'glm-5.2',
            },
        });
    });

    test('uses newer user model string when completed assistant has string model', () => {
        const firstUser = { id: 'user_1', role: 'user', sessionID: 'ses_1', time: { created: 1 } } as unknown as Message;
        const completedAssistant = {
            id: 'assistant_1',
            role: 'assistant',
            sessionID: 'ses_1',
            parentID: 'user_1',
            time: { created: 2, completed: 3 },
            model: 'openai/gpt-5.6-luna',
        } as unknown as Message;
        const secondUser = {
            id: 'user_2',
            role: 'user',
            sessionID: 'ses_1',
            time: { created: 4 },
            model: 'ark/glm-5.2',
        } as unknown as Message;

        expect(getActiveAssistantContext([firstUser, completedAssistant, secondUser])).toEqual({
            assistantId: completedAssistant.id,
            model: {
                providerId: 'ark',
                modelId: 'glm-5.2',
            },
        });
    });

    test('falls back to assistant model string when completed and no newer user model', () => {
        const user = { id: 'user_1', role: 'user', sessionID: 'ses_1', time: { created: 1 } } as unknown as Message;
        const completedAssistant = {
            id: 'assistant_1',
            role: 'assistant',
            sessionID: 'ses_1',
            parentID: 'user_1',
            time: { created: 2, completed: 3 },
            model: 'openai/gpt-5.6-luna',
        } as unknown as Message;

        expect(getActiveAssistantContext([user, completedAssistant])).toEqual({
            assistantId: completedAssistant.id,
            model: {
                providerId: 'openai',
                modelId: 'gpt-5.6-luna',
            },
        });
    });
});

describe('isSessionStatusAuthoritative', () => {
    test('treats a successful empty status snapshot as authoritative idle', () => {
        expect(isSessionStatusAuthoritative(undefined, true)).toBe(true);
    });

    test('keeps message fallback available before the first successful status snapshot', () => {
        expect(isSessionStatusAuthoritative(undefined, false)).toBe(false);
    });

    test('treats an explicit session status as authoritative', () => {
        expect(isSessionStatusAuthoritative({ type: 'idle' }, false)).toBe(true);
    });
});

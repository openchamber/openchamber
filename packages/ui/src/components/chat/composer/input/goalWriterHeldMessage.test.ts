import { describe, expect, test } from 'bun:test';

import { toServerItemInput } from '@/stores/messageQueueStore';
import { goalWriterHeldMessage } from './goalWriterHeldMessage';

const sendConfig = { providerID: 'anthropic', modelID: 'claude' };

const captured = (skillNames: string[]) => ({
    messageToQueue: 'Fix the flaky test $review',
    textToQueue: 'Fix the flaky test $review',
    agentMention: 'build',
    skillNames,
    attachmentsToQueue: [],
    context: [],
});

// Oracle: the queue item contract the server reads, built by the same
// toServerItemInput a goal job's create request sends.
describe('goalWriterHeldMessage', () => {
    test('a goal job item carries the captured $skill names to the server queue', () => {
        const item = toServerItemInput(goalWriterHeldMessage(captured(['review'])), sendConfig);
        expect(item.skills).toEqual(['review']);
        expect(item.agentMention).toBe('build');
        expect(item.text).toBe('Fix the flaky test $review');
    });

    test('a message that names no skill sends no skills field', () => {
        const item = toServerItemInput(goalWriterHeldMessage(captured([])), sendConfig);
        expect('skills' in item).toBe(false);
    });
});

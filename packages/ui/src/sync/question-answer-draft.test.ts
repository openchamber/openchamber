import { beforeEach, describe, expect, test } from 'bun:test';

import {
    beginQuestionAnswerSubmission,
    clearQuestionAnswerDraft,
    getQuestionAnswerDraft,
    resetQuestionAnswerDraftsForTests,
    setQuestionAnswerDraft,
} from './question-answer-draft';

describe('questionAnswerDraft', () => {
    beforeEach(() => resetQuestionAnswerDraftsForTests());

    test('retains an answer for the owning question until acknowledged', () => {
        const key = 'runtime:session:question';
        const answer = {
            selectedOptions: { 0: ['Option A'] },
            customMode: { 1: true },
            customText: { 1: 'Details' },
        };

        setQuestionAnswerDraft(key, answer);
        answer.selectedOptions[0]!.push('changed outside the owner');

        expect(getQuestionAnswerDraft(key)).toEqual({
            selectedOptions: { 0: ['Option A'] },
            customMode: { 1: true },
            customText: { 1: 'Details' },
        });

        clearQuestionAnswerDraft(key);
        expect(getQuestionAnswerDraft(key)).toBeNull();
    });

    test('allows only one pending submission for each question', () => {
        const first = beginQuestionAnswerSubmission('question-1');

        expect(first).not.toBeNull();
        expect(beginQuestionAnswerSubmission('question-1')).toBeNull();
        const other = beginQuestionAnswerSubmission('question-2');
        expect(other).not.toBeNull();

        first!.finish();
        expect(beginQuestionAnswerSubmission('question-1')).not.toBeNull();
        other!.finish();
    });

    test('ends pending state when an authoritative event acknowledges the question', () => {
        const first = beginQuestionAnswerSubmission('question-1')!;

        clearQuestionAnswerDraft('question-1');
        const second = beginQuestionAnswerSubmission('question-1');

        expect(second).not.toBeNull();
        first.finish();
        expect(beginQuestionAnswerSubmission('question-1')).toBeNull();
        second!.finish();
    });
});

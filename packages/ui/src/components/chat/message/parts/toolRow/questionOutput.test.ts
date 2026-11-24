import { describe, expect, test } from 'bun:test';

import { parseQuestionOutput, questionAnswersForCall } from './questionOutput';

const answered = (pairs: Array<[string, string]>): string => (
    `User has answered your questions: ${pairs.map(([question, answer]) => `"${question}"="${answer}"`).join(', ')}. You can now continue with the user's answers in mind.`
);

describe('questionAnswersForCall', () => {
    test('reads the answers the call recorded, quotes included', () => {
        const input = {
            questions: [
                { question: 'What should the site actually do?' },
                { question: 'Who is it for?' },
            ],
        };
        expect(questionAnswersForCall(
            {
                answers: [
                    ["im NOT doing any 'personal tasting'"],
                    ['its "for" me, not sharing it'],
                ],
            },
            input,
            answered([
                ['What should the site actually do?', "im NOT doing any 'personal tasting'"],
                ['Who is it for?', 'its "for" me, not sharing it'],
            ]),
            'Unanswered',
        )).toEqual([
            { question: 'What should the site actually do?', answer: "im NOT doing any 'personal tasting'" },
            { question: 'Who is it for?', answer: 'its "for" me, not sharing it' },
        ]);
    });

    test('joins a multi-select answer the way the tool does', () => {
        const input = { questions: [{ question: 'Which ones?' }] };
        expect(questionAnswersForCall(
            { answers: [['Yes', 'Later']] },
            input,
            answered([['Which ones?', 'Yes, Later']]),
            'Unanswered',
        )).toEqual([{ question: 'Which ones?', answer: 'Yes, Later' }]);
    });

    test('keeps a blank question in its place as the tool writes it', () => {
        const input = { questions: [{ question: 'Ship it?' }, { question: 'Tag it?' }] };
        expect(questionAnswersForCall(
            { answers: [['Yes'], []] },
            input,
            answered([['Ship it?', 'Yes'], ['Tag it?', 'Unanswered']]),
            'Unanswered',
        )).toEqual([
            { question: 'Ship it?', answer: 'Yes' },
            { question: 'Tag it?', answer: 'Unanswered' },
        ]);
    });

    test('labels a blank answer with the caller\'s word when it is given one', () => {
        const input = { questions: [{ question: 'Tag it?' }] };
        expect(questionAnswersForCall(
            { answers: [[]] },
            input,
            answered([['Tag it?', 'Unanswered']]),
            'Niet beantwoord',
        )).toEqual([{ question: 'Tag it?', answer: 'Niet beantwoord' }]);
    });

    test('falls back to the reply text when the call recorded no answers', () => {
        const input = { questions: [{ question: 'Ship it?' }] };
        expect(questionAnswersForCall(undefined, input, answered([['Ship it?', 'Yes']]), 'Unanswered'))
            .toEqual([{ question: 'Ship it?', answer: 'Yes' }]);
    });

    test('falls back to the reply text when the recorded answers do not line up', () => {
        const input = { questions: [{ question: 'Ship it?' }, { question: 'Tag it?' }] };
        expect(questionAnswersForCall(
            { answers: [['Yes']] },
            input,
            answered([['Ship it?', 'Yes'], ['Tag it?', 'No']]),
            'Unanswered',
        )).toEqual([
            { question: 'Ship it?', answer: 'Yes' },
            { question: 'Tag it?', answer: 'No' },
        ]);
    });
});

describe('parseQuestionOutput', () => {
    test('reads each pair of a call without recorded answers', () => {
        expect(parseQuestionOutput(answered([['Ship it?', 'Yes'], ['Tag it?', 'No']]))).toEqual([
            { question: 'Ship it?', answer: 'Yes' },
            { question: 'Tag it?', answer: 'No' },
        ]);
    });

    test('keeps two pairs apart when the first answer ends in a backslash', () => {
        expect(parseQuestionOutput(answered([['Which folder?', 'C:\\temp\\'], ['Ship it?', 'Yes']]))).toEqual([
            { question: 'Which folder?', answer: 'C:\\temp\\' },
            { question: 'Ship it?', answer: 'Yes' },
        ]);
    });

    test('returns null when the reply is not an answer', () => {
        expect(parseQuestionOutput('User dismissed your questions.')).toBeNull();
        expect(parseQuestionOutput('')).toBeNull();
    });
});

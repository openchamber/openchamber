import { describe, expect, test } from 'bun:test';

import type { MessageHistoryValue } from '../useMessageHistory';
import { filterPromptHistory, preparePromptHistory } from '../promptHistorySearch';

type Attachment = { id: string };

const entry = (text: string, attachments: readonly Attachment[] = []): MessageHistoryValue<Attachment> => ({ text, attachments });

describe('preparePromptHistory', () => {
    test('keeps newest exact-text entries in oldest-first order with original indices', () => {
        const history = [entry('first'), entry('duplicate', [{ id: 'old' }]), entry(''), entry('duplicate', [{ id: 'new' }]), entry('last')];

        expect(preparePromptHistory(history)).toEqual([
            { index: 0, value: history[0] },
            { index: 3, value: history[3] },
            { index: 4, value: history[4] },
        ]);
    });

    test('does not treat whitespace-only prompts as candidates', () => {
        const history = [entry('  '), entry('\n\t'), entry('meaningful')];

        expect(preparePromptHistory(history)).toEqual([{ index: 2, value: history[2] }]);
    });
});

describe('filterPromptHistory', () => {
    const longPrompt = `${'prefix '.repeat(100)}distinctive search marker`;
    const history = [
        entry('Fix GLM-5.3 integration'),
        entry('Résumé: café déjà vu'),
        entry(longPrompt),
    ];
    const candidates = preparePromptHistory(history);

    test('preserves chronology while matching all case-insensitive query tokens', () => {
        expect(filterPromptHistory(candidates, 'FIX integration')).toEqual([{ index: 0, value: history[0] }]);
    });

    test('uses punctuation-insensitive matching without typo fallback', () => {
        expect(filterPromptHistory(candidates, 'glm53')).toEqual([{ index: 0, value: history[0] }]);
        expect(filterPromptHistory(candidates, 'integraiton')).toEqual([]);
    });

    test('matches Unicode and text beyond a preview-sized prefix', () => {
        expect(filterPromptHistory(candidates, 'CAFÉ déjà')).toEqual([{ index: 1, value: history[1] }]);
        expect(filterPromptHistory(candidates, 'distinctive search marker')).toEqual([{ index: 2, value: history[2] }]);
    });
});

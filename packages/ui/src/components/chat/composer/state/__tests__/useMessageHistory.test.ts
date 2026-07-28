import { describe, expect, test } from 'bun:test';

import {
    HISTORY_IDLE,
    INITIAL_HISTORY_STATE,
    stepNewer,
    stepOlder,
    type HistoryState,
} from '../useMessageHistory';

const HISTORY = ['newest', 'middle', 'oldest'];

/** Apply a sequence of steps, returning the texts shown and the final state. */
function walk(
    steps: Array<{ dir: 'older' | 'newer'; draft?: string }>,
    history: readonly string[] = HISTORY,
) {
    let state: HistoryState = INITIAL_HISTORY_STATE;
    const texts: Array<string | null> = [];
    for (const step of steps) {
        const result = step.dir === 'older'
            ? stepOlder(state, history, step.draft ?? '')
            : stepNewer(state, history);
        state = result.state;
        texts.push(result.text);
    }
    return { texts, state };
}

describe('walking back', () => {
    test('the first step recalls the most recent message', () => {
        expect(walk([{ dir: 'older', draft: 'my draft' }]).texts).toEqual(['newest']);
    });

    test('successive steps go further back', () => {
        expect(walk([{ dir: 'older' }, { dir: 'older' }, { dir: 'older' }]).texts)
            .toEqual(['newest', 'middle', 'oldest']);
    });

    test('the oldest message is the end of the line', () => {
        const { texts } = walk([
            { dir: 'older' }, { dir: 'older' }, { dir: 'older' }, { dir: 'older' },
        ]);
        expect(texts[3]).toBeNull();
    });

    test('reaching the end leaves the state where it was', () => {
        const { state } = walk([
            { dir: 'older' }, { dir: 'older' }, { dir: 'older' }, { dir: 'older' },
        ]);
        expect(state.index).toBe(2);
    });

    test('empty history recalls nothing', () => {
        const { texts, state } = walk([{ dir: 'older', draft: 'x' }], []);
        expect(texts).toEqual([null]);
        expect(state.index).toBe(HISTORY_IDLE);
    });

    test('a single-message history has exactly one step', () => {
        const { texts } = walk([{ dir: 'older' }, { dir: 'older' }], ['only']);
        expect(texts).toEqual(['only', null]);
    });
});

describe('coming back', () => {
    test('returns toward newer messages', () => {
        const { texts } = walk([{ dir: 'older' }, { dir: 'older' }, { dir: 'newer' }]);
        expect(texts[2]).toBe('newest');
    });

    test('stepping past the newest restores the stashed draft', () => {
        const { texts, state } = walk([
            { dir: 'older', draft: 'half-written prompt' },
            { dir: 'newer' },
        ]);
        expect(texts[1]).toBe('half-written prompt');
        expect(state.index).toBe(HISTORY_IDLE);
    });

    test('an empty draft is restored as empty rather than left on a message', () => {
        const { texts } = walk([{ dir: 'older', draft: '' }, { dir: 'newer' }]);
        expect(texts[1]).toBe('');
    });

    test('coming back when not browsing does nothing', () => {
        expect(walk([{ dir: 'newer' }]).texts).toEqual([null]);
    });

    test('the draft is stashed on entry, not overwritten by recalled text', () => {
        // The second `older` passes recalled text as the current text; it must
        // not replace what the user actually typed.
        const { texts } = walk([
            { dir: 'older', draft: 'original draft' },
            { dir: 'older', draft: 'newest' },
            { dir: 'newer' },
            { dir: 'newer' },
        ]);
        expect(texts[3]).toBe('original draft');
    });

    test('the stash is cleared once restored', () => {
        const { state } = walk([{ dir: 'older', draft: 'draft' }, { dir: 'newer' }]);
        expect(state.stashedDraft).toBe('');
    });
});

describe('a shrinking history', () => {
    test('an index past the end of a shorter history cannot step further back', () => {
        const state: HistoryState = { index: 5, stashedDraft: 'draft' };
        expect(stepOlder(state, HISTORY, 'x').text).toBeNull();
    });
});

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { canCommentOnDocument, drainPending, nextDraftId, reconcileThreadFate, resolveCommentFilePath, selectionLineRange, shouldDisposeOnEmptyBody, snapshotOwnsThread } from './inlineCommentSelection';

const selection = (startLine: number, startChar: number, endLine: number, endChar: number) => ({
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar },
});

describe('selectionLineRange', () => {
    test('a caret with no selection covers its own line', () => {
        assert.deepEqual(selectionLineRange(selection(0, 4, 0, 4)), { startLine: 1, endLine: 1 });
    });

    test('a partial selection on one line covers that line', () => {
        assert.deepEqual(selectionLineRange(selection(11, 2, 11, 30)), { startLine: 12, endLine: 12 });
    });

    test('a multi-line selection covers every line it touches', () => {
        assert.deepEqual(selectionLineRange(selection(4, 0, 7, 12)), { startLine: 5, endLine: 8 });
    });

    test('stopping at the start of the next line does not count that line', () => {
        // Dragging past the end of line 12 lands at (12, 0) but shows nothing
        // there, so the comment is on line 12 alone.
        assert.deepEqual(selectionLineRange(selection(11, 0, 12, 0)), { startLine: 12, endLine: 12 });
    });

    test('a selection ending at column 0 of its own line is still that line', () => {
        assert.deepEqual(selectionLineRange(selection(3, 0, 3, 0)), { startLine: 4, endLine: 4 });
    });
});

describe('nextDraftId', () => {
    test('matches the shared store id format', () => {
        assert.match(nextDraftId(1735689600000, 0.123456789), /^icd-1735689600000-[a-z0-9]+$/);
    });

    test('different randomness yields different ids at the same instant', () => {
        assert.notEqual(nextDraftId(1, 0.5), nextDraftId(1, 0.9));
    });
});

describe('resolveCommentFilePath', () => {
    test('an ordinary file keeps its path', () => {
        assert.equal(resolveCommentFilePath('/repo/src/app.ts', ''), '/repo/src/app.ts');
    });

    test("a Source Control diff resolves to the query's real path", () => {
        // The original side of a diff is a `git:` document; its path is not a
        // file on disk, but the query names the file it came from.
        const query = JSON.stringify({ path: '/repo/src/app.ts', ref: '~' });
        assert.equal(resolveCommentFilePath('/repo/src/app.ts.git', query), '/repo/src/app.ts');
    });

    test('a malformed query falls back to the URI path', () => {
        assert.equal(resolveCommentFilePath('/repo/src/app.ts', 'not json'), '/repo/src/app.ts');
    });

    test('a query without a usable path falls back to the URI path', () => {
        assert.equal(resolveCommentFilePath('/repo/src/app.ts', JSON.stringify({ ref: '~' })), '/repo/src/app.ts');
        assert.equal(resolveCommentFilePath('/repo/src/app.ts', JSON.stringify({ path: '  ' })), '/repo/src/app.ts');
    });
});

describe('canCommentOnDocument', () => {
    test('a workspace file can take a comment', () => {
        assert.equal(canCommentOnDocument('file', true), true);
    });

    test("a diff's original side can too, since it resolves to a workspace file", () => {
        assert.equal(canCommentOnDocument('git', true), true);
    });

    test('a file outside the workspace cannot', () => {
        // The comment is filed against a workspace-relative path, so one written
        // elsewhere would name a file the composer cannot resolve.
        assert.equal(canCommentOnDocument('file', false), false);
    });

    test('a comment editor cannot comment on itself', () => {
        assert.equal(canCommentOnDocument('comment', true), false);
    });
});

describe('drainPending', () => {
    test('every held comment is returned, in order', () => {
        // A second comment can be written while a panel is still booting.
        // Keeping only the newest silently dropped the first after its thread
        // had already reported success.
        const pending = ['first', 'second', 'third'];
        assert.deepEqual(drainPending(pending), ['first', 'second', 'third']);
    });

    test('the hold is emptied, so a later flush delivers nothing twice', () => {
        const pending = ['only'];
        drainPending(pending);
        assert.deepEqual(pending, []);
        assert.deepEqual(drainPending(pending), []);
    });

    test('an empty hold drains to nothing', () => {
        assert.deepEqual(drainPending([]), []);
    });
});

describe('snapshotOwnsThread', () => {
    test('the surface holding the draft speaks for its thread', () => {
        assert.equal(snapshotOwnsThread('panel-a', 'panel-a'), true);
    });

    test('another tab says nothing about this thread', () => {
        // Every webview has its own draft store, so a second session tab
        // reporting an empty list is not evidence that this comment is gone.
        // Before this rule, opening a tab disposed the other tab's threads.
        assert.equal(snapshotOwnsThread('panel-a', 'panel-b'), false);
    });

    test('the sidebar does not speak for a panel, nor a panel for the sidebar', () => {
        assert.equal(snapshotOwnsThread('panel-a', 'sidebar'), false);
        assert.equal(snapshotOwnsThread('sidebar', 'panel-a'), false);
    });

    test('a thread with no surface yet is owned by nobody', () => {
        assert.equal(snapshotOwnsThread(undefined, 'panel-a'), false);
        assert.equal(snapshotOwnsThread('', 'panel-a'), false);
    });
});

describe('reconcileThreadFate', () => {
    test('a draft absent from the very first snapshot is still in flight', () => {
        // Opening a session tab makes its webview publish before the comment
        // that opened it has landed. Treating that as a removal destroyed the
        // thread the user had just written.
        assert.equal(reconcileThreadFate(undefined, false), 'wait');
    });

    test('a draft absent after having been seen was removed', () => {
        assert.equal(reconcileThreadFate(undefined, true), 'dispose');
    });

    test('a draft present is shown, and counts as seen', () => {
        assert.equal(reconcileThreadFate('fix this', false), 'show');
        assert.equal(reconcileThreadFate('fix this', true), 'show');
    });

    test('a draft emptied in the composer drops its thread', () => {
        assert.equal(reconcileThreadFate('', true), 'dispose');
        assert.equal(reconcileThreadFate('   ', false), 'dispose');
    });
});

describe('shouldDisposeOnEmptyBody', () => {
    test('blank and whitespace-only bodies are a cancel', () => {
        assert.equal(shouldDisposeOnEmptyBody(''), true);
        assert.equal(shouldDisposeOnEmptyBody('   \n\t '), true);
    });

    test('any real text is kept', () => {
        assert.equal(shouldDisposeOnEmptyBody(' fix this '), false);
    });
});

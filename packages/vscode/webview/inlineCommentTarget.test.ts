import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCommentTarget } from './inlineCommentTarget';

const snapshot = (overrides = {}) => ({
    currentSessionId: null,
    sessionDirectory: null,
    draftOpen: false,
    draftDirectory: null,
    currentDirectory: '/repo',
    ...overrides,
});

describe('resolveCommentTarget', () => {
    test('a booting panel with a directory but no session keeps waiting', () => {
        // This was the bug: the draft went under `draft` here, a key the
        // session's composer never reads, and the chip never appeared.
        assert.equal(resolveCommentTarget(snapshot(), 'ses_1'), null);
        assert.equal(resolveCommentTarget(snapshot()), null);
    });

    test('a session panel files only once it shows the session the comment is for', () => {
        assert.equal(resolveCommentTarget(snapshot({ currentSessionId: 'ses_other', sessionDirectory: '/repo' }), 'ses_1'), null);
        assert.deepEqual(
            resolveCommentTarget(snapshot({ currentSessionId: 'ses_1', sessionDirectory: '/repo/wt' }), 'ses_1'),
            { directory: '/repo/wt', sessionKey: 'ses_1' },
        );
    });

    test('the session directory wins over the webview directory', () => {
        assert.deepEqual(
            resolveCommentTarget(snapshot({ currentSessionId: 'ses_1', sessionDirectory: '/repo/wt' })),
            { directory: '/repo/wt', sessionKey: 'ses_1' },
        );
        assert.deepEqual(
            resolveCommentTarget(snapshot({ currentSessionId: 'ses_1' })),
            { directory: '/repo', sessionKey: 'ses_1' },
        );
    });

    test('the sidebar files on an open new-session draft', () => {
        assert.deepEqual(
            resolveCommentTarget(snapshot({ draftOpen: true, draftDirectory: '/repo/other' })),
            { directory: '/repo/other', sessionKey: 'draft' },
        );
        assert.deepEqual(
            resolveCommentTarget(snapshot({ draftOpen: true })),
            { directory: '/repo', sessionKey: 'draft' },
        );
    });

    test('nothing is filed without any directory', () => {
        assert.equal(resolveCommentTarget(snapshot({ currentSessionId: 'ses_1', currentDirectory: null })), null);
        assert.equal(resolveCommentTarget(snapshot({ draftOpen: true, currentDirectory: null })), null);
    });
});

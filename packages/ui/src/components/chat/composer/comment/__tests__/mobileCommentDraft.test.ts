import { afterEach, describe, expect, test } from 'bun:test';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { getInlineCommentDraftKey, useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useInputStore } from '@/sync/input-store';
import {
    applyMobileCommentAttach,
    createMobileCommentDraftController,
    isSameMobileCommentScope,
    mobileCommentQuotePreview,
    type MobileCommentAttachPlan,
    type MobileCommentQuote,
    type MobileCommentScope,
} from '../mobileCommentDraft';

const scope = (overrides: Partial<MobileCommentScope> = {}): MobileCommentScope => ({
    runtimeKey: getRuntimeKey(),
    directory: '/repo/main',
    sessionKey: 'session-1',
    ...overrides,
});

const quote = (overrides: Partial<MobileCommentQuote> = {}): MobileCommentQuote => ({
    plainText: 'plain selection',
    markdownText: '**plain selection**',
    messageId: 'msg_1',
    ...overrides,
});

const openDraft = () => {
    const controller = createMobileCommentDraftController();
    controller.setScope(scope());
    if (!controller.open(quote())) throw new Error('open rejected');
    return controller;
};

afterEach(() => {
    useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} });
});

describe('mobileCommentQuotePreview', () => {
    test('keeps the full text for width-based clipping', () => {
        expect(mobileCommentQuotePreview('hello world')).toBe('hello world');
        expect(mobileCommentQuotePreview('abc')).toBe('abc');
    });

    test('counts code points, not utf-16 units', () => {
        // Family emoji: four emoji code points joined by ZWJ; slicing by
        // code point must not cut one in half.
        expect(mobileCommentQuotePreview('👍👍👍👍👍👍 rest')).toBe('👍👍👍👍👍👍 rest');
        expect(mobileCommentQuotePreview('café ☕ etc')).toBe('café ☕ etc');
    });

    test('trims surrounding whitespace first', () => {
        expect(mobileCommentQuotePreview('  \n hello')).toBe('hello');
        expect(mobileCommentQuotePreview('   ')).toBe('');
    });
});

describe('createMobileCommentDraftController', () => {
    test('open requires a complete scope and a quotable selection', () => {
        const controller = createMobileCommentDraftController();
        expect(controller.open(quote())).toBe(false);
        for (const invalidScope of [scope({ directory: '' }), scope({ sessionKey: '' }), scope({ runtimeKey: '' })]) {
            controller.setScope(invalidScope);
            expect(controller.open(quote())).toBe(false);
        }
        controller.setScope(scope());
        expect(controller.open(quote({ markdownText: '  ' }))).toBe(false);
        expect(controller.getState().status).toBe('closed');
    });

    test('edit and cancel: cancel discards the comment and later edits are rejected', () => {
        const controller = openDraft();
        const open = controller.getState();
        if (open.status !== 'open') throw new Error('expected open');
        controller.setText('a remark', open.generation);
        const edited = controller.getState();
        expect(edited.status).toBe('open');
        if (edited.status === 'open') expect(edited.text).toBe('a remark');

        controller.cancel();
        expect(controller.getState().status).toBe('closed');
        controller.setText('late', open.generation);
        expect(controller.getState().status).toBe('closed');
    });

    test('attach consumes the comment exactly once and keeps the full markdown', () => {
        const controller = openDraft();
        const open = controller.getState();
        if (open.status !== 'open') throw new Error('expected open');
        controller.setText('  please review this  ', open.generation);

        const plan = controller.attach(open.generation);
        expect(plan).not.toBeNull();
        expect(plan?.scope).toEqual(scope());
        expect(plan?.target).toEqual({ directory: '/repo/main', sessionKey: 'session-1' });
        expect(plan?.draft).toEqual({
            source: 'chat-quote',
            fileLabel: 'msg_1',
            startLine: 1,
            endLine: 1,
            code: '**plain selection**',
            language: '',
            text: 'please review this',
        });

        // Once-only: the state closed with the attach.
        expect(controller.getState().status).toBe('closed');
        expect(controller.attach(open.generation)).toBeNull();
        controller.setText('after attach', open.generation);
        expect(controller.getState().status).toBe('closed');
    });

    test('an empty or whitespace-only comment is allowed', () => {
        const controller = openDraft();
        const open = controller.getState();
        if (open.status !== 'open') throw new Error('expected open');
        const plan = controller.attach(open.generation);
        expect(plan?.draft.text).toBe('');
    });

    test('a stale generation cannot attach or edit', () => {
        const controller = openDraft();
        const stale = controller.getState();
        if (stale.status !== 'open') throw new Error('expected open');
        controller.cancel();
        if (!controller.open(quote())) throw new Error('open rejected');

        expect(controller.attach(stale.generation)).toBeNull();
        controller.setText('stale text', stale.generation);
        const open = controller.getState();
        expect(open.status).toBe('open');
        if (open.status === 'open') expect(open.text).toBe('');
    });

    test('a transcript from a previous comment cannot leak into the next one', () => {
        const controller = openDraft();
        const first = controller.getState();
        if (first.status !== 'open') throw new Error('expected open');
        controller.cancel();
        if (!controller.open(quote())) throw new Error('open rejected');

        // The old dictation callback still holds generation 1.
        controller.insertText('stale transcript', first.generation);
        const afterStale = controller.getState();
        expect(afterStale.status).toBe('open');
        if (afterStale.status === 'open') expect(afterStale.text).toBe('');

        const second = controller.getState();
        if (second.status !== 'open') throw new Error('expected open');
        controller.insertText('fresh transcript', second.generation);
        const afterFresh = controller.getState();
        expect(afterFresh.status).toBe('open');
        if (afterFresh.status === 'open') expect(afterFresh.text).toBe('fresh transcript ');
    });

    test('a stale insert-and-attach neither writes text nor attaches the newer comment', () => {
        const controller = openDraft();
        const stale = controller.getState();
        if (stale.status !== 'open') throw new Error('expected open');
        // The quoted selection is replaced mid-dictation: a new comment opens
        // (generation 2) while generation 1's transcript is still in flight.
        if (!controller.open(quote({ plainText: 'second', markdownText: 'second' }))) {
            throw new Error('open rejected');
        }
        const current = controller.getState();
        if (current.status !== 'open') throw new Error('expected open');

        expect(controller.insertAndAttach('stale transcript', stale.generation)).toBeNull();

        // Atomic rejection: nothing was attached, the newer comment is intact
        // and still open with empty text.
        const after = controller.getState();
        expect(after.status).toBe('open');
        if (after.status === 'open') {
            expect(after.text).toBe('');
            expect(after.quote.markdownText).toBe('second');
        }
    });

    test('insert-and-attach appends the transcript and consumes the comment', () => {
        const controller = openDraft();
        const open = controller.getState();
        if (open.status !== 'open') throw new Error('expected open');
        controller.setText('typed first', open.generation);

        const plan = controller.insertAndAttach('then dictated', open.generation);
        expect(plan).not.toBeNull();
        expect(plan?.draft.text).toBe('typed first then dictated');
        expect(controller.getState().status).toBe('closed');
    });

    test('cancel with a stale generation is rejected; the current open survives', () => {
        const controller = openDraft();
        const stale = controller.getState();
        if (stale.status !== 'open') throw new Error('expected open');
        if (!controller.open(quote())) throw new Error('open rejected');

        expect(controller.cancel(stale.generation)).toBe(false);
        expect(controller.getState().status).toBe('open');

        const current = controller.getState();
        if (current.status !== 'open') throw new Error('expected open');
        expect(controller.cancel(current.generation)).toBe(true);
        expect(controller.getState().status).toBe('closed');
        // A generation-less cancel still closes whatever is open (scope
        // changes, column teardown).
        if (!controller.open(quote())) throw new Error('open rejected');
        expect(controller.cancel()).toBe(true);
        expect(controller.getState().status).toBe('closed');
    });

    test('scope switch closes the comment; a later attach cannot write', () => {
        const controller = openDraft();
        const open = controller.getState();
        if (open.status !== 'open') throw new Error('expected open');

        controller.setScope(scope({ sessionKey: 'session-2' }));
        expect(controller.getState().status).toBe('closed');
        expect(controller.attach(open.generation)).toBeNull();

        // Same scope is a no-op.
        const again = openDraft();
        again.setScope(scope());
        expect(again.getState().status).toBe('open');
    });

    for (const [label, sessionKey] of [
        ['ordinary chat', 'session-1'],
        ['expanded BTW', 'btw-session-1'],
        ['pending BTW', 'btw-pending:session-1'],
        ['collapsed BTW', 'session-1'],
    ]) {
        test(`${label}: selection uses the target published by the visible composer`, () => {
            const controller = createMobileCommentDraftController();
            const visibleScope = scope({ sessionKey });
            controller.setScope(visibleScope);
            expect(controller.open(quote())).toBe(true);
            const open = controller.getState();
            if (open.status !== 'open') throw new Error('expected open');
            expect(open.scope).toEqual(visibleScope);
            controller.setText('comment on the selection', open.generation);
            expect(controller.attach(open.generation)?.target).toEqual({ directory: visibleScope.directory, sessionKey });
            expect(controller.attach(open.generation)).toBeNull();
            expect(useInlineCommentDraftStore.getState().getDrafts({ directory: visibleScope.directory, sessionKey })).toHaveLength(1);
            if (sessionKey !== 'session-1') {
                expect(useInlineCommentDraftStore.getState().getDrafts({ directory: visibleScope.directory, sessionKey: 'session-1' })).toEqual([]);
            }
        });
    }

    test('collapsing BTW or unmounting invalidates late attach and dictation', () => {
        const controller = createMobileCommentDraftController();
        controller.setScope(scope({ sessionKey: 'btw-session-1' }));
        controller.open(quote());
        const open = controller.getState();
        if (open.status !== 'open') throw new Error('expected open');
        controller.setScope(scope());
        expect(controller.insertAndAttach('late transcript', open.generation)).toBeNull();
        expect(useInlineCommentDraftStore.getState().drafts).toEqual({});
        expect(controller.open(quote())).toBe(true);
        controller.setScope(null);
        expect(controller.getState().status).toBe('closed');
        expect(controller.open(quote())).toBe(false);
    });

    test('a controller in another column keeps its own draft target', () => {
        const first = openDraft();
        const second = createMobileCommentDraftController();
        second.setScope(scope({ sessionKey: 'session-2' }));
        second.open(quote());
        first.setScope(null);
        const open = second.getState();
        if (open.status !== 'open') throw new Error('expected open');
        expect(second.attach(open.generation)?.target.sessionKey).toBe('session-2');
    });

    test('store-limit rejection preserves text and quote, and a retry attaches exactly once', () => {
        const target = { directory: '/repo/main', sessionKey: 'session-1' };
        const store = useInlineCommentDraftStore.getState();
        const existingId = store.addDraft(target, {
            source: 'chat-quote', fileLabel: '', startLine: 1, endLine: 1,
            code: 'x'.repeat(800_000), language: '', text: '',
        });
        expect(existingId).not.toBeNull();
        const controller = openDraft();
        const open = controller.getState();
        if (open.status !== 'open') throw new Error('expected open');
        controller.setText('y'.repeat(300_000), open.generation);
        const before = controller.getState();
        expect(controller.attach(open.generation)).toBeNull();
        expect(controller.getState()).toEqual(before);
        expect(store.getDrafts(target)).toHaveLength(1);
        expect(store.getDrafts(target)[0].id).toBe(existingId);

        controller.setText('shorter comment', open.generation);
        expect(controller.attach(open.generation)).not.toBeNull();
        expect(controller.getState().status).toBe('closed');
        expect(store.getDrafts(target)).toHaveLength(2);
        expect(store.getDrafts(target)[1].text).toBe('shorter comment');
        expect(controller.attach(open.generation)).toBeNull();
        expect(store.getDrafts(target)).toHaveLength(2);
    });

    test('a rejected insert-and-attach retains the transcript for a later retry', () => {
        const controller = openDraft();
        const open = controller.getState();
        if (open.status !== 'open') throw new Error('expected open');
        controller.setText('typed first', open.generation);
        expect(controller.insertAndAttach('x'.repeat(1_048_576), open.generation)).toBeNull();
        const rejected = controller.getState();
        if (rejected.status !== 'open') throw new Error('expected open');
        expect(rejected.quote).toEqual(open.quote);
        expect(rejected.text.startsWith('typed first ')).toBe(true);
        expect(rejected.text.length).toBeGreaterThan(1_048_576);
        expect(useInlineCommentDraftStore.getState().drafts).toEqual({});
        controller.setText('edited transcript', open.generation);
        expect(controller.attach(open.generation)?.draft.text).toBe('edited transcript');
    });

    test('open replaces an existing comment with a new generation', () => {
        const controller = openDraft();
        const first = controller.getState();
        if (first.status !== 'open') throw new Error('expected open');
        controller.setText('draft one', first.generation);

        if (!controller.open(quote({ plainText: 'second', markdownText: 'second' }))) {
            throw new Error('open rejected');
        }
        const second = controller.getState();
        expect(second.status).toBe('open');
        if (second.status !== 'open') throw new Error('expected open');
        expect(second.text).toBe('');
        expect(second.generation).not.toBe(first.generation);
    });
});

describe('isSameMobileCommentScope', () => {
    test('compares runtime, directory and session', () => {
        expect(isSameMobileCommentScope(scope(), scope())).toBe(true);
        expect(isSameMobileCommentScope(scope(), scope({ runtimeKey: 'other' }))).toBe(false);
        expect(isSameMobileCommentScope(scope(), scope({ directory: '/repo/wt' }))).toBe(false);
        expect(isSameMobileCommentScope(scope(), scope({ sessionKey: 'draft' }))).toBe(false);
    });
});

describe('applyMobileCommentAttach', () => {
    test('writes one chat-quote draft into the captured session bucket only', () => {
        const controller = openDraft();
        const open = controller.getState();
        if (open.status !== 'open') throw new Error('expected open');
        controller.setText('look here', open.generation);
        const plan = controller.attach(open.generation);
        if (!plan) throw new Error('expected plan');

        // Seed a sibling session bucket: the comment must not touch it.
        const other = scope({ sessionKey: 'session-2' });
        useInlineCommentDraftStore.getState().addDraft(
            { directory: other.directory, sessionKey: other.sessionKey },
            { source: 'chat-quote', fileLabel: '', startLine: 1, endLine: 1, code: 'other', language: '', text: '' },
        );

        const key = getInlineCommentDraftKey(getRuntimeKey(), plan.target.directory, plan.target.sessionKey);
        const drafts = key ? useInlineCommentDraftStore.getState().drafts[key] ?? [] : [];
        expect(drafts).toHaveLength(1);
        if (drafts[0]) {
            expect(drafts[0].source).toBe('chat-quote');
            expect(drafts[0].code).toBe('**plain selection**');
            expect(drafts[0].text).toBe('look here');
        }

        const otherKey = getInlineCommentDraftKey(getRuntimeKey(), other.directory, other.sessionKey);
        const otherDrafts = otherKey ? useInlineCommentDraftStore.getState().drafts[otherKey] ?? [] : [];
        expect(otherDrafts).toHaveLength(1);
        expect(otherDrafts[0].code).toBe('other');
    });

    test('drops a plan whose runtime no longer matches instead of re-targeting it', () => {
        const target = { directory: '/repo/main', sessionKey: 'session-1' };
        const stalePlan: MobileCommentAttachPlan = {
            scope: scope({ runtimeKey: 'previous-runtime' }),
            target,
            draft: { source: 'chat-quote', fileLabel: '', startLine: 1, endLine: 1, code: 'quote', language: '', text: '' },
        };
        expect(applyMobileCommentAttach(stalePlan)).toBe(false);

        const key = getInlineCommentDraftKey(getRuntimeKey(), target.directory, target.sessionKey);
        const bucket = key ? useInlineCommentDraftStore.getState().drafts[key] : null;
        expect(bucket === undefined || bucket === null).toBe(true);
    });

    test('comment lifecycle leaves the normal prompt draft and attachments untouched', () => {
        // The normal composer's state lives in the input store; nothing in the
        // comment lifecycle may write to it (isolation by construction, but
        // the contract is load-bearing enough to pin).
        useInputStore.getState().setPendingInputText('normal draft', 'replace');
        const before = {
            pendingInputText: useInputStore.getState().pendingInputText,
            attachedFiles: useInputStore.getState().attachedFiles,
        };

        const controller = openDraft();
        const open = controller.getState();
        if (open.status !== 'open') throw new Error('expected open');
        controller.setText('comment text', open.generation);
        controller.attach(open.generation);

        expect(useInputStore.getState().pendingInputText).toEqual(before.pendingInputText);
        expect(useInputStore.getState().attachedFiles).toEqual(before.attachedFiles);
    });
});

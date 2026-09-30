import { describe, expect, test } from 'bun:test';

import {
    peekMessageFocus,
    releaseMessageFocusOutside,
    requestMessageFocus,
    settleMessageFocus,
    subscribeMessageFocus,
} from './messageFocus';

describe('message focus requests', () => {
    test('stands for its own session until settled', () => {
        requestMessageFocus('ses_a', 'msg_1');

        expect(peekMessageFocus('ses_b')).toBeNull();
        // Every timeline that enters the session (a re-selection under the
        // real directory mounts a new one) finds the same request.
        const request = peekMessageFocus('ses_a');
        expect(request?.messageId).toBe('msg_1');
        expect(peekMessageFocus('ses_a')).toBe(request);
        if (request) settleMessageFocus(request);
        expect(peekMessageFocus('ses_a')).toBeNull();
    });

    test('settling an older link keeps a newer one', () => {
        requestMessageFocus('ses_a', 'msg_1');
        const older = peekMessageFocus('ses_a');
        requestMessageFocus('ses_a', 'msg_2');
        if (older) settleMessageFocus(older);
        const newer = peekMessageFocus('ses_a');
        expect(newer?.messageId).toBe('msg_2');
        if (newer) settleMessageFocus(newer);
    });

    test('a repeated link is a new request', () => {
        requestMessageFocus('ses_a', 'msg_1');
        const first = peekMessageFocus('ses_a');
        requestMessageFocus('ses_a', 'msg_1');
        const second = peekMessageFocus('ses_a');
        expect(second?.serial).not.toBe(first?.serial);
        if (second) settleMessageFocus(second);
    });

    test('entering another session drops it, re-entering its own keeps it', () => {
        requestMessageFocus('ses_a', 'msg_1');
        releaseMessageFocusOutside('ses_a');
        expect(peekMessageFocus('ses_a')?.messageId).toBe('msg_1');
        releaseMessageFocusOutside('ses_b');
        expect(peekMessageFocus('ses_a')).toBeNull();
    });

    test('keeps only the newest request and notifies listeners', () => {
        let notified = 0;
        const unsubscribe = subscribeMessageFocus(() => { notified += 1; });
        requestMessageFocus('ses_a', 'msg_1');
        requestMessageFocus('ses_a', 'msg_2');
        unsubscribe();

        expect(notified).toBe(2);
        const request = peekMessageFocus('ses_a');
        expect(request?.messageId).toBe('msg_2');
        if (request) settleMessageFocus(request);
    });

    test('ignores identifiers outside the link alphabet', () => {
        requestMessageFocus('ses_a', 'msg"]');
        expect(peekMessageFocus('ses_a')).toBeNull();
    });
});

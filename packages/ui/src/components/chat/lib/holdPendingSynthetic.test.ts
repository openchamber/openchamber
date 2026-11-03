import { describe, expect, test } from 'bun:test';
import type { Message } from '@/lib/opencode/model';
import { holdPendingSynthetic } from './holdPendingSynthetic';

const record = (info: Message) => ({ info, parts: [] });

const synthetic = (id: string, pending?: true) => record({
    id, sessionID: 's', role: 'synthetic', time: { created: 2 }, text: 'result', pending,
});

const user = record({ id: 'u', sessionID: 's', role: 'user', time: { created: 1 } });

describe('holdPendingSynthetic', () => {
    test('leaves out a background message still in the inbox', () => {
        expect(holdPendingSynthetic([user, synthetic('waiting', true)])).toEqual([user]);
    });

    test('keeps a delivered background message', () => {
        const delivered = synthetic('delivered');
        expect(holdPendingSynthetic([user, delivered])).toEqual([user, delivered]);
    });

    test('keeps the array when nothing is held', () => {
        const records = [user, synthetic('delivered')];
        expect(holdPendingSynthetic(records)).toBe(records);
    });
});

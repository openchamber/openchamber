import { afterEach, describe, expect, mock, test } from 'bun:test';

type FocusEvent = { id: string; state: 'paused' | 'gained' | 'lost' };
let handler: (event: FocusEvent) => void;
let owner = '';
let grant: Promise<{ granted: boolean }>;
const released: string[] = [];
mock.module('@capacitor/core', () => ({
    registerPlugin: () => ({
        acquire: async ({ id }: { id: string }) => { owner = id; return grant; },
        release: async ({ id }: { id: string }) => { released.push(id); },
        addListener: async (_event: string, callback: typeof handler) => {
            handler = callback;
            return { remove: async () => {} };
        },
    }),
}));
mock.module('@/lib/platform', () => ({ getClientPlatform: () => 'android' }));

const { startFocusedReading } = await import('./readingAudioFocus');
const { isCurrentReading, stopActiveReading } = await import('./activeReading');
const controls = { pause: () => {}, resume: () => {} };

afterEach(() => {
    stopActiveReading();
    released.length = 0;
});

describe('focused reading lifecycle', () => {
    test('denied focus prevents the preview from starting', async () => {
        grant = Promise.resolve({ granted: false });
        const preview = startFocusedReading('preview', () => {});
        let started = false;
        await expect((async () => {
            await preview.beforePlayback(controls);
            started = true;
        })()).rejects.toThrow('Audio focus was not granted');
        preview.finish();
        expect(started).toBe(false);
        expect(isCurrentReading(preview.token)).toBe(false);
        expect(released).toEqual([owner]);
    });

    test('permanent loss stops only this preview; stale events leave its replacement alone', async () => {
        grant = Promise.resolve({ granted: true });
        let stops = 0;
        const preview = startFocusedReading('preview', () => { stops += 1; });
        await preview.beforePlayback(controls);
        const previousHandler = handler;
        const previousOwner = owner;
        handler({ id: owner, state: 'lost' });
        expect(stops).toBe(1);
        expect(isCurrentReading(preview.token)).toBe(false);
        const replacement = startFocusedReading('preview', () => { stops += 1; });
        await replacement.beforePlayback(controls);
        previousHandler({ id: previousOwner, state: 'gained' });
        previousHandler({ id: previousOwner, state: 'lost' });
        preview.finish();
        expect(stops).toBe(1);
        expect(isCurrentReading(replacement.token)).toBe(true);
    });

    test('a focus grant arriving after Stop cannot start a preview', async () => {
        let resolveGrant!: (value: { granted: boolean }) => void;
        grant = new Promise((resolve) => { resolveGrant = resolve; });
        const preview = startFocusedReading('preview', () => {});
        const pending = preview.beforePlayback(controls);
        await Promise.resolve();
        preview.stop();
        resolveGrant({ granted: true });
        await expect(pending).rejects.toThrow('Reading stopped');
        expect(isCurrentReading(preview.token)).toBe(false);
    });

    test('transient interruption keeps the preview active until gain or explicit stop', async () => {
        grant = Promise.resolve({ granted: true });
        let paused = false;
        let stops = 0;
        const preview = startFocusedReading('preview', () => { stops += 1; });
        await preview.beforePlayback({ pause: () => { paused = true; }, resume: () => { paused = false; } });
        handler({ id: owner, state: 'paused' });
        expect(paused).toBe(true);
        expect(stops).toBe(0);
        expect(isCurrentReading(preview.token)).toBe(true);
        handler({ id: owner, state: 'gained' });
        expect(paused).toBe(false);
        preview.stop();
        handler({ id: owner, state: 'gained' });
        expect(stops).toBe(1);
    });
});

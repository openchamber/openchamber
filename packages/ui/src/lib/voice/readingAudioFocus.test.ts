import { afterEach, describe, expect, test } from 'bun:test';
import { createReadingAudioFocus } from './readingAudioFocus';
import { createReadingPlaybackGuard, isCurrentReading, startReading, stopActiveReading } from './activeReading';

const deferred = <T>() => {
    let settle: (value: T) => void = () => {};
    const promise = new Promise<T>((resolve) => { settle = resolve; });
    return { promise, resolve: (value: T) => settle(value) };
};

const native = () => {
    const acquired: string[] = [];
    const released: string[] = [];
    const handlers: Array<(event: { id: string; state: 'paused' | 'gained' | 'lost' }) => void> = [];
    let removed = 0;
    const plugin = {
        acquire: async ({ id }: { id: string }) => {
            acquired.push(id);
            return { granted: true };
        },
        release: async ({ id }: { id: string }) => { released.push(id); },
        addListener: async (_event: 'focusChanged', handler: (event: { id: string; state: 'paused' | 'gained' | 'lost' }) => void) => {
            handlers.push(handler);
            return { remove: async () => { removed += 1; } };
        },
    };
    return { plugin, acquired, released, handlers, get removed() { return removed; } };
};

afterEach(stopActiveReading);

describe('reading audio focus', () => {
    test('other runtimes keep their existing audio policy', async () => {
        const focus = createReadingAudioFocus(() => {}, null);
        await focus.prepare();
        focus.release();
        await expect(focus.prepare()).rejects.toThrow('Reading stopped');
    });

    test('one acquisition covers all chunks and release is idempotent', async () => {
        const bridge = native();
        const focus = createReadingAudioFocus(() => {}, bridge.plugin);
        await Promise.all([focus.prepare(), focus.prepare()]);
        await focus.prepare();
        expect(bridge.acquired.length).toBe(1);
        focus.release();
        focus.release();
        expect(bridge.released).toEqual(bridge.acquired);
        expect(bridge.removed).toBe(1);
    });

    test('denied and malformed results prevent playback and clean up', async () => {
        // JSON models the untyped native bridge, including a broken native payload.
        for (const payload of ['{"granted":false}', '{"unexpected":true}']) {
            const bridge = native();
            bridge.plugin.acquire = async ({ id }) => { bridge.acquired.push(id); return JSON.parse(payload); };
            const focus = createReadingAudioFocus(() => {}, bridge.plugin);
            await expect(focus.prepare()).rejects.toThrow();
            expect(bridge.released).toEqual(bridge.acquired);
            expect(bridge.removed).toBe(1);
        }
    });

    test('a bridge error prevents playback and removes the listener', async () => {
        const bridge = native();
        bridge.plugin.acquire = async () => { throw new Error('bridge unavailable'); };
        const focus = createReadingAudioFocus(() => {}, bridge.plugin);
        await expect(focus.prepare()).rejects.toThrow('bridge unavailable');
        expect(bridge.removed).toBe(1);
    });

    test('stopping while listener registration is pending never requests focus', async () => {
        const bridge = native();
        const registration = deferred<{ remove: () => Promise<void> }>();
        let removed = 0;
        bridge.plugin.addListener = () => registration.promise;
        const focus = createReadingAudioFocus(() => {}, bridge.plugin);
        const pending = focus.prepare();
        focus.release();
        registration.resolve({ remove: async () => { removed += 1; } });
        await expect(pending).rejects.toThrow('Reading stopped');
        expect(bridge.acquired.length).toBe(0);
        expect(removed).toBe(1);
    });

    test('a late focus grant after stop is released and cannot start speech', async () => {
        const bridge = native();
        const grant = deferred<{ granted: boolean }>();
        bridge.plugin.acquire = async ({ id }) => { bridge.acquired.push(id); return grant.promise; };
        const focus = createReadingAudioFocus(() => {}, bridge.plugin);
        const pending = focus.prepare();
        await Promise.resolve();
        focus.release();
        grant.resolve({ granted: true });
        await expect(pending).rejects.toThrow('Reading stopped');
        expect(bridge.released).toEqual([bridge.acquired[0], bridge.acquired[0]]);
        expect(bridge.removed).toBe(1);
    });

    test('only loss for the current lease stops the reading', async () => {
        const bridge = native();
        const focus = createReadingAudioFocus(() => stopActiveReading(), bridge.plugin);
        const token = startReading('manual', focus.release);
        const beforePlayback = createReadingPlaybackGuard(token, undefined, focus.prepare);
        await beforePlayback();
        bridge.handlers[0]({ id: 'another-reading', state: 'lost' });
        bridge.handlers[0](JSON.parse('{"malformed":true}'));
        expect(isCurrentReading(token)).toBe(true);
        bridge.handlers[0]({ id: bridge.acquired[0], state: 'lost' });
        expect(isCurrentReading(token)).toBe(false);
        expect(bridge.released).toEqual(bridge.acquired);
        await expect(beforePlayback()).rejects.toThrow('Reading cancelled');
    });

    test('replacing a reading during a focus request leaves its replacement active', async () => {
        const bridge = native();
        const grant = deferred<{ granted: boolean }>();
        bridge.plugin.acquire = async () => grant.promise;
        const focus = createReadingAudioFocus(() => {}, bridge.plugin);
        const token = startReading('old', focus.release);
        const pending = createReadingPlaybackGuard(token, undefined, focus.prepare)();
        await Promise.resolve();
        const replacement = startReading('new', () => {});
        grant.resolve({ granted: true });
        await expect(pending).rejects.toThrow();
        expect(isCurrentReading(replacement)).toBe(true);
        stopActiveReading();
    });

    test('automatic eligibility is rechecked after asynchronous focus acquisition', async () => {
        const bridge = native();
        const grant = deferred<{ granted: boolean }>();
        bridge.plugin.acquire = async ({ id }) => { bridge.acquired.push(id); return grant.promise; };
        let eligible = true;
        const focus = createReadingAudioFocus(() => stopActiveReading(), bridge.plugin);
        const token = startReading('automatic', focus.release);
        const pending = createReadingPlaybackGuard(token, () => eligible, focus.prepare)();
        await Promise.resolve();
        eligible = false;
        grant.resolve({ granted: true });
        await expect(pending).rejects.toThrow('Reading cancelled');
        expect(isCurrentReading(token)).toBe(false);
        expect(bridge.released).toEqual(bridge.acquired);
    });

    test('events for a released lease cannot stop a later reading', async () => {
        const bridge = native();
        const focus = createReadingAudioFocus(() => stopActiveReading(), bridge.plugin);
        const token = startReading('old', focus.release);
        await createReadingPlaybackGuard(token, undefined, focus.prepare)();
        const replacement = startReading('new', () => {});
        bridge.handlers[0]({ id: bridge.acquired[0], state: 'lost' });
        expect(isCurrentReading(replacement)).toBe(true);
        stopActiveReading();
    });

    test('transient loss pauses the same player and gain resumes it without releasing focus', async () => {
        const bridge = native();
        let stopped = false;
        const events: string[] = [];
        const focus = createReadingAudioFocus(() => { stopped = true; }, bridge.plugin);
        await focus.prepare();
        await focus.connect({
            pause: () => { events.push('pause'); },
            resume: () => { events.push('resume'); },
        });
        bridge.handlers[0]({ id: bridge.acquired[0], state: 'paused' });
        expect(bridge.released).toEqual([]);
        expect(stopped).toBe(false);
        bridge.handlers[0]({ id: bridge.acquired[0], state: 'gained' });
        expect(events).toEqual(['pause', 'resume']);
        bridge.handlers[0]({ id: bridge.acquired[0], state: 'lost' });
        expect(stopped).toBe(true);
        expect(bridge.released).toEqual(bridge.acquired);
        bridge.handlers[0]({ id: bridge.acquired[0], state: 'gained' });
        expect(events).toHaveLength(2);
    });

    test('preparation finishing during transient loss waits for gain', async () => {
        const bridge = native();
        const focus = createReadingAudioFocus(() => {}, bridge.plugin);
        await focus.prepare();
        bridge.handlers[0]({ id: bridge.acquired[0], state: 'paused' });
        let connected = false;
        const pending = focus.connect({ pause: () => {}, resume: () => {} }).then(() => { connected = true; });
        await Promise.resolve();
        expect(connected).toBe(false);
        bridge.handlers[0]({ id: bridge.acquired[0], state: 'gained' });
        await pending;
        expect(connected).toBe(true);
        expect(bridge.acquired).toHaveLength(1);
        focus.release();
    });

    test('Stop during a transient interruption prevents late playback', async () => {
        const bridge = native();
        const focus = createReadingAudioFocus(() => {}, bridge.plugin);
        await focus.prepare();
        bridge.handlers[0]({ id: bridge.acquired[0], state: 'paused' });
        const pending = focus.connect({ pause: () => {}, resume: () => {} });
        focus.release();
        await expect(pending).rejects.toThrow('Reading stopped');
    });

    test('automatic eligibility is rechecked after waiting for focus to return', async () => {
        const bridge = native();
        const focus = createReadingAudioFocus(stopActiveReading, bridge.plugin);
        const token = startReading('automatic', focus.release);
        let eligible = true;
        await focus.prepare();
        bridge.handlers[0]({ id: bridge.acquired[0], state: 'paused' });
        const guard = createReadingPlaybackGuard(token, () => eligible, async () => {
            await focus.prepare();
            await focus.connect({ pause: () => {}, resume: () => {} });
        });
        const pending = guard();
        eligible = false;
        bridge.handlers[0]({ id: bridge.acquired[0], state: 'gained' });
        await expect(pending).rejects.toThrow('Reading cancelled');
    });
});

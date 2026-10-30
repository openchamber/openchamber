import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { z } from 'zod';
import { getClientPlatform } from '@/lib/platform';
import { createReadingPlaybackGuard, finishReading, isCurrentReading, startReading, stopActiveReading } from '../activeReading';

interface ReadingAudioFocusPlugin {
    acquire(options: { id: string }): Promise<{ granted: boolean }>;
    release(options: { id: string }): Promise<void>;
    addListener(event: 'focusChanged', handler: (event: { id: string; state: 'paused' | 'gained' | 'lost' }) => void): Promise<PluginListenerHandle>;
}

export interface ReadingPlayback {
    pause: () => void | Promise<void>;
    resume: () => void | Promise<void>;
}

const NativeFocus = registerPlugin<ReadingAudioFocusPlugin>('ReadingAudioFocus');
const grantSchema = z.object({ granted: z.boolean() });
const changeSchema = z.object({ id: z.string(), state: z.enum(['paused', 'gained', 'lost']) });

/** A reading-scoped lease. Other runtimes leave audio policy to their existing players. */
export const createReadingAudioFocus = (
    onLoss: () => void,
    plugin: ReadingAudioFocusPlugin | null = getClientPlatform() === 'android' ? NativeFocus : null,
) => {
    const id = plugin ? crypto.randomUUID() : '';
    let disposed = false;
    let listener: PluginListenerHandle | undefined;
    let preparation: Promise<void> | undefined;
    let paused = false;
    let playback: ReadingPlayback | undefined;
    let wake: (() => void) | undefined;
    let waiting: Promise<void> | undefined;

    const fail = () => {
        if (disposed) return;
        release();
        onLoss();
    };

    const release = () => {
        if (disposed) return;
        disposed = true;
        wake?.();
        if (!plugin) return;
        void plugin.release({ id }).catch((error) => console.warn('[ReadingAudioFocus] Release failed:', error));
        void listener?.remove().catch((error) => console.warn('[ReadingAudioFocus] Listener cleanup failed:', error));
    };

    const prepare = (): Promise<void> => {
        if (disposed) return Promise.reject(new DOMException('Reading stopped', 'AbortError'));
        if (!plugin) return Promise.resolve();
        preparation ??= (async () => {
            try {
                listener = await plugin.addListener('focusChanged', (event) => {
                    const change = changeSchema.safeParse(event);
                    if (disposed || !change.success || change.data.id !== id) return;
                    if (change.data.state === 'lost') return fail();
                    paused = change.data.state === 'paused';
                    if (paused) {
                        waiting ??= new Promise<void>((resolve) => { wake = resolve; });
                    } else {
                        wake?.();
                        waiting = undefined;
                        wake = undefined;
                    }
                    if (playback) {
                        try {
                            void Promise.resolve(paused ? playback.pause() : playback.resume()).catch(fail);
                        } catch {
                            fail();
                        }
                    }
                });
                if (disposed) {
                    await listener.remove();
                    throw new DOMException('Reading stopped', 'AbortError');
                }
                const result = grantSchema.parse(await plugin.acquire({ id }));
                if (disposed) {
                    // The request may have completed after an earlier release crossed the bridge.
                    await plugin.release({ id });
                    throw new DOMException('Reading stopped', 'AbortError');
                }
                if (!result.granted) throw new Error('Audio focus was not granted');
            } catch (error) {
                release();
                throw error;
            }
        })();
        return preparation;
    };

    const connect = async (controls: ReadingPlayback) => {
        playback = controls;
        while (paused && !disposed) await waiting;
        if (disposed) throw new DOMException('Reading stopped', 'AbortError');
    };

    return { prepare, connect, release };
};

export const startFocusedReading = (key: string, stopPlayback: () => void, canStart?: () => boolean) => {
    const focus = createReadingAudioFocus(() => {
        if (isCurrentReading(token)) stopActiveReading();
    });
    const token = startReading(key, () => {
        focus.release();
        stopPlayback();
    });
    return {
        token,
        beforePlayback: createReadingPlaybackGuard<ReadingPlayback>(token, canStart, async (playback) => {
            await focus.prepare();
            await focus.connect(playback);
        }),
        finish: () => {
            focus.release();
            finishReading(token);
        },
        stop: () => {
            if (isCurrentReading(token)) stopActiveReading();
        },
    };
};

import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { z } from 'zod';
import { getClientPlatform } from '@/lib/platform';

interface ReadingAudioFocusPlugin {
    acquire(options: { id: string }): Promise<{ granted: boolean }>;
    release(options: { id: string }): Promise<void>;
    addListener(event: 'focusLost', handler: (event: { id: string }) => void): Promise<PluginListenerHandle>;
}

const NativeFocus = registerPlugin<ReadingAudioFocusPlugin>('ReadingAudioFocus');
const grantSchema = z.object({ granted: z.boolean() });
const lossSchema = z.object({ id: z.string() });

/** A reading-scoped lease. Other runtimes leave audio policy to their existing players. */
export const createReadingAudioFocus = (
    onLoss: () => void,
    plugin: ReadingAudioFocusPlugin | null = getClientPlatform() === 'android' ? NativeFocus : null,
) => {
    const id = plugin ? crypto.randomUUID() : '';
    let disposed = false;
    let listener: PluginListenerHandle | undefined;
    let preparation: Promise<void> | undefined;

    const release = () => {
        if (disposed) return;
        disposed = true;
        if (!plugin) return;
        void plugin.release({ id }).catch((error) => console.warn('[ReadingAudioFocus] Release failed:', error));
        void listener?.remove().catch((error) => console.warn('[ReadingAudioFocus] Listener cleanup failed:', error));
    };

    const prepare = (): Promise<void> => {
        if (disposed) return Promise.reject(new DOMException('Reading stopped', 'AbortError'));
        if (!plugin) return Promise.resolve();
        preparation ??= (async () => {
            try {
                listener = await plugin.addListener('focusLost', (event) => {
                    const loss = lossSchema.safeParse(event);
                    if (!disposed && loss.success && loss.data.id === id) {
                        release();
                        onLoss();
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

    return { prepare, release };
};

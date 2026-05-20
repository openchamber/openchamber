import { describe, expect, test } from 'bun:test';

import { disposePreviewAudio } from './voicePreviewAudio';

type MockAudio = Pick<HTMLAudioElement, 'load' | 'pause' | 'removeAttribute' | 'src'> & {
    loadCalls: number;
    paused: boolean;
    removedAttributes: string[];
};

const createMockAudio = (src: string): MockAudio => {
    const audio: MockAudio = {
        src,
        loadCalls: 0,
        paused: false,
        removedAttributes: [],
        load: () => {
            audio.loadCalls += 1;
        },
        pause: () => {
            audio.paused = true;
        },
        removeAttribute: (name: string) => {
            audio.removedAttributes.push(name);
            if (name === 'src') {
                audio.src = '';
            }
        },
    };

    return audio;
};

const withRevokedUrls = (run: (revokedUrls: string[]) => void) => {
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const revokedUrls: string[] = [];
    URL.revokeObjectURL = ((url: string) => {
        revokedUrls.push(url);
    }) as typeof URL.revokeObjectURL;

    try {
        run(revokedUrls);
    } finally {
        URL.revokeObjectURL = originalRevokeObjectURL;
    }
};

describe('disposePreviewAudio', () => {
    test('pauses audio, revokes blob URLs, and clears the source', () => {
        withRevokedUrls((revokedUrls) => {
            const audio = createMockAudio('blob:https://example.test/preview');

            disposePreviewAudio(audio as unknown as HTMLAudioElement);

            expect(audio.paused).toBe(true);
            expect(revokedUrls).toEqual(['blob:https://example.test/preview']);
            expect(audio.removedAttributes).toEqual(['src']);
            expect(audio.loadCalls).toBe(1);
            expect(audio.src).toBe('');
        });
    });

    test('does not revoke non-blob URLs', () => {
        withRevokedUrls((revokedUrls) => {
            const audio = createMockAudio('https://example.test/preview.mp3');

            disposePreviewAudio(audio as unknown as HTMLAudioElement);

            expect(audio.paused).toBe(true);
            expect(revokedUrls).toEqual([]);
            expect(audio.removedAttributes).toEqual(['src']);
            expect(audio.loadCalls).toBe(1);
        });
    });

    test('ignores missing audio', () => {
        let threw = false;
        try {
            disposePreviewAudio(null);
        } catch {
            threw = true;
        }

        expect(threw).toBe(false);
    });
});

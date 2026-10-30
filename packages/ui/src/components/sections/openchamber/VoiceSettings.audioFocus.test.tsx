import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import React, { act, type PropsWithChildren } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const dom = new Window();
Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    HTMLElement: dom.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
});

const state = {
    voiceProvider: 'openai-compatible',
    openaiCompatibleUrl: 'https://voice.example.test/v1',
    openaiCompatibleVoice: 'test-voice',
    openaiCompatibleTtsModel: 'test-model',
    showMessageTTSButtons: true,
    speechRate: 1,
    speechPitch: 1,
    speechVolume: 1,
    voiceApiKeys: {},
    refreshVoiceApiKeys: async () => {},
};
mock.module('@/stores/useConfigStore', () => ({
    useConfigStore: Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state }),
}));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/hooks/useLocalTTS', () => ({ useLocalTTS: () => ({}) }));
mock.module('@/lib/voice/browserVoiceService', () => ({ browserVoiceService: { waitForVoices: async () => [] } }));
mock.module('@/stores/useSmallModelStore', () => ({ useSmallModelStore: () => ({}), selectSmallModelAvailability: () => false }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: () => ({}) }));
mock.module('@/components/sections/classification/JevAccessNote', () => ({ SettingsInlineLink: () => null }));
mock.module('@/components/ui', () => ({ toast: { error: () => {} } }));
mock.module('@/components/icon/Icon', () => ({ Icon: ({ name }: { name: string }) => <span data-icon={name} /> }));
mock.module('@/components/ui/select', () => ({
    Select: () => null, SelectContent: () => null, SelectItem: () => null,
    SelectTrigger: () => null, SelectValue: () => null,
}));
const Wrapper = ({ children }: PropsWithChildren) => <div>{children}</div>;
mock.module('@/components/sections/shared/SettingsSection', () => ({
    SettingsSection: Wrapper, SettingsFieldRow: Wrapper, SettingsStackedField: Wrapper,
    SettingsCheckboxRow: () => null, SettingsChipGroup: () => null,
    SETTINGS_NUMBER_INPUT_CLASS: '', SETTINGS_SELECT_ROW_TRIGGER_CLASS: '', SETTINGS_CONTROL_CLUSTER_CLASS: '',
    SETTINGS_HELPER_CLASS: '', SETTINGS_ICON_BUTTON_CLASS: '', SETTINGS_OPTION_STACK_CLASS: '',
}));

type FocusEvent = { id: string; state: 'paused' | 'gained' | 'lost' };
let handler: (event: FocusEvent) => void;
let owner = '';
let granted = true;
const released: string[] = [];
mock.module('@capacitor/core', () => ({
    registerPlugin: () => ({
        acquire: async ({ id }: { id: string }) => { owner = id; return { granted }; },
        release: async ({ id }: { id: string }) => { released.push(id); },
        addListener: async (_event: string, callback: typeof handler) => {
            handler = callback;
            return { remove: async () => {} };
        },
    }),
}));
mock.module('@/lib/platform', () => ({ getClientPlatform: () => 'android' }));

const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
let response = deferred<Response>();
const requests: Array<{ path: string; method?: string }> = [];
mock.module('@/lib/runtime-fetch', () => ({
    runtimeFetch: (path: string, options?: RequestInit) => {
        if (options?.method !== 'POST') return Promise.resolve(Response.json({ available: true }));
        requests.push({ path, method: options.method });
        return response.promise;
    },
}));

const { VoiceSettings } = await import('./VoiceSettings');
const { stopActiveReading } = await import('@/lib/voice/activeReading');

let root: Root;
let host: HTMLDivElement;
let players: HTMLAudioElement[];
let pendingPlay: ReturnType<typeof deferred<void>> | undefined;
let playCalls: number;
let pauseCalls: number;
let playError: Error | undefined;
let pause: () => void;
const originalAudio = globalThis.Audio;
const originalCreateURL = URL.createObjectURL;
const originalRevokeURL = URL.revokeObjectURL;
const revoked: string[] = [];
const previewButton = () => {
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="settings.voice.page.actions.preview"]');
    if (!button) throw new Error('Missing Settings preview button');
    return button;
};
const clickPreview = () => act(async () => { previewButton().click(); });
const focus = (value: FocusEvent['state']) => act(async () => { handler({ id: owner, state: value }); });
const respond = () => act(async () => { response.resolve(new Response(new Blob(['audio']))); });

beforeEach(async () => {
    response = deferred<Response>();
    requests.length = 0;
    players = [];
    pendingPlay = undefined;
    granted = true;
    released.length = 0;
    revoked.length = 0;
    playCalls = 0;
    pauseCalls = 0;
    playError = undefined;
    pause = () => { pendingPlay?.reject(new DOMException('Play interrupted by pause', 'AbortError')); };
    Object.assign(globalThis, {
        Audio: function (src: string) {
            const player = document.createElement('audio');
            player.src = src;
            player.play = async () => {
                playCalls += 1;
                if (playError) throw playError;
                await pendingPlay?.promise;
            };
            player.pause = () => { pauseCalls += 1; pause(); };
            player.load = () => {};
            players.push(player);
            return player;
        },
    });
    URL.createObjectURL = () => 'blob:settings-preview';
    URL.revokeObjectURL = (url: string) => { revoked.push(url); };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root.render(<VoiceSettings />); });
});

afterEach(async () => {
    await act(async () => { root.unmount(); stopActiveReading(); });
    host.remove();
    globalThis.Audio = originalAudio;
    URL.createObjectURL = originalCreateURL;
    URL.revokeObjectURL = originalRevokeURL;
});

test('Settings Stop during fetch prevents late playback and releases the prepared audio', async () => {
    await clickPreview();
    expect(requests).toEqual([{ path: '/api/tts/speak', method: 'POST' }]);
    expect(previewButton().querySelector('[data-icon="stop"]')).not.toBeNull();
    await clickPreview();
    await respond();
    expect(playCalls).toBe(0);
    expect(players[0].getAttribute('src')).toBeNull();
    expect(revoked).toEqual(['blob:settings-preview']);
    expect(previewButton().querySelector('[data-icon="play"]')).not.toBeNull();
});

test('Settings preview keeps a pending play through transient loss and resumes the same position', async () => {
    pendingPlay = deferred<void>();
    await clickPreview();
    await respond();
    expect(playCalls).toBe(1);
    players[0].currentTime = 2.5;
    await focus('paused');
    expect(pauseCalls).toBe(1);
    expect(revoked).toEqual([]);
    expect(released).toEqual([]);
    expect(previewButton().querySelector('[data-icon="stop"]')).not.toBeNull();
    pendingPlay = undefined;
    await focus('gained');
    expect(playCalls).toBe(2);
    expect(players).toHaveLength(1);
    expect(players[0].currentTime).toBe(2.5);
    await clickPreview();
    expect(released).toEqual([owner]);
    expect(revoked).toEqual(['blob:settings-preview']);
});

test('gain before the interrupted play rejects cannot finish a resumed Settings preview', async () => {
    pendingPlay = deferred<void>();
    pause = () => {};
    await clickPreview();
    await respond();
    await focus('paused');
    const firstPlay = pendingPlay;
    pendingPlay = undefined;
    await focus('gained');
    await act(async () => { firstPlay.reject(new DOMException('Interrupted play', 'AbortError')); });
    expect(playCalls).toBe(2);
    expect(released).toEqual([]);
    expect(revoked).toEqual([]);
    expect(previewButton().querySelector('[data-icon="stop"]')).not.toBeNull();
});

test('Settings preview still cleans up a genuine playback failure', async () => {
    playError = new DOMException('Playback blocked', 'NotAllowedError');
    await clickPreview();
    await respond();
    expect(released).toEqual([owner]);
    expect(revoked).toEqual(['blob:settings-preview']);
    expect(previewButton().querySelector('[data-icon="play"]')).not.toBeNull();
});

test('a second interruption during resume also keeps the Settings preview alive', async () => {
    await clickPreview();
    await respond();
    await focus('paused');
    pendingPlay = deferred<void>();
    await focus('gained');
    await focus('paused');
    expect(released).toEqual([]);
    expect(revoked).toEqual([]);
    pendingPlay = undefined;
    await focus('gained');
    expect(playCalls).toBe(3);
    expect(players).toHaveLength(1);
    expect(previewButton().querySelector('[data-icon="stop"]')).not.toBeNull();
});

test('an AbortError without a focus interruption still finishes the Settings preview', async () => {
    playError = new DOMException('Play aborted', 'AbortError');
    await clickPreview();
    await respond();
    expect(released).toEqual([owner]);
    expect(revoked).toEqual(['blob:settings-preview']);
    expect(previewButton().querySelector('[data-icon="play"]')).not.toBeNull();
});

test('denied focus prevents HTML audio playback through the Settings button', async () => {
    granted = false;
    await clickPreview();
    await respond();
    expect(playCalls).toBe(0);
    expect(released).toEqual([owner]);
    expect(revoked).toEqual(['blob:settings-preview']);
});

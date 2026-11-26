import { afterAll, describe, expect, test } from 'bun:test';

// The store listens for host switches on `window`, so it must exist before the
// store module loads.
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: new EventTarget() });
globalThis.fetch = Object.assign(async () => new Response(null, { status: 404 }), { preconnect: async () => {} });

const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { AUTO_SAVE_KEYS, applySettingsToStores, parseSettingsDocument } = await import('@/lib/settings/registry');
const { DEFAULT_REFERENCE_PREVIEW_DISPLAY, readReferencePreviewDisplay, useReferencePreviewDisplayStore } = await import('./useReferencePreviewDisplayStore');

afterAll(() => {
    useReferencePreviewDisplayStore.setState({ ...DEFAULT_REFERENCE_PREVIEW_DISPLAY, runtimeKey: null });
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
});

const both = () => {
    const settings = readReferencePreviewDisplay();
    return [settings.referencePreviewNewestFirst, settings.referencePreviewCollapseDescription];
};
const hostA = () => switchRuntimeEndpoint({ apiBaseUrl: 'http://host-a.test', runtimeKey: 'preview-host-a' });
const hostB = () => switchRuntimeEndpoint({ apiBaseUrl: 'http://host-b.test', runtimeKey: 'preview-host-b' });
const saved = { referencePreviewNewestFirst: true, referencePreviewCollapseDescription: true };
const empty = () => applySettingsToStores(parseSettingsDocument({}) ?? {});

describe('item preview display settings', () => {
    test('are saved explicitly, never by the auto-save sweep', () => {
        expect(AUTO_SAVE_KEYS).not.toContain('referencePreviewNewestFirst');
        expect(AUTO_SAVE_KEYS).not.toContain('referencePreviewCollapseDescription');
    });

    test('start off on a fresh host B and come back with host A saved values', () => {
        hostA();
        applySettingsToStores(saved);
        expect(both()).toEqual([true, true]);

        hostB();
        expect(both()).toEqual([false, false]);
        empty();
        expect(both()).toEqual([false, false]);
        applySettingsToStores({ referencePreviewCollapseDescription: true });
        expect(both()).toEqual([false, true]);

        hostA();
        expect(both()).toEqual([false, false]);
        applySettingsToStores(saved);
        expect(both()).toEqual([true, true]);
    });

    test('read as off when host A returns with a profile that has neither key', () => {
        hostA();
        applySettingsToStores(saved);
        hostB();
        empty();

        hostA();
        empty();
        expect(both()).toEqual([false, false]);
    });

    test('survive a reconnect to the same host', () => {
        hostA();
        applySettingsToStores(saved);
        switchRuntimeEndpoint({ apiBaseUrl: 'http://host-a.test', runtimeKey: 'preview-host-a', clientToken: 'fresh' });
        expect(both()).toEqual([true, true]);
    });
});

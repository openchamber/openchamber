import { afterEach, describe, expect, test } from 'bun:test';

import { useUIStore } from '../useUIStore';
import { createInitialUIState } from './initialState';

const DEFAULTS = {
    referencePreviewNewestFirst: false,
    referencePreviewCollapseDescription: true,
};

afterEach(() => {
    useUIStore.setState(DEFAULTS);
});

describe('preview display preferences', () => {
    test('start with the timeline oldest first and the description collapsed', () => {
        const initial = createInitialUIState();
        expect(initial.referencePreviewNewestFirst).toBe(false);
        expect(initial.referencePreviewCollapseDescription).toBe(true);
    });

    test('both switches reach the ui-store persistence allowlist', () => {
        useUIStore.getState().setReferencePreviewNewestFirst(true);
        useUIStore.getState().setReferencePreviewCollapseDescription(false);

        const saved = JSON.stringify(useUIStore.persist.getOptions().partialize?.(useUIStore.getState()));
        expect(saved).toContain('"referencePreviewNewestFirst":true');
        expect(saved).toContain('"referencePreviewCollapseDescription":false');
    });

    test('a stored profile written before the switches existed keeps the defaults', () => {
        const storedProfile = { theme: 'dark' };
        const reloaded = { ...createInitialUIState(), ...storedProfile };
        expect(reloaded.referencePreviewNewestFirst).toBe(DEFAULTS.referencePreviewNewestFirst);
        expect(reloaded.referencePreviewCollapseDescription).toBe(DEFAULTS.referencePreviewCollapseDescription);
    });
});

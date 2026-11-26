import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useInputStore } from '@/sync/input-store';
import { usePendingDraftDictation } from './usePendingDraftDictation';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
    window: browser, document: browser.document, navigator: browser.navigator,
    Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
    Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true,
});

let root: Root | null = null;
let started = 0;
const start = () => { started += 1; };

const Probe: React.FC<{ draftId: number | null; enabled?: boolean }> = ({ draftId, enabled = true }) => {
    usePendingDraftDictation({ draftId, enabled, start });
    return null;
};

const render = async (props: { draftId: number | null; enabled?: boolean }) => {
    root ??= createRoot(document.createElement('div'));
    await act(async () => root?.render(<Probe {...props} />));
};

const request = async (draftId: number) => {
    await act(async () => { useInputStore.getState().requestDraftDictation(draftId); });
};

beforeEach(() => {
    started = 0;
    useInputStore.setState({ pendingDraftDictation: null });
});

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
});

describe('usePendingDraftDictation', () => {
    test('a request for the draft on screen starts recording once', async () => {
        await request(7);
        await render({ draftId: 7 });
        await render({ draftId: 7 });

        expect(started).toBe(1);
        expect(useInputStore.getState().pendingDraftDictation).toBeNull();
    });

    test('a request made before the composer shows its draft waits for that draft', async () => {
        await render({ draftId: null });
        await request(7);
        expect(started).toBe(0);

        await render({ draftId: 6 });
        expect(started).toBe(0);
        expect(useInputStore.getState().pendingDraftDictation).toEqual({ draftId: 7 });

        await render({ draftId: 7 });
        expect(started).toBe(1);
    });

    test('a pinned composer leaves the request for the main one', async () => {
        await request(7);
        await render({ draftId: 7, enabled: false });

        expect(started).toBe(0);
        expect(useInputStore.getState().pendingDraftDictation).toEqual({ draftId: 7 });
    });
});

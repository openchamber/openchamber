import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { createListCache, revalidateReferences, useCachedList, type ListPage } from './referenceCache';

test('a mounted list checks its age again on revalidation and refreshes only when old', async () => {
    const dom = new Window({ url: 'http://localhost' });
    const globals = { window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true };
    for (const [name, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const { createRoot } = await import('react-dom/client');

    let clock = 0;
    const cache = createListCache<string>(40, () => clock);
    let calls = 0;
    const fetchPage = async (): Promise<ListPage<string>> => {
        calls += 1;
        return { kind: 'page', items: [`read ${calls}`], cursor: null, hasMore: false };
    };
    let shown: string[] = [];
    const Probe = () => {
        shown = useCachedList(cache, 'k', fetchPage).items;
        return null;
    };

    const root = createRoot(document.createElement('div'));
    await act(async () => { root.render(<Probe />); });
    expect(shown).toEqual(['read 1']);

    await act(async () => { revalidateReferences(); });
    expect(calls).toBe(1);

    clock = 5 * 60_000;
    await act(async () => { revalidateReferences(); });
    expect(calls).toBe(2);
    expect(shown).toEqual(['read 2']);

    await act(async () => { root.unmount(); });
});

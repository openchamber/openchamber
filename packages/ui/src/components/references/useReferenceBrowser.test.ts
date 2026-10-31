import { beforeAll, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

import { unknownProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import { linearLikeTrackerDescriptor } from '@/lib/trackers/descriptor.fixture';

const descriptor = {
    ...unknownProviderDescriptor('gitea'),
    features: { ...unknownProviderDescriptor('gitea').features, labels: true, milestones: true },
};

// The lists the browser hook composes: nothing listed, nothing followed.
const NO_LIST = {
    status: 'ready',
    unavailable: null,
    items: [],
    hasMore: false,
    refreshing: false,
    loadingMore: false,
    error: null,
    skipped: [],
    pageReads: [],
    followed: [],
    loadMore: () => undefined,
    retry: async () => undefined,
};

// The hook's reads are not under test; the lists it composes answer with nothing.
mock.module('@/components/references/referenceSources', () => ({
    useRepositoryAcrossProvider: () => null,
    useRepositoryAcrossReferenceList: () => NO_LIST,
    useRepositoryPullStatuses: () => () => ({ status: 'idle' }),
    useRepositoryPullStatusesAcross: () => () => ({ status: 'idle' }),
    useRepositoryReferenceDetail: () => ({ detail: { status: 'idle' }, latest: { status: 'idle' }, refresh: async () => undefined }),
    useRepositoryReferenceList: () => NO_LIST,
    useRepositoryReferenceProvider: () => 'gitea',
    useRepositorySourceStatus: () => 'ready',
    useTrackerItemDetail: () => ({ detail: { status: 'idle' }, followed: [] }),
    useTrackerReferenceList: () => NO_LIST,
}));

mock.module('@/lib/source-control/providers/registry', () => ({
    useSourceControlProvider: () => descriptor,
    useSourceControlProviderRegistry: (selector: (state: { holdsList: boolean }) => boolean) => selector({ holdsList: true }),
}));

mock.module('@/lib/trackers/registry', () => ({
    useTrackerDescriptor: () => linearLikeTrackerDescriptor(),
}));

mock.module('@/lib/trackers/sources', () => ({
    useTrackerSourceStatus: () => 'ready',
}));

mock.module('@/lib/trackedItems/interest', () => ({
    useTrackedItems: () => undefined,
}));

const { useReferenceBrowser } = await import('./useReferenceBrowser');

let createRoot: typeof import('react-dom/client').createRoot;

beforeAll(async () => {
    const dom = new Window({ url: 'http://localhost' });
    Object.assign(globalThis, {
        window: dom, document: dom.document, navigator: dom.navigator,
        Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
        IS_REACT_ACT_ENVIRONMENT: true,
    });
    ({ createRoot } = await import('react-dom/client'));
});

const renderHook = async <T,>(setup: () => T) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let current!: T;
    const probe = () => {
        current = setup();
        return null;
    };
    await act(async () => { root.render(React.createElement(probe)); });
    return {
        current: () => current,
        unmount: async () => { await act(async () => { root.unmount(); }); },
    };
};

describe('useReferenceBrowser repository filter', () => {
    test('defaults to the issues filter with empty name arrays and exposes the host features', async () => {
        const view = await renderHook(() => useReferenceBrowser({ source: 'repository', directory: '/repo', isMobile: false }));
        expect(view.current().repositoryFilter).toEqual({ state: 'open', people: 'any', labelNames: [], milestoneNames: [] });
        expect(view.current().features).toEqual({ labels: true, milestones: true });
        await view.unmount();
    });

    test('selectRepositoryFilter updates the name arrays, keeping the rest', async () => {
        const view = await renderHook(() => useReferenceBrowser({ source: 'repository', directory: '/repo', isMobile: false }));
        await act(async () => { view.current().selectRepositoryFilter({ labelNames: ['bug'] }); });
        expect(view.current().repositoryFilter).toEqual({ state: 'open', people: 'any', labelNames: ['bug'], milestoneNames: [] });
        await view.unmount();
    });
});

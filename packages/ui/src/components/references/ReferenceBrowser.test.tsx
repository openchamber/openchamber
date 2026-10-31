import { beforeAll, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import type { Label, MilestoneChoice } from '@/lib/api/types';
import { linearLikeTrackerDescriptor } from '@/lib/trackers/descriptor.fixture';

// The real dropdown menu renders its content in a portal only while open, so
// the test lays the parts out inline: the radio group forwards a picked item
// to its `onValueChange`, the way the real one does.
mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  DropdownMenuContent: ({ children, ...props }: React.ComponentProps<'div'>) => React.createElement('div', { 'data-menu-content': '', ...props }, children),
  DropdownMenuLabel: ({ children, ...props }: React.ComponentProps<'div'>) => React.createElement('div', { 'data-menu-label': '', ...props }, children),
  DropdownMenuSeparator: () => React.createElement('hr'),
  DropdownMenuRadioGroup: ({ children, value, onValueChange }: { children: React.ReactNode; value?: string; onValueChange?: (next: string) => void }) =>
    // SAFETY: the children are this mock's own radio items, and `onPick` is the prop the mock injects on them.
    React.createElement('div', { 'data-radio-group': value ?? '' },
      React.Children.map(children, (child) => React.cloneElement(child as React.ReactElement<{ onPick?: (next: string) => void }>, { onPick: (next: string) => onValueChange?.(next) })),
    ),
  DropdownMenuRadioItem: ({ children, value, onPick }: { children: React.ReactNode; value: string; onPick?: (next: string) => void }) =>
    React.createElement('button', { type: 'button', 'data-radio-value': value, onClick: () => onPick?.(value) }, children),
}));

const { ReferenceBrowserSearch } = await import('./ReferenceBrowser');
import type { ReferenceFilterOptions } from './ReferenceBrowser';
import type { ReferenceBrowser } from './useReferenceBrowser';
import type { ChoiceOptionsState } from './issueFilterOptions';
import { DEFAULT_ISSUE_FILTER, DEFAULT_TRACKER_FILTER, type IssueFilter } from './referencePickerItems';

const ready = <T,>(items: T[]): ChoiceOptionsState<T> => ({ status: 'ready', items, stale: false, error: null });

const patches: Array<Partial<IssueFilter>> = [];
const recordPatches = (patch: Partial<IssueFilter>) => patches.push(patch);

type FakeBrowser = Partial<ReferenceBrowser> & ReferenceFilterOptions;

const baseBrowser: FakeBrowser = {
    source: 'repository',
    term: 'pullRequest',
    isMobile: false,
    repositoryKind: 'issue',
    repositoryFilter: DEFAULT_ISSUE_FILTER,
    trackerFilter: DEFAULT_TRACKER_FILTER,
    trackerDescriptor: linearLikeTrackerDescriptor(),
    features: { labels: true, milestones: true },
    labelOptions: ready<Label>([{ name: 'bug', color: 'ee0701' }]),
    milestoneOptions: ready<MilestoneChoice>([{ name: 'v1.0', state: 'open' }]),
    query: '',
    setQuery: () => undefined,
    selectRepositoryFilter: recordPatches,
    handleNavigationKey: () => false,
    searchRef: { current: null },
    list: { status: 'ready', unavailable: null, items: [], hasMore: false, refreshing: false, loadingMore: false, error: null, skipped: [], pageReads: [], followed: [], loadMore: () => undefined, retry: async () => undefined },
};

// The search row reads only the parts the tests set; the rest of the hook's
// return is unused here, so the fixture stays a partial.
const browserOf = (patch: Partial<FakeBrowser> = {}): FakeBrowser => ({ ...baseBrowser, ...patch });

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

const render = async (browser: FakeBrowser) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
        // SAFETY: every prop the search row reads is set by baseBrowser and the per-test patches.
        root.render(React.createElement(I18nProvider, null, React.createElement(ReferenceBrowserSearch, { browser: browser as ReferenceBrowser & ReferenceFilterOptions, onKeyDown: () => undefined })));
    });
    return {
        text: () => host.textContent ?? '',
        radioItem: (value: string) => host.querySelector<HTMLButtonElement>(`[data-radio-value="${value}"]`),
        unmount: async () => { await act(async () => { root.unmount(); }); },
    };
};

describe('ReferenceBrowser filter menu', () => {
    test('offers the label and milestone dropdowns on a host that publishes both features', async () => {
        const view = await render(browserOf());
        const text = view.text();
        expect(text).toContain('Status');
        expect(text).toContain('People');
        expect(text).toContain('Milestone');
        expect(text).toContain('Label');
        expect(view.radioItem('bug')).toBeTruthy();
        expect(view.radioItem('v1.0')).toBeTruthy();
        await view.unmount();
    });

    test('picking a label patches the repository filter', async () => {
        patches.length = 0;
        const view = await render(browserOf());
        const item = view.radioItem('bug');
        if (!item) throw new Error('Expected the label option bug');
        await act(async () => { item.click(); });
        expect(patches).toEqual([{ labelNames: ['bug'] }]);
        await view.unmount();
    });

    test('keeps the state and people groups, without the dropdowns, on a host that publishes neither feature', async () => {
        const view = await render(browserOf({ features: { labels: false, milestones: false }, labelOptions: null, milestoneOptions: null }));
        const text = view.text();
        expect(text).toContain('Status');
        expect(text).toContain('People');
        expect(text).not.toContain('Milestone');
        expect(text).not.toContain('Label');
        expect(view.radioItem('bug')).toBeNull();
        expect(view.radioItem('v1.0')).toBeNull();
        await view.unmount();
    });

    test('keeps the state and people groups where the surface reads no options', async () => {
        // The picker's browser carries no options; the dropdowns stay out.
        const view = await render(browserOf({ labelOptions: undefined, milestoneOptions: undefined }));
        const text = view.text();
        expect(text).toContain('Status');
        expect(text).toContain('People');
        expect(text).not.toContain('Milestone');
        expect(view.radioItem('bug')).toBeNull();
        await view.unmount();
    });
});

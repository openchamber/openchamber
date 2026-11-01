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

// The real select renders its list in a portal only while open, so the test
// lays the parts out inline: the select forwards a picked item to its
// `onValueChange`, the way the real one does. The mock's `SelectValue`
// resolves the trigger text the way the real kit does — children first, then
// the value, then the placeholder while the select carries no value
// (undefined or empty) — and reads that value from the select root through
// context, the way the kit's `Value` reads its store.
mock.module('@/components/ui/select', () => {
  const selectValueContext = React.createContext<string | undefined>(undefined);
  return {
    Select: ({ children, value, onValueChange, disabled }: { children: React.ReactNode; value?: string; onValueChange?: (next: string) => void; disabled?: boolean }) =>
      React.createElement(selectValueContext.Provider, { value },
        React.createElement(React.Fragment, null,
          React.Children.map(children, (child) =>
            React.isValidElement(child)
              ? // SAFETY: the children are this mock's own trigger and content, and `onPick`/`selectDisabled` are the props the mock injects on them.
                React.cloneElement(child as React.ReactElement<{ onPick?: (next: string) => void; selectDisabled?: boolean }>, { onPick: (next: string) => onValueChange?.(next), selectDisabled: disabled })
              : child,
          ),
        ),
      ),
    SelectTrigger: ({ children, selectDisabled, ...props }: { children?: React.ReactNode; selectDisabled?: boolean } & React.ComponentProps<'button'>) =>
      React.createElement('button', { type: 'button', 'data-select-trigger': '', disabled: selectDisabled, ...props }, children),
    SelectValue: ({ children, placeholder }: { children?: React.ReactNode; placeholder?: React.ReactNode }) => {
      const selectValue = React.useContext(selectValueContext);
      const text = children !== undefined && children !== null
        ? children
        : (selectValue === undefined || selectValue === '' ? placeholder : selectValue);
      return React.createElement('span', { 'data-select-value': '' }, text);
    },
    SelectContent: ({ children, onPick }: { children?: React.ReactNode; onPick?: (next: string) => void }) =>
      React.createElement('div', { 'data-select-content': '' },
        React.Children.map(children, (child) =>
          React.isValidElement(child)
            ? // SAFETY: the children are this mock's own items, and `onPick` is the prop the mock injects on them.
              React.cloneElement(child as React.ReactElement<{ onPick?: (next: string) => void }>, { onPick })
            : child,
        ),
      ),
    SelectItem: ({ children, value, onPick, selectDisabled }: { children?: React.ReactNode; value: string; onPick?: (next: string) => void; selectDisabled?: boolean }) =>
      React.createElement('button', { type: 'button', 'data-select-item': value, disabled: selectDisabled, onClick: () => onPick?.(value) }, children),
    SelectLabel: ({ children }: { children?: React.ReactNode }) => React.createElement('div', { 'data-select-label': '' }, children),
    SelectGroup: ({ children }: { children?: React.ReactNode }) => React.createElement('div', { 'data-select-group': '' }, children),
    SelectSeparator: () => React.createElement('hr'),
  };
});

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
        selectTriggers: () => Array.from(host.querySelectorAll<HTMLButtonElement>('[data-select-trigger]')),
        selectItem: (value: string) => host.querySelector<HTMLButtonElement>(`[data-select-item="${value}"]`),
        selectItems: (value: string) => Array.from(host.querySelectorAll<HTMLButtonElement>(`[data-select-item="${value}"]`)),
        unmount: async () => { await act(async () => { root.unmount(); }); },
    };
};

describe('ReferenceBrowser filter', () => {
    test('offers the label and milestone selects beside the state and people menu on a host that publishes both features', async () => {
        const view = await render(browserOf());
        const text = view.text();
        expect(text).toContain('Status');
        expect(text).toContain('People');
        expect(view.selectTriggers()).toHaveLength(2);
        expect(text).toContain('All labels');
        expect(text).toContain('bug');
        expect(text).toContain('All milestones');
        expect(text).toContain('v1.0');
        await view.unmount();
    });

    test('picking a label patches the repository filter', async () => {
        patches.length = 0;
        const view = await render(browserOf());
        const item = view.selectItem('bug');
        if (!item) throw new Error('Expected the label option bug');
        await act(async () => { item.click(); });
        expect(patches).toEqual([{ labelNames: ['bug'] }]);
        await view.unmount();
    });

    test('picking All milestones clears the milestone names', async () => {
        patches.length = 0;
        const view = await render(browserOf());
        // The label select renders first, so the milestone All is the second `all`.
        const alls = view.selectItems('all');
        if (alls.length !== 2) throw new Error('Expected both All options');
        await act(async () => { alls[1].click(); });
        expect(patches).toEqual([{ milestoneNames: [] }]);
        await view.unmount();
    });

    test('keeps the state and people groups, without the name selects, on a host that publishes neither feature', async () => {
        const view = await render(browserOf({ features: { labels: false, milestones: false }, labelOptions: null, milestoneOptions: null }));
        const text = view.text();
        expect(text).toContain('Status');
        expect(text).toContain('People');
        expect(view.selectTriggers()).toHaveLength(0);
        expect(text).not.toContain('All labels');
        expect(view.radioItem('bug')).toBeNull();
        await view.unmount();
    });

    test('keeps the state and people groups where the surface reads no options', async () => {
        // The picker's browser carries no options; the selects stay out.
        const view = await render(browserOf({ labelOptions: undefined, milestoneOptions: undefined }));
        const text = view.text();
        expect(text).toContain('Status');
        expect(text).toContain('People');
        expect(view.selectTriggers()).toHaveLength(0);
        expect(text).not.toContain('All labels');
        expect(view.radioItem('bug')).toBeNull();
        await view.unmount();
    });

    test('keeps the state and people groups without the name selects on a list across repositories', async () => {
        const view = await render(browserOf({ across: true }));
        const text = view.text();
        expect(text).toContain('Status');
        expect(text).toContain('People');
        expect(view.selectTriggers()).toHaveLength(0);
        expect(text).not.toContain('All labels');
        await view.unmount();
    });

    test('does not render a code comment as text in the search row', async () => {
        // A `//` line inside JSX is text content, so the row's rendered text
        // must stay free of it; the phone floor note is the known culprit.
        const view = await render(browserOf());
        const text = view.text();
        expect(text).not.toContain('//');
        expect(text).not.toContain('On a phone');
        await view.unmount();
    });
});

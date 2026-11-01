import { beforeAll, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';

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

const { IssueFilterSelects } = await import('./IssueFilterMenu');
import type { IssueFilterSelectsProps } from './IssueFilterMenu';
import { DEFAULT_ISSUE_FILTER } from './referencePickerItems';
import type { ChoiceOptionsState } from './issueFilterOptions';
import type { Label, MilestoneChoice } from '@/lib/api/types';

const ready = <T,>(items: T[]): ChoiceOptionsState<T> => ({ status: 'ready', items, stale: false, error: null });
const stale = <T,>(items: T[]): ChoiceOptionsState<T> => ({ status: 'ready', items, stale: true, error: null });

const labels: ChoiceOptionsState<Label> = ready([{ name: 'bug', color: 'ee0701' }]);
const milestones: ChoiceOptionsState<MilestoneChoice> = ready([{ name: 'v1.0', state: 'open' }]);

const base: IssueFilterSelectsProps = {
  filter: DEFAULT_ISSUE_FILTER,
  onFilterChange: () => undefined,
  labels,
  milestones,
  showLabel: true,
  showMilestone: true,
};

describe('IssueFilterSelects', () => {
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

  const render = async (props: IssueFilterSelectsProps) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(I18nProvider, null, React.createElement(IssueFilterSelects, props)));
    });
    return {
      text: () => host.textContent ?? '',
      triggers: () => Array.from(host.querySelectorAll<HTMLButtonElement>('[data-select-trigger]')),
      item: (value: string) => host.querySelector<HTMLButtonElement>(`[data-select-item="${value}"]`),
      unmount: async () => { await act(async () => { root.unmount(); }); },
    };
  };

  test('renders both selects when both option states are ready, with All first', async () => {
    const view = await render(base);
    const [labelTrigger, milestoneTrigger] = view.triggers();
    expect(view.triggers()).toHaveLength(2);
    // The ready trigger shows the translation of the selection.
    expect(labelTrigger?.textContent).toBe('All labels');
    expect(milestoneTrigger?.textContent).toBe('All milestones');
    const text = view.text();
    // Each select shows its All option and its items.
    expect(text).toContain('bug');
    expect(text).toContain('v1.0');
    await view.unmount();
  });

  test('selecting a label sets the single entry in labelNames', async () => {
    const patches: Array<Partial<IssueFilterSelectsProps['filter']>> = [];
    const view = await render({ ...base, onFilterChange: (patch) => patches.push(patch) });
    const bug = view.item('bug');
    if (!bug) throw new Error('Expected the label option bug');
    await act(async () => { bug.click(); });
    expect(patches).toEqual([{ labelNames: ['bug'] }]);
    await view.unmount();
  });

  test('selecting All labels clears the label names', async () => {
    const filter = { ...DEFAULT_ISSUE_FILTER, labelNames: ['bug'] };
    const patches: Array<Partial<IssueFilterSelectsProps['filter']>> = [];
    const view = await render({ ...base, filter, onFilterChange: (patch) => patches.push(patch) });
    // The label select renders first, so its All item is the first `all`.
    const all = view.item('all');
    if (!all) throw new Error('Expected the All option in the label select');
    await act(async () => { all.click(); });
    expect(patches).toEqual([{ labelNames: [] }]);
    await view.unmount();
  });

  test('a loading state renders a disabled select showing the loading note', async () => {
    const view = await render({ ...base, labels: { status: 'loading', items: [], stale: false, error: null } });
    const [labelTrigger, milestoneTrigger] = view.triggers();
    expect(labelTrigger?.disabled).toBe(true);
    // No value while the list is read: the trigger shows the loading note, not the sentinel.
    expect(labelTrigger?.textContent).toBe('…');
    // The other dimension is untouched.
    expect(milestoneTrigger?.disabled ?? true).toBe(false);
    expect(milestoneTrigger?.textContent).toBe('All milestones');
    await view.unmount();
  });

  test('a first failure disables its select with the unavailable note, the other stays usable', async () => {
    const view = await render({ ...base, milestones: { status: 'error', items: [], stale: false, error: 'network down' } });
    const [labelTrigger, milestoneTrigger] = view.triggers();
    expect(milestoneTrigger?.disabled).toBe(true);
    // No value after a failed first read: the trigger shows the unavailable note, not the sentinel.
    expect(milestoneTrigger?.textContent).toBe('Could not read the Milestone list');
    expect(labelTrigger?.disabled ?? true).toBe(false);
    expect(labelTrigger?.textContent).toBe('All labels');
    expect(view.item('bug')?.disabled ?? true).toBe(false);
    await view.unmount();
  });

  test('a stale ready state keeps its items and carries the stale hint', async () => {
    const view = await render({ ...base, milestones: stale([{ name: 'v1.0', state: 'open' }]) });
    const [, milestoneTrigger] = view.triggers();
    expect(milestoneTrigger?.getAttribute('title')).toBe('Showing the last list read');
    expect(view.item('v1.0')).not.toBeNull();
    await view.unmount();
  });

  test('showLabel false renders no label select', async () => {
    const view = await render({ ...base, showLabel: false });
    expect(view.triggers()).toHaveLength(1);
    const text = view.text();
    expect(text).not.toContain('All labels');
    expect(text).toContain('All milestones');
    await view.unmount();
  });
});

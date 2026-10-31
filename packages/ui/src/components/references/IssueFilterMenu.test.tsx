import { beforeAll, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';

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

const { IssueFilterMenu } = await import('./IssueFilterMenu');
import type { IssueFilterMenuProps } from './IssueFilterMenu';
import { DEFAULT_ISSUE_FILTER } from './referencePickerItems';
import type { ChoiceOptionsState } from './issueFilterOptions';
import type { Label, MilestoneChoice } from '@/lib/api/types';

const ready = <T,>(items: T[]): ChoiceOptionsState<T> => ({ status: 'ready', items, stale: false, error: null });
const stale = <T,>(items: T[]): ChoiceOptionsState<T> => ({ status: 'ready', items, stale: true, error: null });

const labels: ChoiceOptionsState<Label> = ready([{ name: 'bug', color: 'ee0701' }]);
const milestones: ChoiceOptionsState<MilestoneChoice> = ready([{ name: 'v1.0', state: 'open' }]);

const base: IssueFilterMenuProps = {
  filter: DEFAULT_ISSUE_FILTER,
  onFilterChange: () => undefined,
  labels,
  milestones,
  showLabel: true,
  showMilestone: true,
};

describe('IssueFilterMenu', () => {
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

  const render = async (props: IssueFilterMenuProps) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(I18nProvider, null, React.createElement(IssueFilterMenu, props)));
    });
    // The groups in render order: status, people, and the name dropdowns where offered.
    const groups = () => Array.from(host.querySelectorAll('[data-radio-group]'));
    return {
      text: () => host.textContent ?? '',
      radioItem: (value: string): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>(`[data-radio-value="${value}"]`),
      radioItemInGroup: (group: number, value: string): HTMLButtonElement | null => groups()[group]?.querySelector<HTMLButtonElement>(`[data-radio-value="${value}"]`) ?? null,
      unmount: async () => { await act(async () => { root.unmount(); }); },
    };
  };

  test('renders the state and people groups plus the two dropdowns', async () => {
    const view = await render(base);
    const text = view.text();
    expect(text).toContain('Status');
    expect(text).toContain('People');
    expect(text).toContain('Milestone');
    expect(text).toContain('Label');
    await view.unmount();
  });

  test('selecting a milestone sets the single entry in milestoneNames', async () => {
    const patches: Array<Partial<IssueFilterMenuProps['filter']>> = [];
    const view = await render({ ...base, onFilterChange: (patch) => patches.push(patch) });
    const item = view.radioItem('v1.0');
    if (!item) throw new Error('Expected the milestone option v1.0');
    await act(async () => { item.click(); });
    expect(patches).toEqual([{ milestoneNames: ['v1.0'] }]);
    await view.unmount();
  });

  test('selecting All clears the milestone names', async () => {
    const filter = { ...DEFAULT_ISSUE_FILTER, milestoneNames: ['v1.0'] };
    const patches: Array<Partial<IssueFilterMenuProps['filter']>> = [];
    const view = await render({ ...base, filter, onFilterChange: (patch) => patches.push(patch) });
    // Group 2 is the milestone dropdown: status is 0, people is 1.
    const item = view.radioItemInGroup(2, 'all');
    if (!item) throw new Error('Expected the All option in the milestone group');
    await act(async () => { item.click(); });
    expect(patches).toEqual([{ milestoneNames: [] }]);
    await view.unmount();
  });

  test('keeps the label dropdown usable when the milestone read is in its first-failure state', async () => {
    const view = await render({ ...base, milestones: { status: 'error', items: [], stale: false, error: 'network down' } });
    const text = view.text();
    // The milestone dropdown shows its error note; the label one keeps its options.
    expect(text).toContain('Could not read the Milestone list');
    expect(view.radioItem('bug')?.disabled ?? true).toBe(false);
    await view.unmount();
  });

  test('shows a stale hint on a stale dropdown and keeps its items', async () => {
    const view = await render({ ...base, milestones: stale([{ name: 'v1.0', state: 'open' }]) });
    const text = view.text();
    expect(text).toContain('v1.0');
    expect(text).toContain('Showing the last list read');
    await view.unmount();
  });
});

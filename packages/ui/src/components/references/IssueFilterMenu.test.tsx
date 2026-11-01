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

const base: IssueFilterMenuProps = {
  filter: DEFAULT_ISSUE_FILTER,
  onFilterChange: () => undefined,
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
    // The groups in render order: status is 0, people is 1.
    const groups = () => Array.from(host.querySelectorAll('[data-radio-group]'));
    return {
      // The menu's content alone: the trigger button carries its own name.
      text: () => host.querySelector('[data-menu-content]')?.textContent ?? '',
      radioItem: (value: string): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>(`[data-radio-value="${value}"]`),
      radioItemInGroup: (group: number, value: string): HTMLButtonElement | null => groups()[group]?.querySelector<HTMLButtonElement>(`[data-radio-value="${value}"]`) ?? null,
      unmount: async () => { await act(async () => { root.unmount(); }); },
    };
  };

  test('renders the state and people groups alone', async () => {
    const view = await render(base);
    const text = view.text();
    expect(text).toContain('Status');
    expect(text).toContain('People');
    // The name filters are the inline selects beside the menu, not groups in it.
    expect(text).not.toContain('Milestone');
    expect(text).not.toContain('Label');
    await view.unmount();
  });

  test('selecting a state patches the filter state', async () => {
    const patches: Array<Partial<IssueFilterMenuProps['filter']>> = [];
    const view = await render({ ...base, onFilterChange: (patch) => patches.push(patch) });
    const item = view.radioItemInGroup(0, 'closed');
    if (!item) throw new Error('Expected the closed state option');
    await act(async () => { item.click(); });
    expect(patches).toEqual([{ state: 'closed' }]);
    await view.unmount();
  });

  test('selecting a people option patches the filter people', async () => {
    const patches: Array<Partial<IssueFilterMenuProps['filter']>> = [];
    const view = await render({ ...base, onFilterChange: (patch) => patches.push(patch) });
    const item = view.radioItemInGroup(1, 'assigned');
    if (!item) throw new Error('Expected the assigned people option');
    await act(async () => { item.click(); });
    expect(patches).toEqual([{ people: 'assigned' }]);
    await view.unmount();
  });
});

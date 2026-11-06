import React from 'react';
import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';

// Inspect the props sent to shared menu primitives. This deliberately does not
// simulate Base UI interaction; opening, focus and keys need a browser check.
type GroupProps = { children: React.ReactNode; value: string; onValueChange: (value: string) => void; 'data-search-scope-control': string };
const groups = new Map<string, GroupProps>();
const container = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: container,
  DropdownMenuContent: container,
  DropdownMenuLabel: container,
  DropdownMenuTrigger: container,
  DropdownMenuRadioGroup: (props: GroupProps) => {
    groups.set(props['data-search-scope-control'], props);
    return <div>{props.children}</div>;
  },
  DropdownMenuRadioItem: ({ children, value, disabled }: { children: React.ReactNode; value: string; disabled?: boolean }) => <button data-value={value} disabled={disabled}>{children}</button>,
}));
const { SearchScopeMenu } = await import('./SearchScopeMenu');

test('sidebar passes frozen values, disabled current-project and every enabled group to shared menus', () => {
  const changes: Array<[string, string | null]> = [];
  const html = renderToStaticMarkup(<I18nProvider><SearchScopeMenu filters={{ author: 'user', project: 'current', searchIn: 'titles' }} defaults={{ lifecycle: 'active', searchIn: 'everything' }} options={{ lifecycle: true, project: { currentAvailable: false }, searchIn: true, author: true }} resultCount={2} layout="sidebar" onChange={(key, value) => changes.push([key, value])} /></I18nProvider>);
  expect([...groups.keys()]).toEqual(['lifecycle', 'project', 'searchIn', 'author']);
  expect(groups.get('author')?.value).toBe('user');
  expect(html).toContain('data-value="current" disabled=""');
  groups.get('lifecycle')?.onValueChange('all');
  groups.get('project')?.onValueChange('all');
  groups.get('project')?.onValueChange('current');
  groups.get('searchIn')?.onValueChange('everything');
  groups.get('author')?.onValueChange('assistant');
  expect(changes).toEqual([['lifecycle', 'all'], ['project', null], ['project', 'current'], ['searchIn', 'everything'], ['author', 'assistant']]);
});

test('sidebar omits disabled filter groups and preserves defaults', () => {
  groups.clear();
  renderToStaticMarkup(<I18nProvider><SearchScopeMenu filters={{}} defaults={{ lifecycle: 'archived', searchIn: 'titles' }} options={{ lifecycle: true, project: null, searchIn: true, author: false }} resultCount={null} layout="sidebar" onChange={() => {}} /></I18nProvider>);
  expect([...groups.keys()]).toEqual(['lifecycle', 'searchIn']);
  expect(groups.get('lifecycle')?.value).toBe('archived');
  expect(groups.get('searchIn')?.value).toBe('titles');
});

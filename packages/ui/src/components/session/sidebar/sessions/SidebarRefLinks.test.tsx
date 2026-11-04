import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { LinkRepository } from '@/components/sourceBoard/boardRepository';

import type { SidebarRefLink } from './SidebarRefLinks';

let repository: LinkRepository;

mock.module('@/components/sourceBoard/openTrackerItem', () => ({ useOpenTrackerItem: () => () => undefined }));
mock.module('@/components/sourceBoard/boardRepository', () => ({ useLinkRepository: () => repository }));
mock.module('@/lib/source-control/repositoryUrlMatcher', () => ({
  useRepositoryUrlMatcher: () => ({
    match: (url: string) => (url.includes('github.com') ? { owner: 'dotnet', repo: 'runtime' } : null),
  }),
}));

const { SidebarRefLinks } = await import('./SidebarRefLinks');

const item: SidebarRefLink = {
  key: 'dotnet/runtime#118826', icon: 'git-pull-request', label: '#118826', status: 'Completed',
  text: '#118826 · Completed', title: 'Measured allocations randomly zero', url: 'https://github.com/dotnet/runtime/issues/118826',
};
const render = (url: string | null = item.url) => renderToStaticMarkup(<SidebarRefLinks items={[{ ...item, url }]} directory="/project" />);
const answer = (status: LinkRepository['status'], owned: boolean) => {
  repository = { status, directory: '/project', owned, retry: () => undefined };
};

describe('SidebarRefLinks', () => {
  test('names the repository of a link outside the project, between the number and the state', () => {
    answer('ready', false);
    const markup = render();
    expect(markup.indexOf('#118826')).toBeLessThan(markup.indexOf('dotnet/runtime'));
    expect(markup.indexOf('dotnet/runtime')).toBeLessThan(markup.indexOf('· Completed'));
  });

  test('stays short for the project\'s own item', () => {
    answer('ready', true);
    expect(render()).not.toContain('dotnet/runtime');
  });

  test('names no repository while the project\'s remotes are unknown, or for a link to no repository', () => {
    answer('pending', false);
    expect(render()).not.toContain('dotnet/runtime');
    answer('ready', false);
    expect(render('https://linear.app/acme/issue/ENG-1')).not.toContain('dotnet/runtime');
  });
});

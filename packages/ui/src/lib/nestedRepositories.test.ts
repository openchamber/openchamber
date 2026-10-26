import { describe, expect, test } from 'bun:test';

import { chooseAutoNestedRepo, discoversNestedRepos } from './nestedRepositories';

describe('automatic nested repository pick', () => {
  test('a repository hidden inside a dot-directory is never picked on its own (#5357)', () => {
    // The reported case: a home directory opened as a project, where the tool
    // install is the only repository discovery finds.
    expect(chooseAutoNestedRepo('/home/me', ['/home/me/.oh-my-zsh'])).toBeNull();
    expect(chooseAutoNestedRepo('/home/me', ['/home/me/.cache/vendor/lib'])).toBeNull();
    expect(chooseAutoNestedRepo('/proj', ['/proj/.local/tool'])).toBeNull();
  });

  test('the first visible repository is picked, and hidden ones stay reachable', () => {
    expect(chooseAutoNestedRepo('/home/me', [
      '/home/me/.oh-my-zsh',
      '/home/me/.config/nvim',
      '/home/me/work/app',
      '/home/me/work/site',
    ])).toBe('/home/me/work/app');
  });

  test('a visible repository directly in the root is picked as before', () => {
    expect(chooseAutoNestedRepo('/proj', ['/proj/app'])).toBe('/proj/app');
    expect(chooseAutoNestedRepo('/home/me', ['/home/me/dotfiles-visible'])).toBe('/home/me/dotfiles-visible');
  });

  test('nothing discovered means nothing picked', () => {
    expect(chooseAutoNestedRepo('/proj', [])).toBeNull();
    expect(chooseAutoNestedRepo('/proj', null)).toBeNull();
    expect(chooseAutoNestedRepo('/proj', undefined)).toBeNull();
  });

  test('windows separators and a trailing separator on the root resolve the same way', () => {
    expect(chooseAutoNestedRepo('C:\\Users\\me\\', ['C:\\Users\\me\\.oh-my-zsh'])).toBeNull();
    expect(chooseAutoNestedRepo('C:\\Users\\me\\', ['C:\\Users\\me\\work\\app'])).toBe('C:\\Users\\me\\work\\app');
  });
});

describe('nested repository discovery', () => {
  test('the home directory is never searched', () => {
    expect(discoversNestedRepos('/home/me', '/home/me')).toBe(false);
    expect(discoversNestedRepos('/home/me/', '/home/me')).toBe(false);
  });

  test('any other folder is, including one inside home', () => {
    expect(discoversNestedRepos('/home/me/work', '/home/me')).toBe(true);
    expect(discoversNestedRepos('/proj', '')).toBe(true);
  });
});

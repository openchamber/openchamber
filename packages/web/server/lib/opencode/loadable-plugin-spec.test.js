import { describe, expect, test } from 'bun:test';

import { toLoadablePluginSpec } from './loadable-plugin-spec.js';

describe('toLoadablePluginSpec', () => {
  test.each([
    // npm registry packages, with a version, tag or range
    'opencode-plugin',
    'opencode-plugin@1.2.3',
    'opencode-plugin@1.2.3-beta.1',
    'opencode-plugin@next',
    'opencode-plugin@^1.2.0',
    'opencode-plugin@>=1 <2',
    'opencode-plugin@1.x || 2.x',
    '@scope/opencode-plugin',
    '@scope/opencode-plugin@latest',
    // Git specs OpenCode installs as they are
    'github:owner/repo',
    'github:owner/repo#main',
    'gitlab:owner/repo',
    'bitbucket:owner/repo',
    'gist:abc123',
    'git+https://github.com/owner/repo.git',
    'git+https://github.com/owner/repo',
    'git+https://github.com/owner/repo.git#main',
    'git+ssh://git@github.com/owner/repo.git#main',
    'git+https://github.com/owner/plugins.git#0123456789abcdef::path:packages/plugin',
    'git://github.com/owner/repo.git',
    'git@github.com:owner/repo.git',
    'owner/repo',
    'owner/repo#v1.0.0',
    // Local paths: the "From local path" tab, checked on disk by OpenCode
    '/abs/plugin',
    './plugin',
    '../plugin',
    '~/plugins/mine',
    'C:\\plugins\\mine',
    'file:///abs/plugin',
  ])('keeps %s as written', (spec) => {
    expect(toLoadablePluginSpec(spec)).toBe(spec);
  });

  test.each([
    ['https://github.com/claymor333/openchamber-magic-context.git', 'git+https://github.com/claymor333/openchamber-magic-context.git'],
    ['https://github.com/owner/repo', 'git+https://github.com/owner/repo'],
    ['https://github.com/owner/repo.git#main', 'git+https://github.com/owner/repo.git#main'],
    ['https://gitlab.com/owner/repo', 'git+https://gitlab.com/owner/repo'],
    ['https://bitbucket.org/owner/repo.git', 'git+https://bitbucket.org/owner/repo.git'],
    ['https://git.example.com/team/repo.git', 'git+https://git.example.com/team/repo.git'],
  ])('writes the repository address %s as %s', (spec, loadable) => {
    expect(toLoadablePluginSpec(spec)).toBe(loadable);
  });

  test.each([
    // A page inside a repository: the branch in the path would be dropped.
    'https://github.com/owner/repo/tree/main',
    // A download or a web page is not a repository.
    'https://example.com/plugin.tgz',
    'https://example.com',
    'http://github.com/owner/repo.git',
    // npm aliases and other npm spec kinds OpenCode does not install.
    'alias@npm:plugin@1.0.0',
    'file:../plugin',
    // Not an npm name.
    'my plugin',
    '.hidden-plugin',
    'opencode-plugin@',
    '@scope',
    'a'.repeat(215),
  ])('rejects %s', (spec) => {
    expect(toLoadablePluginSpec(spec)).toBeNull();
  });
});

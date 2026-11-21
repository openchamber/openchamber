import { describe, expect, it } from 'vitest';
import { normalizeDiscoveryEndpoint, resolveGitRelativeEndpoint } from './discovery-endpoint.js';
import { parseSubmoduleManifest } from './submodule-discovery.js';
import { hydrationFailure, resolveHydrationSubmodule } from './hydration-results.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const configOutput = (records) => records.map(([key, value]) => `${key}\n${value}\0`).join('');
const gitlinkOutput = (records) => records.map(([commit, path]) => `160000 ${commit} 0\t${path}\0`).join('');
const submoduleUrl = (url) => parseSubmoduleManifest({
  gitmodulesConfig: configOutput([['submodule.child.path', 'vendor/child'], ['submodule.child.url', url]]),
  gitlinks: gitlinkOutput([[SHA_A, 'vendor/child']]),
}).modules[0].url;

describe('submodule discovery', () => {
  it('pairs complete config records with gitlinks and preserves sibling records', () => {
    const result = parseSubmoduleManifest({
      gitmodulesConfig: configOutput([
        ['submodule.alpha.path', 'vendor/alpha'],
        ['submodule.alpha.url', '../alpha.git'],
        ['submodule.alpha.update', 'rebase'],
        ['submodule.beta.path', 'vendor/beta'],
        ['submodule.beta.url', 'https://example.com/team/beta.git'],
      ]),
      gitlinks: gitlinkOutput([[SHA_A, 'vendor/alpha'], [SHA_B, 'vendor/beta']]),
      recursionDepth: 2,
    });

    expect(result).toEqual({
      recursionDepth: 2,
      modules: [
        { name: 'alpha', path: 'vendor/alpha', url: '../alpha.git', update: 'rebase', gitlink: SHA_A },
        {
          name: 'beta', path: 'vendor/beta', url: 'https://example.com/team/beta.git',
          update: 'checkout', gitlink: SHA_B,
        },
      ],
    });
    expect(Object.isFrozen(result.modules)).toBe(true);
    expect(Object.isFrozen(result.modules[0])).toBe(true);
  });

  it('skips .gitmodules entries whose path has no gitlink, as Git does', () => {
    const result = parseSubmoduleManifest({
      gitmodulesConfig: configOutput([
        ['submodule.alpha.path', 'vendor/alpha'],
        ['submodule.alpha.url', '../alpha.git'],
        ['submodule.vendored.path', 'vendor/vendored'],
        ['submodule.vendored.url', 'https://example.com/team/vendored.git'],
        ['submodule.again.path', 'vendor/vendored'],
        ['submodule.again.url', '../again.git'],
        ['submodule.no-url.path', 'vendor/no-url'],
        ['submodule.no-path.url', '../no-path.git'],
        ['submodule.slash.path', 'vendor/slash/'],
        ['submodule.slash.url', '../slash.git'],
        ['submodule.backslash.path', 'vendor\\backslash'],
        ['submodule.backslash.url', '../backslash.git'],
        ['submodule.command.path', 'vendor/command'],
        ['submodule.command.url', 'ext::sh -c bad'],
        ['submodule.command.update', '!run-command'],
        ['submodule.empty.path', 'vendor/empty'],
        ['submodule.empty.url', ''],
      ]),
      gitlinks: gitlinkOutput([[SHA_A, 'vendor/alpha']]),
    });

    expect(result.modules).toEqual([
      { name: 'alpha', path: 'vendor/alpha', url: '../alpha.git', update: 'checkout', gitlink: SHA_A },
    ]);
  });

  it.each([
    ['https://github.com/libjxl/libjxl/', 'https://github.com/libjxl/libjxl', '/libjxl/libjxl'],
    ['https://github.com/LibRaw/LibRaw/', 'https://github.com/LibRaw/LibRaw', '/LibRaw/LibRaw'],
    ['ssh://git@example.com/team/child.git/', 'ssh://git@example.com/team/child.git', '/team/child.git'],
  ])('normalizes one trailing slash in absolute submodule URL %s', (url, endpoint, path) => {
    expect(submoduleUrl(url)).toBe(endpoint);
    expect(normalizeDiscoveryEndpoint(url, { trailingSlash: true })).toMatchObject({ endpoint, path });
  });

  it.each([
    'https://example.com/',
    'https://example.com/team/child.git//',
    'https://example.com/team//child.git/',
    'https://example.com/team/%2e%2e%2fchild.git/',
    'https://example.com/team/child.git%2f/',
    'https://example.com/team/child.git/?/',
    'https://example.com/team/child.git/#/',
    'https://example.com/team/../child.git/',
    'https://example.com/team/./child.git/',
    'https://example.com/team/%2e%2e/child.git/',
    'https://example.com/team/%2E/child.git/',
    'https://example.com\\team/child.git/',
    'git@example.com:team/child.git/',
  ])('rejects unsafe submodule URL paths despite a trailing slash: %s', (url) => {
    expect(() => submoduleUrl(url)).toThrow(expect.objectContaining({ submodulePath: 'vendor/child' }));
    expect(() => normalizeDiscoveryEndpoint(url, { trailingSlash: true })).toThrow(expect.objectContaining({
      code: 'INVALID_GIT_DISCOVERY_ENDPOINT',
    }));
  });

  it.each(['https://example.com/team/child.git/?', 'https://example.com/team/child.git/#'])(
    'keeps rejecting an empty delimiter after the trailing slash: %s',
    (url) => expect(() => submoduleUrl(url)).toThrow(expect.objectContaining({ submodulePath: 'vendor/child' })),
  );

  it('names the submodule only when its own URL fails, not when the parent endpoint does', () => {
    const module = { path: 'vendor/child', url: 'https://example.com/team/child.git' };
    let parentError;
    try { resolveHydrationSubmodule(module, 'http://localhost:8080/team/app.git', 'nested'); } catch (error) { parentError = error; }
    expect(hydrationFailure(parentError)).toMatchObject({ submodules: [], lfs: [{ path: '.', status: 'invalid' }] });
    let childError;
    try { resolveHydrationSubmodule({ ...module, url: 'https://example.com/team//child.git' }, 'https://example.com/team/app.git', 'nested'); } catch (error) { childError = error; }
    expect(hydrationFailure(childError)).toMatchObject({ submodules: [{ path: 'nested/vendor/child', status: 'invalid' }], lfs: [] });
  });

  it('keeps the trailing-slash exception out of endpoints other than submodules', () => {
    expect(() => normalizeDiscoveryEndpoint('https://example.com/team/lfs/')).toThrow(expect.objectContaining({
      code: 'INVALID_GIT_DISCOVERY_ENDPOINT',
    }));
    expect(() => resolveGitRelativeEndpoint('../lfs.git', 'https://example.com/team/app.git/')).toThrow(expect.objectContaining({
      code: 'INVALID_GIT_DISCOVERY_ENDPOINT',
    }));
  });

  it.each([
    ['https://example.com/team/app.git', '../library.git', 'https://example.com/team/library.git'],
    ['https://example.com/team/app.git/', '../library.git', 'https://example.com/team/library.git'],
    ['https://example.com/a/b/app.git', '../../shared.git', 'https://example.com/a/shared.git'],
    ['ssh://git@example.com/team/app.git', './library.git', 'ssh://git@example.com/team/app.git/library.git'],
    ['ssh://git@example.com/team/app.git/', './library.git', 'ssh://git@example.com/team/app.git/library.git'],
    ['git@example.com:team/app.git', '../library.git', 'git@example.com:team/library.git'],
  ])('resolves Git-relative URL %s plus %s', (parent, relative, expected) => {
    const result = resolveGitRelativeEndpoint(relative, parent, { trailingSlash: true });
    expect(result.endpoint).toBe(expected);
    const expectedPathRelationship = relative === '../../shared.git'
      ? 'unrelated'
      : relative.startsWith('./') ? 'descendant' : 'sibling';
    expect(result.relationship).toEqual({
      sameHost: true,
      samePort: true,
      path: expectedPathRelationship,
    });
    expect(result).not.toHaveProperty('credential');
  });

  it('reports host and path facts without granting credential reuse', () => {
    const sameHost = resolveGitRelativeEndpoint(
      'https://example.com/other/child.git',
      'https://example.com/team/parent.git',
    );
    const crossHost = resolveGitRelativeEndpoint(
      'https://objects.example.net/team/child.git',
      'git@example.com:team/parent.git',
    );

    expect(sameHost.relationship).toEqual({ sameHost: true, samePort: true, path: 'unrelated' });
    expect(crossHost.relationship).toEqual({ sameHost: false, samePort: true, path: 'sibling' });
    expect(JSON.stringify([sameHost, crossHost])).not.toMatch(/credential|token|password/i);
  });

  it.each([
    ['duplicate path', [
      ['submodule.a.path', 'same'], ['submodule.a.url', '../a.git'],
      ['submodule.b.path', 'same'], ['submodule.b.url', '../b.git'],
    ], [[SHA_A, 'same'], [SHA_B, 'other']]],
    ['missing path', [['submodule.a.url', '../a.git']], [[SHA_A, 'a']]],
    ['missing URL', [['submodule.a.path', 'a']], [[SHA_A, 'a']]],
    ['absolute path', [['submodule.a.path', '/tmp/a'], ['submodule.a.url', '../a.git']], [[SHA_A, '/tmp/a']]],
    ['parent path', [['submodule.a.path', '../a'], ['submodule.a.url', '../a.git']], [[SHA_A, '../a']]],
    ['dot-git path', [['submodule.a.path', 'vendor/.git/a'], ['submodule.a.url', '../a.git']], [[SHA_A, 'vendor/.git/a']]],
    ['control path', [['submodule.a.path', 'vendor/a\nname'], ['submodule.a.url', '../a.git']], [[SHA_A, 'vendor/a\nname']]],
    ['remote helper', [['submodule.a.path', 'a'], ['submodule.a.url', 'ext::sh -c bad']], [[SHA_A, 'a']]],
    ['unsafe protocol', [['submodule.a.path', 'a'], ['submodule.a.url', 'file:///tmp/a']], [[SHA_A, 'a']]],
    ['command update', [
      ['submodule.a.path', 'a'], ['submodule.a.url', '../a.git'], ['submodule.a.update', '!run-command'],
    ], [[SHA_A, 'a']]],
    ['empty URL', [['submodule.a.path', 'a'], ['submodule.a.url', '']], [[SHA_A, 'a']]],
    ['empty update', [
      ['submodule.a.path', 'a'], ['submodule.a.url', '../a.git'], ['submodule.a.update', ''],
    ], [[SHA_A, 'a']]],
  ])('rejects hostile manifest: %s', (_label, records, links) => {
    expect(() => parseSubmoduleManifest({
      gitmodulesConfig: configOutput(records),
      gitlinks: gitlinkOutput(links),
    })).toThrow(expect.objectContaining({ code: 'INVALID_SUBMODULE_MANIFEST' }));
  });

  it('rejects incomplete null output, undeclared gitlinks, duplicate keys, and malformed modes', () => {
    expect(() => parseSubmoduleManifest({ gitmodulesConfig: 'submodule.a.path\na', gitlinks: '' })).toThrow('incomplete');
    expect(() => parseSubmoduleManifest({
      gitmodulesConfig: configOutput([
        ['submodule.a.path', 'a'], ['submodule.a.path', 'b'], ['submodule.a.url', '../a.git'],
      ]),
      gitlinks: gitlinkOutput([[SHA_A, 'a']]),
    })).toThrow('duplicate path');
    expect(() => parseSubmoduleManifest({
      gitmodulesConfig: '', gitlinks: gitlinkOutput([[SHA_A, 'a']]),
    })).toThrow('undeclared');
    expect(() => parseSubmoduleManifest({
      gitmodulesConfig: configOutput([['submodule.a.path', 'a'], ['submodule.a.url', '../a.git']]),
      gitlinks: `100644 ${SHA_A} 0\ta\0`,
    })).toThrow('malformed');
  });

  it('enforces byte, module, path, recursion, and public-record bounds', () => {
    const input = {
      gitmodulesConfig: configOutput([['submodule.a.path', 'a'], ['submodule.a.url', '../a.git']]),
      gitlinks: gitlinkOutput([[SHA_A, 'a']]),
    };
    expect(() => parseSubmoduleManifest(input, { maxManifestBytes: 4 })).toThrow(expect.objectContaining({
      code: 'SUBMODULE_DISCOVERY_LIMIT_EXCEEDED',
    }));
    expect(() => parseSubmoduleManifest(input, { maxModules: 0 })).toThrow(expect.objectContaining({
      code: 'SUBMODULE_DISCOVERY_LIMIT_EXCEEDED',
    }));
    expect(() => parseSubmoduleManifest(input, { maxPublicRecords: 0 })).toThrow(expect.objectContaining({
      code: 'SUBMODULE_DISCOVERY_LIMIT_EXCEEDED',
    }));
    expect(() => parseSubmoduleManifest({ ...input, recursionDepth: 2 }, { maxRecursionDepth: 1 })).toThrow(expect.objectContaining({
      code: 'SUBMODULE_DISCOVERY_LIMIT_EXCEEDED',
    }));
    const deep = {
      gitmodulesConfig: configOutput([['submodule.a.path', 'a/b'], ['submodule.a.url', '../a.git']]),
      gitlinks: gitlinkOutput([[SHA_A, 'a/b']]),
    };
    expect(() => parseSubmoduleManifest(deep, { maxPathDepth: 1 })).toThrow(expect.objectContaining({
      code: 'SUBMODULE_DISCOVERY_LIMIT_EXCEEDED',
    }));
  });

  it.each([
    ['../../child.git', 'https://example.com/root.git'],
    ['https://user:secret@example.com/child.git', 'https://example.com/root.git'],
    ['../child.git', 'file:///tmp/root.git'],
    ['../../child.git', 'git@example.com:root.git'],
    ['https://user@example.com/child.git', 'https://example.com/root.git'],
    ['../child.git', 'https://org:secret@example.com/root.git'],
  ])('rejects unsafe relative resolution for %s against %s', (child, parent) => {
    expect(() => resolveGitRelativeEndpoint(child, parent)).toThrow(expect.objectContaining({
      code: 'INVALID_GIT_DISCOVERY_ENDPOINT',
    }));
  });

  it('drops the user name of an HTTPS parent from what it resolves', () => {
    const parent = 'https://myorg@dev.azure.com/myorg/app/_git/app';
    expect(resolveGitRelativeEndpoint('../sub', parent)).toMatchObject({
      endpoint: 'https://dev.azure.com/myorg/app/_git/sub',
      relationship: { sameHost: true, samePort: true, path: 'sibling' },
    });
    expect(resolveGitRelativeEndpoint('https://example.com/other.git', parent).endpoint).toBe('https://example.com/other.git');
    expect(resolveGitRelativeEndpoint('../sub.git', 'ssh://git@example.com/team/app.git').endpoint).toBe('ssh://git@example.com/team/sub.git');
  });
});

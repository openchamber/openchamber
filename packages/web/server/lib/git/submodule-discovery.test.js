import { describe, expect, it } from 'vitest';
import { resolveGitRelativeEndpoint } from './discovery-endpoint.js';
import { parseSubmoduleManifest } from './submodule-discovery.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const configOutput = (records) => records.map(([key, value]) => `${key}\n${value}\0`).join('');
const gitlinkOutput = (records) => records.map(([commit, path]) => `160000 ${commit} 0\t${path}\0`).join('');

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

  it.each([
    ['https://example.com/team/app.git', '../library.git', 'https://example.com/team/library.git'],
    ['https://example.com/a/b/app.git', '../../shared.git', 'https://example.com/a/shared.git'],
    ['ssh://git@example.com/team/app.git', './library.git', 'ssh://git@example.com/team/app.git/library.git'],
    ['git@example.com:team/app.git', '../library.git', 'git@example.com:team/library.git'],
  ])('resolves Git-relative URL %s plus %s', (parent, relative, expected) => {
    const result = resolveGitRelativeEndpoint(relative, parent);
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
  ])('rejects unsafe relative resolution for %s against %s', (child, parent) => {
    expect(() => resolveGitRelativeEndpoint(child, parent)).toThrow(expect.objectContaining({
      code: 'INVALID_GIT_DISCOVERY_ENDPOINT',
    }));
  });
});

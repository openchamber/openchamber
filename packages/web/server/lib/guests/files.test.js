import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { GUEST_FILE_CONTENT_MAX, GUEST_FILE_LIST_MAX } from '@openchamber/sdk';

import {
  expandHome,
  globToRegExp,
  matchesFilesystemPattern,
  resolveGuestFilePath,
  runGuestFileOperation,
} from './files.js';

const tempDirs = [];

const makeTemp = async (prefix) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const real = await fs.realpath(dir);
  tempDirs.push(real);
  return real;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('expandHome and globToRegExp', () => {
  test('expands ~ and ~/ against the home directory', () => {
    expect(expandHome('~/.config/x', '/home/ada')).toBe('/home/ada/.config/x');
    expect(expandHome('~/.config/x', '/home/ada/')).toBe('/home/ada/.config/x');
    expect(expandHome('~', '/home/ada')).toBe('/home/ada');
    expect(expandHome('/etc/x', '/home/ada')).toBe('/etc/x');
  });

  test('** spans directories, * and ? stay inside one segment', () => {
    expect(globToRegExp('/a/**/c.txt').test('/a/c.txt')).toBe(true);
    expect(globToRegExp('/a/**/c.txt').test('/a/b/x/c.txt')).toBe(true);
    expect(globToRegExp('/a/*.txt').test('/a/c.txt')).toBe(true);
    expect(globToRegExp('/a/*.txt').test('/a/b/c.txt')).toBe(false);
    expect(globToRegExp('/a/?.txt').test('/a/c.txt')).toBe(true);
    expect(globToRegExp('/a/?.txt').test('/a/cc.txt')).toBe(false);
    expect(globToRegExp('/a/b.txt').test('/a/bxtxt')).toBe(false);
  });

  test('a directory pattern matches the directory and everything below', () => {
    const pattern = globToRegExp('/tmp/probe/**');
    expect(pattern.test('/tmp/probe')).toBe(true);
    expect(pattern.test('/tmp/probe/a')).toBe(true);
    expect(pattern.test('/tmp/probe/a/b/c')).toBe(true);
    expect(pattern.test('/tmp/probes')).toBe(false);
    expect(pattern.test('/tmp')).toBe(false);
  });
});

describe('matchesFilesystemPattern', () => {
  test('matches on the expanded home pattern only', () => {
    const patterns = ['~/.config/opencode/opencode.json', '/tmp/probe/**'];
    expect(matchesFilesystemPattern('/home/ada/.config/opencode/opencode.json', patterns, '/home/ada')).toBe(true);
    expect(matchesFilesystemPattern('/home/ada/.config/opencode/other.json', patterns, '/home/ada')).toBe(false);
    expect(matchesFilesystemPattern('/tmp/probe/deep/file', patterns, '/home/ada')).toBe(true);
    expect(matchesFilesystemPattern('/etc/hosts', patterns, '/home/ada')).toBe(false);
    expect(matchesFilesystemPattern('/etc/hosts', [], '/home/ada')).toBe(false);
  });
});

describe('resolveGuestFilePath', () => {
  test('accepts a relative path inside the project and refuses .. anywhere', async () => {
    const project = await makeTemp('oc-files-project-');
    await fs.writeFile(path.join(project, 'README.md'), '# hi');
    const inside = await resolveGuestFilePath({ path: 'README.md', projectDirectory: project, patterns: [], homeDir: os.homedir() });
    expect(inside).toEqual({ ok: true, scope: 'project', absolute: path.join(project, 'README.md') });
    const dot = await resolveGuestFilePath({ path: '.', projectDirectory: project, patterns: [], homeDir: os.homedir() });
    expect(dot).toEqual({ ok: true, scope: 'project', absolute: project });
    for (const bad of ['../etc/passwd', 'src/../../x', '~/../x', '/tmp/../etc', 'a\\b', 'a\0b', '']) {
      const result = await resolveGuestFilePath({ path: bad, projectDirectory: project, patterns: ['/**'], homeDir: os.homedir() });
      expect(result).toMatchObject({ ok: false, code: 'BAD_PATH' });
    }
  });

  test('is NO_DIRECTORY for a relative path without a project', async () => {
    const result = await resolveGuestFilePath({ path: 'README.md', projectDirectory: null, patterns: [], homeDir: os.homedir() });
    expect(result).toMatchObject({ ok: false, code: 'NO_DIRECTORY' });
  });

  test('refuses a symlink that escapes the project', async () => {
    const project = await makeTemp('oc-files-project-');
    const outside = await makeTemp('oc-files-outside-');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'nope');
    await fs.symlink(outside, path.join(project, 'link'));
    const viaLink = await resolveGuestFilePath({ path: 'link/secret.txt', projectDirectory: project, patterns: [], homeDir: os.homedir() });
    expect(viaLink).toMatchObject({ ok: false, code: 'BAD_PATH' });
    // A file that does not exist yet under the escaping link is still outside.
    const newViaLink = await resolveGuestFilePath({ path: 'link/new.txt', projectDirectory: project, patterns: [], homeDir: os.homedir() });
    expect(newViaLink).toMatchObject({ ok: false, code: 'BAD_PATH' });
  });

  test('accepts an outside path only when a declared pattern covers its canonical form', async () => {
    const home = await makeTemp('oc-files-home-');
    const probe = await makeTemp('oc-files-probe-');
    await fs.mkdir(path.join(home, '.config', 'opencode'), { recursive: true });
    const declared = await resolveGuestFilePath({
      path: '~/.config/opencode/opencode.json',
      projectDirectory: null,
      patterns: ['~/.config/opencode/opencode.json', `${probe}/**`],
      homeDir: home,
    });
    expect(declared).toEqual({ ok: true, scope: 'filesystem', absolute: path.join(home, '.config', 'opencode', 'opencode.json') });
    const below = await resolveGuestFilePath({ path: `${probe}/a/b.txt`, projectDirectory: null, patterns: [`${probe}/**`], homeDir: home });
    expect(below).toEqual({ ok: true, scope: 'filesystem', absolute: path.join(probe, 'a', 'b.txt') });
    const undeclared = await resolveGuestFilePath({ path: '/etc/hosts', projectDirectory: null, patterns: ['~/.config/opencode/opencode.json'], homeDir: home });
    expect(undeclared).toMatchObject({ ok: false, code: 'BAD_PATH' });
    const none = await resolveGuestFilePath({ path: `${probe}/a`, projectDirectory: null, patterns: [], homeDir: home });
    expect(none).toMatchObject({ ok: false, code: 'BAD_PATH' });
  });

  test('matches through a symlinked pattern prefix and refuses a symlink out of the granted tree', async () => {
    const real = await makeTemp('oc-files-real-');
    const holder = await makeTemp('oc-files-holder-');
    const outside = await makeTemp('oc-files-outside-');
    const link = path.join(holder, 'link');
    await fs.symlink(real, link);
    // Pattern names the symlink; the candidate canonicalizes to the real dir.
    const viaLinkPattern = await resolveGuestFilePath({ path: `${link}/x.txt`, projectDirectory: null, patterns: [`${link}/**`], homeDir: holder });
    expect(viaLinkPattern).toEqual({ ok: true, scope: 'filesystem', absolute: path.join(real, 'x.txt') });
    // A symlink inside the granted tree pointing elsewhere is refused.
    await fs.symlink(outside, path.join(real, 'escape'));
    const escape = await resolveGuestFilePath({ path: `${real}/escape/y.txt`, projectDirectory: null, patterns: [`${real}/**`], homeDir: holder });
    expect(escape).toMatchObject({ ok: false, code: 'BAD_PATH' });
  });
});

describe('runGuestFileOperation', () => {
  const base = async () => {
    const project = await makeTemp('oc-files-project-');
    const probe = await makeTemp('oc-files-probe-');
    return {
      project,
      probe,
      run: (overrides) => runGuestFileOperation({
        projectDirectory: project,
        patterns: [`${probe}/**`],
        grants: ['files', 'filesystem'],
        homeDir: os.homedir(),
        ...overrides,
      }),
    };
  };

  test('needs files for the project and filesystem for outside', async () => {
    const { probe, run } = await base();
    expect(await run({ op: 'stat', path: 'README.md', grants: ['filesystem'] })).toMatchObject({ ok: false, code: 'NOT_GRANTED' });
    expect(await run({ op: 'stat', path: `${probe}/x`, grants: ['files'] })).toMatchObject({ ok: false, code: 'NOT_GRANTED' });
    expect(await run({ op: 'stat', path: 'README.md', grants: [] })).toMatchObject({ ok: false, code: 'NOT_GRANTED' });
    expect(await run({ op: 'stat', path: 'README.md' })).toEqual({ ok: true, result: { kind: 'missing', size: 0, mtime: 0 } });
  });

  test('reads, stats, and reports a missing file as NOT_FOUND', async () => {
    const { project, run } = await base();
    await fs.writeFile(path.join(project, 'README.md'), '# hi');
    expect(await run({ op: 'read', path: 'README.md' })).toEqual({ ok: true, result: { content: '# hi' } });
    expect(await run({ op: 'read', path: 'missing.md' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await run({ op: 'read', path: '.' })).toMatchObject({ ok: false, code: 'BAD_PATH' });
    const stat = await run({ op: 'stat', path: 'README.md' });
    expect(stat).toMatchObject({ ok: true, result: { kind: 'file', size: 4 } });
    expect(stat.result.mtime).toBeGreaterThan(0);
    expect(await run({ op: 'stat', path: '.' })).toMatchObject({ ok: true, result: { kind: 'directory' } });
  });

  test('refuses to read a file over the content cap', async () => {
    const { project, run } = await base();
    const fsPromises = {
      ...fs,
      stat: async (target) => ({
        ...(await fs.stat(project)),
        isDirectory: () => false,
        isFile: () => true,
        size: GUEST_FILE_CONTENT_MAX + 1,
        target,
      }),
      realpath: fs.realpath.bind(fs),
      readFile: async () => {
        throw new Error('should not read');
      },
    };
    expect(await run({ op: 'read', path: 'big.txt', fsPromises })).toMatchObject({ ok: false, code: 'FILE_TOO_LARGE' });
  });

  test('writes atomically, creating parents, and refuses oversized content', async () => {
    const { probe, run } = await base();
    const target = path.join(probe, 'nested', 'deep', 'config.json');
    const renames = [];
    const fsPromises = {
      ...fs,
      realpath: fs.realpath.bind(fs),
      rename: async (from, to) => {
        // The target must not exist (or be complete) before the rename lands.
        const before = await fs.readFile(to, 'utf8').catch(() => null);
        renames.push({ from, to, before });
        return fs.rename(from, to);
      },
    };
    expect(await run({ op: 'write', path: target, content: '{"a":1}', fsPromises })).toEqual({ ok: true, result: { written: true } });
    expect(await fs.readFile(target, 'utf8')).toBe('{"a":1}');
    expect(renames).toHaveLength(1);
    expect(renames[0].to).toBe(target);
    expect(renames[0].from).not.toBe(target);
    expect(renames[0].before).toBeNull();
    // Overwrite: the previous content stays whole until the rename.
    expect(await run({ op: 'write', path: target, content: '{"a":2}', fsPromises })).toEqual({ ok: true, result: { written: true } });
    expect(renames[1].before).toBe('{"a":1}');
    expect(await fs.readFile(target, 'utf8')).toBe('{"a":2}');
    expect(await fs.readdir(path.dirname(target))).toEqual(['config.json']);
    expect(await run({ op: 'write', path: target, content: 'x'.repeat(GUEST_FILE_CONTENT_MAX + 1) })).toMatchObject({ ok: false, code: 'FILE_TOO_LARGE' });
    expect(await fs.readFile(target, 'utf8')).toBe('{"a":2}');
  });

  test('lists sorted entries with kinds and caps the list', async () => {
    const { project, run } = await base();
    await fs.mkdir(path.join(project, 'src'));
    await fs.writeFile(path.join(project, 'b.txt'), '');
    await fs.writeFile(path.join(project, 'a.txt'), '');
    await fs.symlink(path.join(project, 'a.txt'), path.join(project, 'link'));
    expect(await run({ op: 'list', path: '.' })).toEqual({
      ok: true,
      result: {
        entries: [
          { name: 'a.txt', kind: 'file' },
          { name: 'b.txt', kind: 'file' },
          { name: 'link', kind: 'other' },
          { name: 'src', kind: 'directory' },
        ],
      },
    });
    expect(await run({ op: 'list', path: 'a.txt' })).toMatchObject({ ok: false, code: 'BAD_PATH' });
    expect(await run({ op: 'list', path: 'nope' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const many = await makeTemp('oc-files-many-');
    await Promise.all(Array.from({ length: GUEST_FILE_LIST_MAX + 5 }, (_, index) => (
      fs.writeFile(path.join(many, `f${String(index).padStart(5, '0')}`), '')
    )));
    const capped = await run({ op: 'list', path: many, patterns: [`${many}/**`] });
    expect(capped.ok).toBe(true);
    expect(capped.result.entries).toHaveLength(GUEST_FILE_LIST_MAX);
    expect(capped.result.entries[0].name).toBe('f00000');
  });

  test('maps an OS permission error to DENIED', async () => {
    const { project, run } = await base();
    await fs.writeFile(path.join(project, 'README.md'), '# hi');
    const fsPromises = {
      ...fs,
      realpath: fs.realpath.bind(fs),
      readFile: async () => {
        const error = new Error('EACCES');
        error.code = 'EACCES';
        throw error;
      },
    };
    expect(await run({ op: 'read', path: 'README.md', fsPromises })).toMatchObject({ ok: false, code: 'DENIED' });
  });
});

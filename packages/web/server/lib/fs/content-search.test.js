import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createContentSearchRuntime } from './content-search.js';
import { createRipgrepResolver } from './ripgrep.js';

const { resolveRipgrepBinary } = createRipgrepResolver({ fs, path });

describe('content search with ripgrep', () => {
  let repo;
  let search;

  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'oc-find-in-files-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await mkdir(path.join(repo, '.hidden'), { recursive: true });
    await mkdir(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(repo, 'src', 'a.ts'), [
      'const héllo = "wörld"; // needle here',
      '    indented needle',
      'no match on this line',
      `const minified = "${'x'.repeat(300)}needle${'y'.repeat(300)}";`,
    ].join('\n') + '\n');
    await writeFile(path.join(repo, 'src', 'b.ts'), 'needle twice: needle\n');
    await writeFile(path.join(repo, 'README.md'), 'Needle in caps\nfoo.bar literal dot\nfooXbar\n');
    await writeFile(path.join(repo, '.hidden', 'secret.txt'), 'hidden needle\n');
    await writeFile(path.join(repo, 'ignored.txt'), 'ignored needle\n');
    await writeFile(path.join(repo, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(repo, 'node_modules', 'pkg', 'index.js'), 'needle in a dependency\n');
    await writeFile(path.join(repo, 'blob.bin'), Buffer.concat([Buffer.from('needle'), Buffer.from([0, 1, 2])]));
    search = createContentSearchRuntime({ spawn, path, resolveRipgrepBinary }).searchFileContents;
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const find = (options) => search(repo, { regex: false, limit: 200, includeHidden: false, respectGitignore: true, ...options });

  it('finds matching lines with character offsets, sorted by path and line', async () => {
    const result = await find({ query: 'needle' });
    expect(result.status).toBe('ok');
    expect(result.stopped).toBeNull();
    expect(result.matches.map((match) => [match.relativePath, match.line])).toEqual([
      ['README.md', 1],
      ['src/a.ts', 1],
      ['src/a.ts', 2],
      ['src/a.ts', 4],
      ['src/b.ts', 1],
    ]);
    const multibyte = result.matches[1];
    expect(multibyte.path).toBe(path.join(repo, 'src/a.ts'));
    expect(multibyte.text).toBe('const héllo = "wörld"; // needle here');
    expect(multibyte.text.slice(...multibyte.ranges[0])).toBe('needle');
    expect(multibyte.column).toBe('const héllo = "wörld"; // '.length + 1);
    expect(multibyte.cutStart).toBe(false);
    const twice = result.matches[4];
    expect(twice.ranges).toEqual([[0, 6], [14, 20]]);
  });

  it('matches case-insensitively for a lowercase query and exactly otherwise', async () => {
    expect((await find({ query: 'needle' })).matches.some((match) => match.relativePath === 'README.md')).toBe(true);
    expect((await find({ query: 'Needle' })).matches.map((match) => match.relativePath)).toEqual(['README.md']);
  });

  it('drops indentation and keeps the match near the start of a long line', async () => {
    const result = await find({ query: 'needle' });
    const indented = result.matches.find((match) => match.line === 2);
    expect(indented.text).toBe('indented needle');
    expect(indented.ranges).toEqual([[9, 15]]);
    expect(indented.column).toBe('    indented '.length + 1);
    expect(indented.cutStart).toBe(false);

    const minified = result.matches.find((match) => match.line === 4);
    expect(minified.text.length).toBeLessThanOrEqual(200);
    expect(minified.cutStart).toBe(true);
    expect(minified.text.slice(...minified.ranges[0])).toBe('needle');
    expect(minified.ranges[0][0]).toBe(24);
    expect(minified.column).toBe('const minified = "'.length + 300 + 1);
  });

  it('skips gitignored, hidden, binary and node_modules files unless told otherwise', async () => {
    const paths = (result) => result.matches.map((match) => match.relativePath);
    const strict = await find({ query: 'needle' });
    expect(paths(strict)).not.toContain('ignored.txt');
    expect(paths(strict)).not.toContain('.hidden/secret.txt');
    expect(paths(strict)).not.toContain('blob.bin');

    expect(paths(await find({ query: 'needle', respectGitignore: false }))).toContain('ignored.txt');
    expect(paths(await find({ query: 'needle', includeHidden: true }))).toContain('.hidden/secret.txt');
    const everything = await find({ query: 'needle', respectGitignore: false, includeHidden: true });
    expect(paths(everything)).not.toContain('node_modules/pkg/index.js');
    expect(paths(everything).some((candidate) => candidate.startsWith('.git/'))).toBe(false);
  });

  it('treats the query as text unless regex is on', async () => {
    const literal = await find({ query: 'foo.bar' });
    expect(literal.matches.map((match) => match.text)).toEqual(['foo.bar literal dot']);
    const regex = await find({ query: 'foo.bar', regex: true });
    expect(regex.matches.map((match) => match.text)).toEqual(['foo.bar literal dot', 'fooXbar']);
  });

  it('reports an invalid regular expression as such', async () => {
    const result = await find({ query: '(unclosed', regex: true });
    expect(result).toEqual({ status: 'invalid-pattern', message: 'unclosed group' });
  });

  it('stops at the limit and says so', async () => {
    const result = await find({ query: 'needle', limit: 2 });
    expect(result.status).toBe('ok');
    expect(result.stopped).toBe('limit');
    expect(result.matches).toHaveLength(2);
  });

  it('answers no matches without an error', async () => {
    expect(await find({ query: 'nothing-has-this-text' })).toEqual({ status: 'ok', matches: [], stopped: null });
  });

  it('answers unavailable without spawning when there is no ripgrep', async () => {
    const spawnSpy = vi.fn();
    const runtime = createContentSearchRuntime({ spawn: spawnSpy, path, resolveRipgrepBinary: async () => null });
    expect(await runtime.searchFileContents(repo, { query: 'needle', regex: false })).toEqual({ status: 'unavailable' });
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

// A ripgrep that keeps running until killed, for the paths real searches
// finish too fast to exercise.
const createHangingSpawn = ({ stdoutLines = [], stdoutChunks = [], stderr = '', exitCode = null } = {}) => {
  const children = [];
  const spawnFake = vi.fn(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      return true;
    };
    children.push(child);
    queueMicrotask(() => {
      for (const line of stdoutLines) child.stdout.emit('data', Buffer.from(`${line}\n`));
      for (const chunk of stdoutChunks) child.stdout.emit('data', Buffer.from(chunk));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      if (exitCode !== null) child.emit('close', exitCode, null);
    });
    return child;
  });
  return { spawn: spawnFake, children };
};

const matchEvent = (relativePath, line, text) => JSON.stringify({
  type: 'match',
  data: {
    path: { text: `./${relativePath}` },
    lines: { text: `${text}\n` },
    line_number: line,
    absolute_offset: 0,
    submatches: [{ match: { text: 'x' }, start: text.indexOf('x'), end: text.indexOf('x') + 1 }],
  },
});

describe('content search process control', () => {
  const resolveRipgrepBinary = async () => '/fake/rg';

  it('kills ripgrep and reports aborted when the caller goes away', async () => {
    const { spawn: spawnFake, children } = createHangingSpawn();
    const runtime = createContentSearchRuntime({ spawn: spawnFake, path, resolveRipgrepBinary });
    const abort = new AbortController();
    const pending = runtime.searchFileContents('/root', { query: 'x', regex: false, signal: abort.signal });
    await Promise.resolve();
    abort.abort();
    expect(await pending).toEqual({ status: 'aborted' });
    expect(children[0].killed).toBe(true);
  });

  it('kills ripgrep at the deadline and keeps what it found', async () => {
    const { spawn: spawnFake, children } = createHangingSpawn({ stdoutLines: [matchEvent('a.txt', 1, 'x marks')] });
    const runtime = createContentSearchRuntime({ spawn: spawnFake, path, resolveRipgrepBinary, deadlineMs: 5 });
    const result = await runtime.searchFileContents('/root', { query: 'x', regex: false });
    expect(result.status).toBe('ok');
    expect(result.stopped).toBe('deadline');
    expect(result.matches.map((match) => match.relativePath)).toEqual(['a.txt']);
    expect(children[0].killed).toBe(true);
  });

  it('reads a match event split across many chunks', async () => {
    const event = matchEvent('long.min.js', 1, `x${'y'.repeat(100_000)}`);
    const stdoutChunks = `${event}\n${event}\n`.match(/[\s\S]{1,4096}/g);
    const { spawn: spawnFake } = createHangingSpawn({ stdoutChunks, exitCode: 0 });
    const runtime = createContentSearchRuntime({ spawn: spawnFake, path, resolveRipgrepBinary });
    const result = await runtime.searchFileContents('/root', { query: 'x', regex: false });
    expect(result.matches.map((match) => match.relativePath)).toEqual(['long.min.js', 'long.min.js']);
  });

  it('passes the ripgrep flags the options ask for', async () => {
    const { spawn: spawnFake } = createHangingSpawn({ exitCode: 1 });
    const runtime = createContentSearchRuntime({ spawn: spawnFake, path, resolveRipgrepBinary });
    await runtime.searchFileContents('/root', { query: '-dash', regex: true, includeHidden: true, respectGitignore: false });
    const [binary, args, options] = spawnFake.mock.calls[0];
    expect(binary).toBe('/fake/rg');
    expect(args).toEqual([
      '--json', '--no-config', '--smart-case', '--glob', '!.git', '--glob', '!node_modules',
      '--hidden', '--no-ignore', '-e', '-dash', '--', '.',
    ]);
    expect(options).toMatchObject({ cwd: '/root', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  });

  it('keeps matches from a search that also hit unreadable files', async () => {
    const { spawn: spawnFake } = createHangingSpawn({
      stdoutLines: [matchEvent('a.txt', 3, 'x')],
      stderr: 'rg: ./locked: Permission denied (os error 13)\n',
      exitCode: 2,
    });
    const runtime = createContentSearchRuntime({ spawn: spawnFake, path, resolveRipgrepBinary });
    const result = await runtime.searchFileContents('/root', { query: 'x', regex: false });
    expect(result).toMatchObject({ status: 'ok', stopped: null });
    expect(result.matches).toHaveLength(1);
  });

  it('reports a failure with ripgrep’s reason when nothing was found', async () => {
    const { spawn: spawnFake } = createHangingSpawn({ stderr: 'rg: ./root: No such file or directory (os error 2)\n', exitCode: 2 });
    const runtime = createContentSearchRuntime({ spawn: spawnFake, path, resolveRipgrepBinary });
    expect(await runtime.searchFileContents('/root', { query: 'x', regex: false })).toEqual({
      status: 'failed',
      message: './root: No such file or directory (os error 2)',
    });
  });

  it('reports a process that could not start', async () => {
    const spawnFake = vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      queueMicrotask(() => child.emit('error', new Error('spawn EACCES')));
      return child;
    });
    const runtime = createContentSearchRuntime({ spawn: spawnFake, path, resolveRipgrepBinary });
    expect(await runtime.searchFileContents('/root', { query: 'x', regex: false })).toEqual({ status: 'failed', message: 'spawn EACCES' });
  });
});

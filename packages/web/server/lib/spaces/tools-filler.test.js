import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TOOLS_MARKER_PATH } from './layout.js';
import { runCommand } from './run-command.js';
import { FILLER_PROGRAM, buildFillInput } from './tools-filler.js';

const KEY = '0123456789abcdef';

describe('buildFillInput', () => {
  it('puts a header line with names and byte lengths before the bytes', () => {
    const input = buildFillInput({ key: KEY, packageJson: '{"a":"ä"}', files: [{ name: 'web.tgz', bytes: Buffer.from([0, 10, 255]) }] });

    const headerEnd = input.indexOf(10);
    expect(JSON.parse(input.subarray(0, headerEnd).toString('utf8'))).toEqual({
      key: KEY,
      files: [{ name: 'package.json', bytes: 10 }, { name: 'web.tgz', bytes: 3 }],
    });
    expect(input.subarray(headerEnd + 1, headerEnd + 11).toString('utf8')).toBe('{"a":"ä"}');
    expect([...input.subarray(headerEnd + 11)]).toEqual([0, 10, 255]);
  });

  it.each(['../evil.tgz', 'a/b.tgz', '.hidden', '', 'a\\b', 'x'.repeat(101)])('rejects the file name %j', (name) => {
    expect(() => buildFillInput({ key: KEY, packageJson: '{}', files: [{ name, bytes: Buffer.alloc(1) }] })).toThrow(expect.objectContaining({ code: 'invalid_tools_file' }));
  });

  it('rejects bytes that are not a Buffer, and a bad key', () => {
    expect(() => buildFillInput({ key: KEY, packageJson: '{}', files: [{ name: 'a.tgz', bytes: 'text' }] })).toThrow(expect.objectContaining({ code: 'invalid_tools_file' }));
    expect(() => buildFillInput({ key: 'nope', packageJson: '{}' })).toThrow(expect.objectContaining({ code: 'invalid_tools_key' }));
  });
});

describe('FILLER_PROGRAM', () => {
  it('is one line, so it is safe as one argument on every host', () => {
    expect(FILLER_PROGRAM).not.toMatch(/[\r\n]/);
    expect(() => new Function(FILLER_PROGRAM)).not.toThrow();
  });

  it('ignores install scripts, keeps the npm cache out of the volume, and writes the marker that the place reads', () => {
    expect(FILLER_PROGRAM).toContain("'--ignore-scripts', '--no-audit', '--no-fund', '--cache'");
    expect(FILLER_PROGRAM).toContain(`'${path.posix.basename(TOOLS_MARKER_PATH)}'`);
  });
});

// The program runs here as it does in the filler, against temporary directories and a stand-in for npm.
describe.skipIf(process.platform === 'win32')('FILLER_PROGRAM, run', () => {
  const FAKE_NPM = `#!/bin/sh
echo "$@" > npm-args.txt
[ -f fail-npm ] && exit 3
mkdir -p node_modules/.bin node_modules/@opencode/plugin node_modules/@opencode/cli
touch node_modules/.bin/openchamber node_modules/.bin/opencode
[ -f skip-plugin ] || echo '{}' > node_modules/@opencode/plugin/package.json
echo "import fs from 'node:fs'; fs.writeFileSync('postinstall-ran', 'yes');" > node_modules/@opencode/cli/postinstall.mjs
`;
  let root;
  let tools;
  let staging;
  let originalPath;

  beforeAll(() => {
    originalPath = process.env.PATH;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-filler-test-'));
    tools = path.join(root, 'tools');
    staging = path.join(root, 'staging');
    fs.mkdirSync(tools);
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin', 'npm'), FAKE_NPM, { mode: 0o755 });
    process.env.PATH = `${path.join(root, 'bin')}${path.delimiter}${originalPath}`;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const fill = (stdin) => runCommand(process.execPath, ['-e', FILLER_PROGRAM, tools, staging], { stdin, timeoutMs: 30_000 });
  const rawInput = (header, ...bodies) => Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), ...bodies.map((body) => Buffer.from(body))]);

  it('writes package.json to the tools directory, tarballs to staging, installs, and writes the marker last', async () => {
    const bytes = Buffer.from([31, 139, 0, 10, 255, 0]);
    const result = await fill(buildFillInput({ key: KEY, packageJson: '{"name":"x"}', files: [{ name: 'openchamber-web.tgz', bytes }] }));

    expect(result).toMatchObject({ code: 0 });
    expect(fs.readFileSync(path.join(tools, 'package.json'), 'utf8')).toBe('{"name":"x"}');
    expect(fs.readFileSync(path.join(staging, 'openchamber-web.tgz'))).toEqual(bytes);
    expect(fs.existsSync(path.join(tools, 'openchamber-web.tgz'))).toBe(false);
    expect(fs.readFileSync(path.join(tools, 'npm-args.txt'), 'utf8').trim()).toBe(`install --ignore-scripts --no-audit --no-fund --cache ${path.join(staging, 'npm-cache')}`);
    // The one install script that runs: the OpenCode launcher needs its binary linked.
    expect(fs.readFileSync(path.join(tools, 'node_modules', '@opencode/cli', 'postinstall-ran'), 'utf8')).toBe('yes');
    expect(fs.readFileSync(path.join(tools, '.filled'), 'utf8')).toBe(KEY);
    // The marker arrives through a rename, so a marker that exists is never half written.
    expect(fs.existsSync(path.join(tools, '.filled.new'))).toBe(false);
  });

  it('writes no marker when npm fails', async () => {
    fs.writeFileSync(path.join(tools, 'fail-npm'), '');
    const result = await fill(buildFillInput({ key: KEY, packageJson: '{}' }));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('fill failed: npm install ended with 3');
    expect(fs.existsSync(path.join(tools, '.filled'))).toBe(false);
  });

  it('writes no marker when a needed package is missing after the install', async () => {
    fs.writeFileSync(path.join(tools, 'skip-plugin'), '');
    const result = await fill(buildFillInput({ key: KEY, packageJson: '{}' }));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('node_modules/@opencode/plugin/package.json is missing');
    expect(fs.existsSync(path.join(tools, '.filled'))).toBe(false);
  });

  it.each(['../escaped', 'sub/file', '/etc/passwd', '.filled', ''])('refuses the file name %j and writes nothing', async (name) => {
    const result = await fill(rawInput({ key: KEY, files: [{ name, bytes: 1 }] }, 'x'));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('a file name must be a plain name');
    expect(fs.readdirSync(tools)).toEqual([]);
    expect(fs.existsSync(path.join(root, 'escaped'))).toBe(false);
  });

  it.each([
    ['a length past the end of the input', { key: KEY, files: [{ name: 'a.tgz', bytes: 50 }] }, 'does not fit the input'],
    ['a negative length', { key: KEY, files: [{ name: 'a.tgz', bytes: -1 }] }, 'does not fit the input'],
    ['bytes after the last file', { key: KEY, files: [{ name: 'a.tgz', bytes: 1 }] }, 'longer than the header says'],
    ['a bad key', { key: '../x', files: [] }, 'needs a key and a file list'],
  ])('refuses %s', async (title, header, message) => {
    const result = await fill(rawInput(header, 'xyz'));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(fs.existsSync(path.join(tools, '.filled'))).toBe(false);
  });

  it('refuses input without a header', async () => {
    expect((await fill('no newline here')).stderr).toContain('no header line');
    expect((await fill('not json\n')).stderr).toContain('not JSON');
  });
});

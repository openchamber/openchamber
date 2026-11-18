
import { SpaceError } from './errors.js';
import { requireToolsKey } from './labels.js';

const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PACKAGE_JSON_NAME = 'package.json';

const UV_VERSION = '0.13.1';
const UV_SHA256 = Object.freeze({
  aarch64: '9041c73c99fdc5892cf128140beb354eca9231d502068cc36e6cb53a8e59ad14',
  x86_64: 'eadd9d27c134ab5ac1ffd4473b97a741407f3ea238288f03121fc4deddf90220',
});

const programLines = (uvSha256: Readonly<Record<'aarch64' | 'x86_64', string>>) => [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const { spawnSync } = require('node:child_process');",
  "const crypto = require('node:crypto');",
  'const [toolsDirectory, stagingDirectory] = process.argv.slice(1);',
  "const fail = (message) => { console.error('fill failed: ' + message); process.exit(1); };",
  "const run = (file, args, cwd) => { const result = spawnSync(file, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] }); if (result.status !== 0) fail(file + ' ' + args[0] + ' ended with ' + (result.status === null ? result.signal || result.error : result.status)); };",
  'const chunks = [];',
  "process.stdin.on('data', (chunk) => chunks.push(chunk));",
  "process.stdin.on('end', async () => {",
  '  const input = Buffer.concat(chunks);',
  '  const headerEnd = input.indexOf(10);',
  "  if (headerEnd < 0) fail('the input has no header line');",
  '  let header = null;',
  "  try { header = JSON.parse(input.subarray(0, headerEnd).toString('utf8')); } catch (error) { fail('the header is not JSON'); }",
  "  if (!header || !/^[0-9a-f]{16}$/.test(header.key) || !Array.isArray(header.files)) fail('the header needs a key and a file list');",
  '  fs.mkdirSync(stagingDirectory, { recursive: true });',
  '  let offset = headerEnd + 1;',
  '  for (const file of header.files) {',
  "    if (!file || typeof file.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(file.name)) fail('a file name must be a plain name');",
  "    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || offset + file.bytes > input.length) fail('the length of ' + file.name + ' does not fit the input');",
  "    fs.writeFileSync(path.join(file.name === 'package.json' ? toolsDirectory : stagingDirectory, file.name), input.subarray(offset, offset + file.bytes));",
  '    offset += file.bytes;',
  '  }',
  "  if (offset !== input.length) fail('the input is longer than the header says');",
  "  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(stagingDirectory, 'npm-cache')], toolsDirectory);",
  "  run(process.execPath, ['postinstall.mjs'], path.join(toolsDirectory, 'node_modules', '@opencode/cli'));",
  "  run(process.execPath, ['install.js'], path.join(toolsDirectory, 'node_modules', 'bun'));",
  "  const uvTarget = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];",
  "  if (!uvTarget) fail('uv has no build for ' + process.arch);",
  "  const uvName = 'uv-' + uvTarget + '-unknown-linux-gnu';",
  "  let uvArchive = null;",
  `  try { const response = await fetch('https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/' + uvName + '.tar.gz'); if (!response.ok) fail('the uv download answered ' + response.status); uvArchive = Buffer.from(await response.arrayBuffer()); } catch (error) { fail('the uv download failed: ' + error.message); }`,
  `  if (crypto.createHash('sha256').update(uvArchive).digest('hex') !== ${JSON.stringify(uvSha256)}[uvTarget]) fail('the uv download does not match its pinned checksum');`,
  "  fs.writeFileSync(path.join(stagingDirectory, 'uv.tar.gz'), uvArchive);",
  "  run('/usr/bin/tar', ['--no-same-owner', '-xzf', path.join(stagingDirectory, 'uv.tar.gz'), '-C', stagingDirectory], stagingDirectory);",
  "  for (const program of ['uv', 'uvx']) { const target = path.join(toolsDirectory, 'node_modules', '.bin', program); fs.copyFileSync(path.join(stagingDirectory, uvName, program), target); fs.chmodSync(target, 0o755); }",
  "  for (const needed of ['node_modules/.bin/openchamber', 'node_modules/.bin/opencode', 'node_modules/@opencode/plugin/package.json', 'node_modules/.bin/bun', 'node_modules/.bin/pnpm', 'node_modules/.bin/uv']) {",
  "    if (!fs.existsSync(path.join(toolsDirectory, needed))) fail(needed + ' is missing after the install');",
  '  }',
  "  for (const program of ['bun', 'pnpm', 'uv']) run(path.join(toolsDirectory, 'node_modules', '.bin', program), ['--version'], toolsDirectory);",
  "  run('/bin/sync', [], toolsDirectory);",
  "  const flush = (target, flags) => { const descriptor = fs.openSync(target, flags); try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); } };",
  "  const marker = path.join(toolsDirectory, '.filled');",
  "  fs.writeFileSync(marker + '.new', header.key);",
  "  flush(marker + '.new', 'r+');",
  "  flush(toolsDirectory, 'r');",
  "  fs.renameSync(marker + '.new', marker);",
  "  flush(toolsDirectory, 'r');",
  '});',
];

export const fillerProgram = (uvSha256: Readonly<Record<'aarch64' | 'x86_64', string>> = UV_SHA256) => programLines(uvSha256).map((line) => line.trim()).join(' ');

export const FILLER_PROGRAM = fillerProgram();

export interface ToolsFile {
  name: string;
  bytes: Buffer;
}

export function buildFillInput({ key, packageJson, files = [] }: { key: string; packageJson: string; files?: readonly ToolsFile[] }) {
  const entries = [{ name: PACKAGE_JSON_NAME, bytes: Buffer.from(packageJson, 'utf8') }, ...files];
  for (const entry of entries) {
    if (!FILE_NAME_PATTERN.test(entry.name) || !Buffer.isBuffer(entry.bytes)) {
      throw new SpaceError('invalid_tools_file', 'A tools file needs a plain name without slashes and its bytes as a Buffer');
    }
  }
  const header = { key: requireToolsKey(key), files: entries.map((entry) => ({ name: entry.name, bytes: entry.bytes.length })) };
  return Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), ...entries.map((entry) => entry.bytes)]);
}

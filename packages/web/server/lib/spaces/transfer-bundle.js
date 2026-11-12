import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

import { SpaceError } from './errors.js';
import { createHostGit } from './host-git.js';
import { runCommand } from './run-command.js';
import { line, objectIdPattern, spaceRefPrefix } from './code-transfer.js';

export const SPACE_TRANSFER_ROUTE = '/api/openchamber/space-transfer';

const text = z.string().max(4096).refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const identity = z.string().max(256).refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const snapshotMetadataSchema = z.object({
  version: z.literal(1), mode: z.enum(['clean', 'uncommitted']), directory: text.min(1),
  repository: text.min(1), prefix: text, objectFormat: z.enum(['sha1', 'sha256']),
  base: oid, staged: oid, start: oid, branch: text.max(256).nullable(),
  identity: z.object({ name: identity, email: identity }).strict(), ref: text,
  shallow: z.array(oid).max(100000),
}).strict();

export const bundleFailure = (code = 'agent_bundle_invalid') => new SpaceError(code, code);

export function transferCaps(environment = process.env) {
  const read = (key, fallback) => {
    const value = environment[key] === undefined ? fallback : Number(environment[key]);
    if (!Number.isSafeInteger(value) || value < 1) throw bundleFailure('agent_transfer_invalid_limit');
    return value;
  };
  return {
    bundleBytes: read('OPENCHAMBER_SPACE_BUNDLE_MAX_BYTES', 512 * 1024 * 1024),
    metadataBytes: read('OPENCHAMBER_SPACE_METADATA_MAX_BYTES', 16 * 1024),
    timeoutMs: read('OPENCHAMBER_SPACE_AGENT_TIMEOUT_MS', 10 * 60_000),
  };
}

export function parseSnapshotMetadata(value, spaceId) {
  const parsed = snapshotMetadataSchema.safeParse(value);
  if (!parsed.success) throw bundleFailure('agent_metadata_invalid');
  const metadata = parsed.data;
  if (metadata.ref !== `${spaceRefPrefix(spaceId)}start`
    || ![metadata.base, metadata.staged, metadata.start].every((id) => objectIdPattern(metadata.objectFormat).test(id))
    || !metadata.shallow.every((id) => objectIdPattern(metadata.objectFormat).test(id))
    || !path.isAbsolute(metadata.repository) || !path.isAbsolute(metadata.directory)
    || metadata.prefix.startsWith('/') || metadata.prefix.split('/').some((part) => part === '..' || part === '.')
    || metadata.prefix.includes('\\')
    || path.resolve(metadata.repository, metadata.prefix) !== metadata.directory
    || metadata.mode === 'clean' && (metadata.base !== metadata.staged || metadata.base !== metadata.start)
    || metadata.mode === 'uncommitted' && (metadata.start === metadata.staged || metadata.staged === metadata.base)) {
    throw bundleFailure('agent_metadata_invalid');
  }
  return metadata;
}

/** A git config value in double quotes. Paths reach here checked; a control character still refuses. */
const configValue = (value) => {
  if (/[\x00-\x1f\x7f]/.test(value)) throw bundleFailure('agent_directory_invalid');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
};

/**
 * A git with hooks, fsmonitor and every user and system configuration off, and fsck on, for the
 * repositories this process creates. The agent server also runs it in a registered project it
 * already checked, named in `options.trust`. Its global configuration is then a file of this
 * directory holding only those folders' `safe.directory`: git before 2.38 takes that key from
 * system and global configuration only, never from `-c`, and Ubuntu 22.04 ships 2.34 with the
 * ownership check.
 */
export async function withBundleDirectory(options, work) {
  const parent = options.temporaryDirectory ?? os.tmpdir();
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(parent, 'openchamber-bundle-'));
  await fs.chmod(directory, 0o700);
  try {
    const hooks = path.join(directory, 'no-hooks');
    await fs.mkdir(hooks, { mode: 0o700 });
    const trust = options.trust ?? [];
    const globalConfig = trust.length ? path.join(directory, 'trust.gitconfig') : os.devNull;
    if (trust.length) {
      await fs.writeFile(globalConfig, `[safe]\n${trust.map((folder) => `\tdirectory = ${configValue(folder)}\n`).join('')}`, { mode: 0o600, flag: 'wx' });
    }
    const git = createHostGit({ runCommand: options.runCommand ?? runCommand, gitPath: options.gitPath,
      environment: options.environment ?? process.env });
    const config = ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false',
      '-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true', '-c', 'receive.fsckObjects=true'];
    const bounded = (method) => (where, args, request = {}) => git[method](where, [...config, ...args], {
      ...request, timeoutMs: Math.min(request.timeoutMs ?? options.caps.timeoutMs, options.caps.timeoutMs), killTree: true,
      env: { ...request.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' },
    });
    return await work({ directory, git: { run: bounded('run'), output: bounded('output'), fsmonitor: 'false' } });
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export async function streamBundle(source, destination, caps) {
  let bytes = 0;
  const limit = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > caps.bundleBytes ? bundleFailure('agent_bundle_too_large') : null, chunk);
  } });
  try {
    await pipeline(source, limit, destination, { signal: AbortSignal.timeout(caps.timeoutMs) });
  } catch (error) {
    if (error instanceof SpaceError) throw error;
    throw bundleFailure('agent_bundle_stream_failed');
  }
}

export const receiveBundle = (source, file, caps) => streamBundle(source, createWriteStream(file, { flags: 'wx', mode: 0o600 }), caps);

/** Read only the bounded header. Git subsequently verifies and fscks the pack. */
export async function checkBundleHeader(file, expected) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size > expected.caps.bundleBytes) throw bundleFailure('agent_bundle_too_large');
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf('\n\n');
    if (end < 0) throw bundleFailure();
    const lines = buffer.subarray(0, end).toString('utf8').split('\n');
    const version = lines.shift();
    if (!['# v2 git bundle', '# v3 git bundle'].includes(version)) throw bundleFailure();
    if (version === '# v3 git bundle' && lines.shift() !== `@object-format=${expected.objectFormat}`) throw bundleFailure();
    if (version === '# v2 git bundle' && expected.objectFormat !== 'sha1') throw bundleFailure();
    const refs = [];
    const prerequisites = [];
    for (const entry of lines) {
      if (entry.startsWith('-')) {
        const id = entry.slice(1).split(' ')[0];
        if (!objectIdPattern(expected.objectFormat).test(id)) throw bundleFailure();
        prerequisites.push(id);
      } else refs.push(entry);
    }
    if (refs.length !== 1 || refs[0] !== `${expected.id} ${expected.ref}`
      || prerequisites.length !== (expected.prerequisite ? 1 : 0)
      || expected.prerequisite && prerequisites[0] !== expected.prerequisite) throw bundleFailure();
    return end + 2;
  } finally { await handle.close(); }
}

export async function importBundle(git, repository, file, expected) {
  await checkBundleHeader(file, expected);
  await git.output(repository, ['bundle', 'verify', file]);
  await git.output(repository, ['-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true', 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
    '--no-auto-gc', '--refmap=', file, `+${expected.ref}:${expected.ref}`]);
  if (line(await git.output(repository, ['rev-parse', '--verify', `${expected.ref}^{commit}`])) !== expected.id) throw bundleFailure();
}

/** Bound a git-written file while it grows as well as after a short command. */
export async function writeBundle(git, repository, file, { revisions, caps }) {
  const controller = new AbortController();
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      if ((await fs.stat(file)).size > caps.bundleBytes) controller.abort(bundleFailure('agent_bundle_too_large'));
    } catch { /* The writer has not opened its file yet. */ }
    finally { checking = false; }
  }, 100);
  timer.unref();
  try {
    await git.output(repository, ['bundle', 'create', file, ...revisions], { signal: controller.signal, timeoutMs: caps.timeoutMs });
    if ((await fs.stat(file)).size > caps.bundleBytes) throw bundleFailure('agent_bundle_too_large');
  } finally { clearInterval(timer); }
}

export async function checkSnapshotChain(git, repository, metadata) {
  for (const id of new Set([metadata.base, metadata.staged, metadata.start])) {
    if (line(await git.output(repository, ['cat-file', '-t', id])) !== 'commit') throw bundleFailure('agent_snapshot_chain_invalid');
  }
  if (metadata.mode === 'uncommitted') {
    for (const [child, parent] of [[metadata.start, metadata.staged], [metadata.staged, metadata.base]]) {
      if (line(await git.output(repository, ['rev-list', '--parents', '--max-count=1', child], { maxOutputBytes: 1024 })) !== `${child} ${parent}`) {
        throw bundleFailure('agent_snapshot_chain_invalid');
      }
    }
  }
  if (metadata.branch !== null) {
    if (metadata.branch.startsWith('-') || line(await git.output(repository, ['check-ref-format', '--branch', metadata.branch])) !== metadata.branch) throw bundleFailure('agent_metadata_invalid');
  }
}

/** The start covers every excluded ancestor, including sibling snapshot histories. */
export async function makeResultBundle(git, repository, file, request) {
  const ref = `${spaceRefPrefix(request.spaceId)}result`;
  const raw = `${file}.raw`;
  const contained = (await git.run(repository, ['merge-base', '--is-ancestor', request.result, request.start])).code === 0;
  await writeBundle(git, repository, raw, { caps: request.caps, revisions: [ref, ...(contained ? [] : [`^${request.start}`])] });
  const handle = await fs.open(raw, 'r');
  let offset;
  try {
    const header = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    offset = header.subarray(0, bytesRead).indexOf('\n\n') + 2;
    if (offset < 2) throw bundleFailure();
  } finally { await handle.close(); }
  const version = request.objectFormat === 'sha1' ? '# v2 git bundle\n' : '# v3 git bundle\n@object-format=sha256\n';
  await fs.writeFile(file, `${version}-${request.start} start\n${request.result} ${ref}\n\n`, { mode: 0o600 });
  await streamBundle(createReadStream(raw, { start: offset }), createWriteStream(file, { flags: 'a' }), request.caps);
  await checkBundleHeader(file, { ...request, id: request.result, ref, prerequisite: request.start });
}

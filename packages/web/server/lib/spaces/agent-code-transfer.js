import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readBoundedBody } from '../agent-server/agent-upstream.js';
import { spaceRefPrefix } from './code-transfer.js';
import { SpaceError } from './errors.js';
import { requireSpaceId } from './labels.js';
import { createSpaceRecords } from './space-records.js';
import { SPACE_TRANSFER_ROUTE, bundleFailure, checkSnapshotChain, importBundle, makeResultBundle, parseSnapshotMetadata,
  receiveBundle, transferCaps, withBundleDirectory } from './transfer-bundle.js';

const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const count = z.number().int().nonnegative();
const reported = z.object({ count, paths: z.array(z.string().max(4096)).max(100) });
const summarySchema = z.object({ result: oid, changedPaths: count, changedBytes: count, newBytes: count,
  nestedRepositories: reported, unmerged: reported });
const stateSchema = z.object({ changesRoute: z.enum(['open', 'closed']), result: oid.nullable(), lastApplied: oid.nullable(),
  newPaths: count.nullable(), newPathsOverLimit: z.boolean(), newPathsUndecided: z.boolean(), interruptedApply: z.boolean() });
const branchSchema = z.object({ branch: z.string().min(1).max(256), commit: oid });
const changesSchema = z.discriminatedUnion('status', [z.object({ status: z.literal('nothing_to_apply') }),
  z.object({ status: z.literal('applied'), appliedPaths: count, remembered: z.boolean(), nestedRepositories: reported, conflicted: reported })]);

function agentTransfer(options) {
  const { upstream, dataDir, place } = options;
  const caps = transferCaps(options.environment);
  const route = (request, operation, extra = {}) => {
    requireSpaceId(request.spaceId);
    return `${SPACE_TRANSFER_ROUTE}/${request.spaceId}/${operation}?${new URLSearchParams({ directory: request.repository, ...extra })}`;
  };
  const responseJson = async (response) => {
    let value;
    try { value = JSON.parse(await readBoundedBody(response, caps.metadataBytes)); }
    catch { throw bundleFailure('agent_metadata_invalid'); }
    if (response.statusCode !== 200) {
      const code = z.string().regex(/^[a-z_]{1,80}$/).safeParse(value?.code);
      throw new SpaceError(code.success ? code.data : 'agent_transfer_failed', code.success ? code.data : 'agent_transfer_failed');
    }
    return value;
  };
  const request = (input, operation, { method = 'GET', body, extra } = {}) => {
    const options = { path: route(input, operation, extra), method, timeoutMs: caps.timeoutMs };
    if (body !== undefined) Object.assign(options, { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return upstream.request(options);
  };
  const json = async (input, operation, options, schema) => {
    const value = await responseJson(await request(input, operation, options));
    if (!schema) return value;
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw bundleFailure('agent_metadata_invalid');
    return parsed.data;
  };
  const snapshot = async (input, create) => {
    const record = create ? null : createSpaceRecords({ dataDir }).read(input.spaceId).record;
    const base = input.base ?? (record?.repository === input.repository ? record.base : null);
    const response = await request(input, 'snapshot', create ? { method: 'POST', body: { mode: input.mode ?? 'uncommitted' } }
      : { extra: base ? { base } : {} });
    try { return parseSnapshotMetadata(await responseJson(response), input.spaceId); }
    catch (error) {
      if (create && response.statusCode === 200) error.details = { ...error.details, snapshotMayExist: true };
      throw error;
    }
  };
  const withMirror = (input, metadata, work) => withBundleDirectory({ ...options, caps,
    temporaryDirectory: options.temporaryDirectory ?? path.join(dataDir, 'spaces', 'transfers') }, async ({ directory, git }) => {
    // Only the basename is used locally; no operation opens metadata.repository.
    const name = path.basename(metadata.repository);
    if (name === '' || name === '.' || name === '..') throw bundleFailure('agent_metadata_invalid');
    await fs.mkdir(path.join(directory, 'mirror'), { mode: 0o700 });
    const repository = path.join(directory, 'mirror', name);
    await git.output(directory, ['init', '--quiet', '--template=', `--object-format=${metadata.objectFormat}`, repository]);
    if (metadata.shallow.length) await fs.writeFile(path.join(repository, '.git/shallow'), `${metadata.shallow.join('\n')}\n`);
    const file = path.join(directory, 'start.bundle');
    const response = await request(input, 'bundle');
    if (response.statusCode !== 200) return responseJson(response);
    await receiveBundle(response, file, caps);
    await importBundle(git, repository, file, { caps, objectFormat: metadata.objectFormat, id: metadata.start, ref: metadata.ref });
    await checkSnapshotChain(git, repository, metadata);
    return work({ directory, git, repository, place, taken: { ...metadata, repository } });
  });
  return { caps, route, json, snapshot, withMirror, responseJson };
}

export function createAgentCodeIn(options) {
  const remote = agentTransfer(options);
  const histories = new Map();
  const removeSpaceRefs = async (input) => {
    const refs = await remote.json(input, 'refs', { method: 'DELETE' }, z.array(z.string()).max(100));
    if (refs.some((ref) => !ref.startsWith(spaceRefPrefix(input.spaceId)))) throw bundleFailure('agent_metadata_invalid');
    return refs;
  };
  const bringCodeIn = async (input) => {
    let metadata;
    try {
      metadata = await remote.snapshot(input, true);
      return await remote.withMirror(input, metadata, ({ git, directory, taken }) => options.localCodeIn({ git, place: options.place,
        temporaryDirectory: directory, snapshotSource: async () => taken }).bringCodeIn(input));
    } catch (error) {
      if (metadata || error.details?.snapshotMayExist) {
        try { await removeSpaceRefs(input); }
        catch (cleanup) { error.details = { ...error.details, refNotRemoved: `${spaceRefPrefix(input.spaceId)}start`, cleanupCode: cleanup.code }; }
      }
      throw error;
    }
  };
  const sendHistory = (input) => {
    const key = JSON.stringify([input.repository, input.spaceId, input.spacePath, input.base]);
    if (histories.has(key)) return histories.get(key);
    const promise = (async () => {
      const metadata = await remote.snapshot(input, false);
      if (metadata.base !== input.base) throw bundleFailure('agent_snapshot_changed');
      return remote.withMirror(input, metadata, ({ git, directory, repository }) => options.localCodeIn({ git,
        place: options.place, temporaryDirectory: directory }).sendHistory({ ...input, repository }));
    })().finally(() => histories.delete(key));
    histories.set(key, promise);
    return promise;
  };
  return { bringCodeIn, sendHistory, removeSpaceRefs };
}

export function createAgentCodeOut(options) {
  const remote = agentTransfer(options);
  const bringCodeOut = async (input) => {
    const metadata = await remote.snapshot(input, false);
    return remote.withMirror(input, metadata, async ({ git, directory, repository }) => {
      const summary = await options.localCodeOut({ git, place: options.place, temporaryDirectory: directory })
        .bringCodeOut({ ...input, repository });
      const file = path.join(directory, 'result.bundle');
      await makeResultBundle(git, repository, file, { ...metadata, spaceId: input.spaceId, result: summary.result, caps: remote.caps });
      const size = (await fs.stat(file)).size;
      if (size > remote.caps.bundleBytes) throw bundleFailure('agent_bundle_too_large');
      const response = await options.upstream.request({ path: remote.route(input, 'result', { start: metadata.start, result: summary.result }),
        method: 'POST', body: createReadStream(file), headers: { 'content-type': 'application/x-git-bundle', 'content-length': String(size) },
        timeoutMs: remote.caps.timeoutMs });
      const parsed = summarySchema.safeParse(await remote.responseJson(response));
      if (!parsed.success || parsed.data.result !== summary.result) throw bundleFailure('agent_metadata_invalid');
      return summary;
    });
  };
  return { bringCodeOut,
    describeApplyState: (input) => remote.json(input, 'apply-state', {}, stateSchema),
    applyAsBranch: (input) => remote.json(input, 'apply-branch', { method: 'POST', body: { branch: input.branch } }, branchSchema),
    applyAsChanges: (input) => remote.json(input, 'apply-changes', { method: 'POST', body: {} }, changesSchema),
  };
}

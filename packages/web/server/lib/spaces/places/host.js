import { fileURLToPath } from 'node:url';
import { createHostdClient, DEFAULT_SOCKET } from '../../hostd/client.js';
import { helperSpawnEnv } from '../../git/helper-launch.js';
import { SpaceError } from '../errors.js';
import { requireSpaceId } from '../resource-ids.js';
import { buildFillInput } from '../tools-filler.js';
import { requireToolsSource, toolsContentKey } from '../tools.js';

export function createHostPlace({ id = 'host', hostd = createHostdClient(), toolsSource, clientScript = fileURLToPath(new URL('../../hostd/attach-client.js', import.meta.url)), helperRuntime = { execPath: process.execPath, versions: process.versions } }) {
  if (!['host', 'host-root'].includes(id)) throw new SpaceError('invalid_place', 'A host place is host or host-root');
  const source = requireToolsSource(toolsSource);
  const request = (op, fields = {}) => hostd.request({ op, place: id, ...fields });
  const check = async () => {
    try {
      const result = await hostd.request({ op: 'check' });
      return result.available && id === 'host-root' ? { ...result, hostIsolation: false } : result;
    }
    catch (error) {
      if (['hostd_missing', 'hostd_unreachable', 'hostd_timeout', 'hostd_disconnected'].includes(error.code)) return { available: false, code: error.code, message: error.message };
      throw error;
    }
  };
  let filling = null;
  let failure = null;
  let key = null;
  const ensure = () => {
    filling ??= (async () => {
      const availability = await check();
      if (!availability.available) throw new SpaceError(availability.code, availability.message);
      key = toolsContentKey(source, `host:${availability.nodeVersion}:${availability.arch}`);
      const input = buildFillInput({ key, packageJson: source.packageJson, files: source.files });
      const result = await hostd.request({ op: 'tools-ensure', key, input: null }, { input });
      failure = null;
      return result;
    })().catch((error) => { failure = { code: error.code, message: error.message }; throw error; }).finally(() => { filling = null; });
    return filling;
  };
  const list = () => request('list');
  const requireRunning = async (spaceId) => {
    const entry = (await list()).find((space) => space.id === requireSpaceId(spaceId));
    if (!entry) throw new SpaceError('space_not_found', `There is no space ${spaceId} on ${id}`);
    if (entry.state !== 'running') throw new SpaceError('space_not_running', `Space ${spaceId} is stopped`);
  };
  const exec = (spaceId, argv, options = {}) => {
    const target = options.target ?? 'space';
    if (!['space', 'gatekeeper'].includes(target)) return Promise.reject(new SpaceError('invalid_exec_target', 'A command runs in the space or gatekeeper'));
    return hostd.exec({ op: 'exec', place: id, id: requireSpaceId(spaceId), target, argv,
      timeoutMs: options.timeoutMs ?? 60_000, maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024, keepTail: options.keepTail === true }, options);
  };
  const execArgv = async (spaceId) => {
    await requireRunning(spaceId);
    const socketArgs = hostd.socketPath && hostd.socketPath !== DEFAULT_SOCKET ? ['--socket', hostd.socketPath] : [];
    const environment = Object.entries(helperSpawnEnv({}, helperRuntime)).map(([key, value]) => `${key}=${value}`);
    const argv = [...(environment.length ? ['/usr/bin/env', ...environment] : []), helperRuntime.execPath, clientScript, ...socketArgs, 'attach', id, spaceId];
    if (argv.some((argument) => !argument || /[\x00-\x1f\x7f]/.test(argument))) throw new SpaceError('invalid_command', 'The host attach client path is not safe for git transport');
    return argv;
  };
  const place = {
    id, kind: id, machine: null, check, list, exec, execArgv,
    requireWindowUpstream: (upstream) => {
      const hostname = new URL(upstream).hostname.toLowerCase().replace(/\.$/, '');
      if (['localhost', '[::1]', '0.0.0.0', 'host.docker.internal', 'gateway.docker.internal'].includes(hostname) || /^127\./.test(hostname) || /^\[::ffff:7f[0-9a-f]{2}:/.test(hostname)) {
        throw new SpaceError('host_loopback_unavailable', 'Host spaces cannot reach a provider on this machine\'s loopback. Give the provider a reachable network address, then grant it again.');
      }
    },
    // A root space carries its passkey confirmation to the root component, which checks it; no other space takes one.
    create: async (spec, { onStep = () => {}, startConfig = null, activation = null } = {}) => {
      onStep('preparing_tools'); await ensure(); onStep('creating');
      const creation = { spec, startConfig, toolsKey: key };
      if (activation) creation.assertion = activation;
      await request('create', creation);
    },
    start: async (spaceId, { activation = null } = {}) => {
      await ensure();
      const starting = { id: requireSpaceId(spaceId) };
      if (activation) starting.assertion = activation;
      await request('start', starting);
    },
    stop: (spaceId) => request('stop', { id: requireSpaceId(spaceId) }),
    remove: (spaceId) => request('remove', { id: requireSpaceId(spaceId) }),
    verify: (spaceId) => request('verify', { id: requireSpaceId(spaceId) }),
    connect: async (spaceId) => { await requireRunning(spaceId); const stream = await hostd.attach({ op: 'attach', place: id, id: spaceId }); stream.bridge = true; return stream; },
    pullImage: ensure, imagePulling: () => filling !== null,
    readDisk: async () => ({ ...await request('disk'), imagePulling: filling !== null, imageFailure: failure }),
    cleanUpDisk: async () => {
      const before = await request('disk');
      const result = await hostd.request({ op: 'tools-prune', keep: key === null ? [] : [key] });
      const after = await request('disk');
      return { freedBytes: Math.max(0, before.toolsBytes - after.toolsBytes), kept: result.failed, machine: { state: 'skipped' } };
    },
  };
  if (id !== 'host-root') return place;
  // Only the root place carries the root activation operations.
  return {
    ...place,
    rootStatus: () => hostd.request({ op: 'root-status' }),
    rootApprovalChallenge: (code) => hostd.request({ op: 'root-approval-challenge', code }),
    rootApprovalComplete: (proof) => hostd.request({ op: 'root-approval-complete', ...proof }),
    rootActivationOptions: ({ op, spec = null, id: spaceId = null }) => hostd.request(op === 'create'
      ? { op: 'root-activation-options', action: 'create', spec }
      : { op: 'root-activation-options', action: 'start', id: requireSpaceId(spaceId) }),
  };
}

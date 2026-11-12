import fs from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { SpaceError } from '../spaces/errors.js';
import { createSpaceServerChannel, createSpaceToken } from '../spaces/space-server.js';
import { addresses, allocateSubnet } from './state.js';
import { buildUnits, names, MARKER } from './units.js';
import { checked, showUnit } from './system.js';
import { verifySpace } from './verify.js';

const PROGRAM = readFileSync(new URL('../spaces/gatekeeper-program.cjs', import.meta.url), 'utf8');

/**
 * Makes the folder of a space's protected MCP subject before its unit binds it, owned by the
 * service as its other subject folders are. A folder missing at the start is skipped by the bind,
 * so a grant made later would never reach the space; with the folder there, the service's socket
 * shows inside as soon as it listens. Nothing to do on a host without the service.
 */
export async function prepareMcpSubjectFolder(paths, id) {
  const subjects = await fs.lstat(paths.mcpSubjects).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!subjects?.isDirectory()) return;
  const folder = path.join(paths.mcpSubjects, `space-${id}`);
  await fs.mkdir(folder, { mode: 0o711 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const handle = await fs.open(folder, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    .catch(() => { throw new SpaceError('space_state_unsafe', 'The protected MCP subject of a space must be a real folder'); });
  try {
    await handle.chown(subjects.uid, subjects.gid);
    await handle.chmod(0o711);
  } finally { await handle.close(); }
}

/**
 * `authorizeRoot({ op, id, spec, assertion })` resolves only for a root space's create or start
 * that a fresh passkey confirmation was made for (`root-ops.js`); it runs before anything else.
 */
export function createLifecycle({ system, paths, state, tools, network, executor, ipPath, authorizeRoot }) {
  if (!authorizeRoot) throw new Error('The host lifecycle needs the root activation check');
  const run = (args) => checked(system, '/usr/bin/systemctl', args);
  const exec = (record, target, argv, stdin = '') => executor.collect({ op: 'exec', place: record.place, id: record.id, target, argv, timeoutMs: 60_000, maxOutputBytes: 4 * 1024 * 1024, keepTail: false }, stdin);
  const server = createSpaceServerChannel({ exec: async (id, argv, options = {}) => {
    const record = await state.read(id);
    return executor.collect({ op: 'exec', place: record.place, id, target: 'space', argv, timeoutMs: options.timeoutMs ?? 60_000, maxOutputBytes: 4 * 1024 * 1024, keepTail: false }, options.stdin ?? '');
  } });
  const verify = async (record, networkExpected) => verifySpace({ system, paths, record, ipPath, running: (await showUnit(system, names(record.id).space)).ActiveState === 'active', networkExpected });
  const requireVerified = async (record) => {
    const violations = await verify(record, true);
    if (violations.length) throw new SpaceError('space_verification_failed', violations.map((entry) => entry.message).join('; '), { violations });
  };
  const writeUnits = async (record) => {
    for (const [name, text] of Object.entries(buildUnits({ record, paths, ipPath }))) {
      const file = path.join(paths.units, name);
      const existing = await fs.readFile(file, 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing !== null && !existing.startsWith(MARKER)) throw new SpaceError('unit_conflict', `The unit ${name} belongs to another service`);
      await fs.writeFile(file, text, { mode: 0o644 });
    }
    await run(['daemon-reload']);
    // Loading every unit establishes the interpreted systemd properties before any service runs.
    for (const name of Object.values(names(record.id))) await showUnit(system, name);
    await requireVerified(record);
  };
  const startGatekeeper = async (record) => {
    const unit = names(record.id);
    await run(['start', unit.net]);
    // slirp exits if it cannot create tap0. Wait for the actual configured interface, not a timer.
    await checked(system, '/usr/bin/nsenter', [`--net=${paths.pins}/${record.id}/net`, '--', '/usr/bin/node', '-e',
      'const {spawnSync}=require("node:child_process");const deadline=Date.now()+10000;const wait=()=>{const r=spawnSync(process.argv[1],["-j","address","show","tap0"],{encoding:"utf8"});if(r.status===0&&JSON.parse(r.stdout).some(link=>link.addr_info.some(a=>a.local==="10.0.2.100")))process.exit(0);if(Date.now()>deadline)process.exit(1);setTimeout(wait,20)};wait();', ipPath]);
    await run(['start', unit.gatekeeper]);
    const directory = '/tmp/openchamber-gatekeeper';
    const script = `PATH=/usr/bin:/bin; mkdir -p ${directory} && printf '%s' "$1" > ${directory}/bind && cat > ${directory}/gatekeeper.cjs.new && mv ${directory}/gatekeeper.cjs.new ${directory}/gatekeeper.cjs`;
    const program = record.purpose === undefined ? PROGRAM : `module.exports.spacePurpose=${JSON.stringify(record.purpose)};\n${PROGRAM}`;
    const stored = await exec(record, 'gatekeeper', ['/bin/sh', '-c', script, 'sh', addresses(record.subnet).gatekeeper], program);
    if (stored.code !== 0) throw new SpaceError('gatekeeper_setup_failed', stored.stderr.slice(-2000));
    const ready = await exec(record, 'gatekeeper', ['/usr/bin/node', '-e',
      'const http=require("node:http");const end=Date.now()+60000;const check=()=>{const r=http.get("http://127.0.0.1:9099/health",res=>{res.resume();if(res.statusCode===200)process.exit(0);else retry()});r.setTimeout(1000,()=>r.destroy());r.on("error",retry)};const retry=()=>{if(Date.now()>end)process.exit(1);setTimeout(check,100)};check();']);
    if (ready.code !== 0) throw new SpaceError('gatekeeper_not_ready', 'The host space gatekeeper did not become ready');
  };
  const start = async (original, { fresh = false, assertion = null } = {}) => {
    if (original.place === 'host-root' && !fresh) await authorizeRoot({ op: 'start', id: original.id, spec: original, assertion });
    const record = { ...original };
    const unit = names(record.id);
    if ((await showUnit(system, unit.space)).ActiveState === 'active') {
      if ((await showUnit(system, unit.gatekeeper)).ActiveState !== 'active') await startGatekeeper(record);
      return;
    }
    // Idle stop ends only the space. Stop its still-live gatekeeper and slirp before
    // replacing namespace pins, so no active unit keeps the previous network alive.
    await stop(record);
    // The current installed tools only replace tools of a stopped space, after root authorization.
    const current = await fs.readFile(path.join(paths.state, 'current-tools.json'), 'utf8').then(JSON.parse, (error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!fresh && current && await tools.ready(current.key)) {
      record.toolsKey = current.key;
      await state.save(record);
    }
    try {
      await network.create(record);
      const directory = path.join(paths.privateState, record.id);
      for (const name of ['home', 'work']) {
        const source = path.join(directory, name);
        const existing = await fs.lstat(source).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (existing && !existing.isDirectory()) throw new SpaceError('space_state_unsafe', 'Space work and home must be real directories');
        await fs.mkdir(source, { recursive: true, mode: 0o700 });
      }
      await prepareMcpSubjectFolder(paths, record.id);
      await writeUnits(record);
      await startGatekeeper(record);
      await requireVerified(record);
      await run(['start', unit.space]);
      await server.linkPlugin(record.id);
      if (fresh) await server.writeToken(record.id, createSpaceToken());
      await server.waitUntilReady(record.id);
    } catch (error) {
      const cleanup = await stop(record).catch((failure) => failure.message);
      throw new SpaceError(error.code ?? 'space_start_failed', error.message, { original: error.details, cleanup });
    }
  };
  const stop = async (record) => {
    // Fail here before removing the namespace when systemd cannot stop a process.
    for (const name of [names(record.id).space, names(record.id).gatekeeper, names(record.id).net]) {
      const result = await system.run('/usr/bin/systemctl', ['stop', name]);
      if (result.code !== 0 && !/not loaded|not found|does not exist/.test(result.stderr)) throw new SpaceError('space_stop_failed', result.stderr.slice(-2000));
    }
    await network.destroy(record.id);
  };
  const remove = async (record) => {
    await stop(record);
    for (const name of Object.values(names(record.id))) await fs.rm(path.join(paths.units, name), { force: true });
    await run(['daemon-reload']);
    // Stopping leaves the slice active and the server's unit failed: it exits non-zero on SIGTERM. Neither
    // has a file any more, so these end what systemd still holds of the space.
    const units = Object.values(names(record.id));
    await system.run('/usr/bin/systemctl', ['stop', names(record.id).slice]);
    await system.run('/usr/bin/systemctl', ['reset-failed', ...units]);
    await fs.rm(path.join(paths.privateState, record.id), { recursive: true, force: true });
    // A root space unit from before stateSource left a real folder here; a DynamicUser space a link.
    await fs.rm(path.join(paths.spaceState, record.id), { recursive: true, force: true });
    const removed = await system.run('/usr/sbin/userdel', [`openchamber-net-${record.id}`]);
    if (removed.code !== 0 && removed.code !== 6) throw new SpaceError('space_remove_failed', removed.stderr.slice(-2000));
    await state.remove(record.id);
    return { removed: [{ kind: 'space', name: record.id }], failed: [] };
  };
  const create = async (request) => {
    if (request.place === 'host-root') await authorizeRoot({ op: 'create', id: request.spec.id, spec: request.spec, assertion: request.assertion ?? null });
    if (await state.read(request.spec.id)) throw new SpaceError('space_name_taken', 'This host space id is already in use');
    // A new metadata record cannot authorize deletion or adoption of a pre-existing resource.
    // Restarts use their existing root-owned record; fresh creates must find every name free.
    for (const name of Object.values(names(request.spec.id))) {
      const unit = await showUnit(system, name);
      // systemd synthesizes an empty inactive slice on a read of any valid slice name.
      const emptySlice = name.endsWith('.slice') && !unit.FragmentPath && !unit.DropInPaths && unit.ActiveState === 'inactive';
      if (unit.LoadState !== 'not-found' && !emptySlice) throw new SpaceError('space_name_taken', `The unit ${name} already exists`);
    }
    for (const file of [path.join(paths.pins, request.spec.id), `/run/netns/ocs-${request.spec.id}`, path.join(paths.privateState, request.spec.id), path.join(paths.spaceState, request.spec.id)]) {
      const exists = await fs.lstat(file).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
      if (exists) throw new SpaceError('space_name_taken', 'A host resource already uses this space id');
    }
    for (const device of [`vs-${request.spec.id}`, `vg-${request.spec.id}`]) {
      const found = await system.run(ipPath, ['link', 'show', device]);
      if (found.code === 0) throw new SpaceError('space_name_taken', 'A host interface already uses this space id');
      if (!/does not exist|Cannot find device/.test(found.stderr)) throw new SpaceError('hostd_command_failed', found.stderr.slice(-2000));
    }
    const account = await system.run('/usr/bin/getent', ['passwd', `openchamber-net-${request.spec.id}`]);
    if (account.code === 0) throw new SpaceError('space_name_taken', 'A host account already uses this space id');
    if (account.code !== 2) throw new SpaceError('hostd_command_failed', 'Cannot establish that the space account name is free');
    if (!await tools.ready(request.toolsKey)) throw new SpaceError('tools_missing', 'Prepare the host tools before creating a space');
    const record = { ...request.spec, place: request.place, subnet: allocateSubnet(await state.list()), toolsKey: request.toolsKey, startConfig: request.startConfig, lastExit: null };
    await state.save(record);
    try { await start(record, { fresh: true }); }
    catch (error) {
      const rollback = await remove(record).catch((failure) => ({ failed: [{ kind: 'space', name: record.id, message: failure.message }] }));
      throw new SpaceError(error.code ?? 'space_create_failed', error.message, { original: error.details, rollbackFailures: rollback.failed });
    }
  };
  return { create, start, stop, remove, verify };
}

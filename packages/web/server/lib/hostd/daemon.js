import fs from 'node:fs/promises';
import path from 'node:path';
import { SpaceError } from '../spaces/errors.js';
import { createState, layout, writeJson } from './state.js';
import { createSystem, checkRequirements, showUnit } from './system.js';
import { createNetwork } from './network.js';
import { createExecutor } from './exec.js';
import { createTools } from './tools.js';
import { createLifecycle } from './lifecycle.js';
import { ROOT_OPERATIONS, createRootOps } from './root-ops.js';
import { names } from './units.js';

export async function createDaemon({ paths = layout(), system = createSystem(), rootOps = null } = {}) {
  const state = createState(paths);
  await state.initialize();
  const tools = createTools({ system, paths, state });
  const executor = createExecutor({ system, paths, state });
  const root = rootOps ?? createRootOps({ paths, state, run: system.run });
  // Keep check reachable when a required executable is absent at socket activation.
  const lifecycle = async () => {
    const ipPath = await system.ipPath();
    const network = createNetwork({ system, paths, ipPath });
    return createLifecycle({ system, paths, state, tools, network, executor, ipPath, authorizeRoot: root.authorize });
  };
  let pending = Promise.resolve();
  const serialized = (operation) => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  const list = async (place) => {
    const result = [];
    for (const record of (await state.list()).filter((entry) => entry.place === place)) {
      const unit = names(record.id);
      const space = await showUnit(system, unit.space);
      const guard = await showUnit(system, unit.gatekeeper);
      const running = space.ActiveState === 'active';
      const missing = [];
      for (const name of ['home', 'work']) if (!await fs.stat(path.join(paths.privateState, record.id, name)).then(() => true, () => false)) missing.push(name);
      if (running && guard.ActiveState !== 'active') missing.push(unit.gatekeeper);
      const entry = {
        id: record.id, name: record.name, project: record.project, created: record.created,
        state: missing.includes('home') || missing.includes('work') ? 'missing' : running ? 'running' : 'exited',
        stoppedIdle: !running && record.lastExit?.code === 'exited' && record.lastExit?.status === '75',
        gatekeeperRunning: guard.ActiveState === 'active', orphans: [], damaged: missing.length > 0, missing,
      };
      if (record.purpose !== undefined) entry.purpose = record.purpose;
      result.push(entry);
    }
    return result;
  };
  const disk = async (place) => {
    const size = async (directory) => {
      const result = await system.run('/usr/bin/du', ['--bytes', '--summarize', '--', directory]);
      if (result.code !== 0) throw new SpaceError('disk_unreadable', result.stderr.slice(-2000));
      return Number(result.stdout.split(/\s+/)[0]);
    };
    const records = await state.list();
    const used = new Set(records.map((record) => record.toolsKey));
    const bytesBySpace = {};
    for (const record of records.filter((entry) => entry.place === place)) bytesBySpace[record.id] = await size(path.join(paths.privateState, record.id));
    let toolsBytes = 0;
    let freeBytes = 0;
    for (const key of await fs.readdir(paths.tools)) if (/^[0-9a-f]{16}$/.test(key)) {
      const bytes = await size(path.join(paths.tools, key));
      toolsBytes += bytes;
      if (!used.has(key)) freeBytes += bytes;
    }
    return { imageBytes: 0, imagePulling: false, imageFailure: null, toolsBytes, spacesBytes: Object.values(bytesBySpace).reduce((sum, value) => sum + value, 0), bytesBySpace, freeBytes, freesImage: false };
  };
  const request = async (value, io) => {
    if (ROOT_OPERATIONS.has(value.op)) return root.handle(value);
    switch (value.op) {
      case 'check': return checkRequirements(system);
      case 'list': return list(value.place);
      case 'disk': return disk(value.place);
      case 'tools-ensure': {
        const result = await tools.ensure(value.key, io.input);
        await writeJson(path.join(paths.state, 'current-tools.json'), { key: value.key });
        return result;
      }
      case 'tools-prune': return serialized(() => tools.prune(value.keep));
      case 'exec': case 'attach':
        // A root space runs as root. Reaching into it is only for the front door of a separated
        // install: after a rollback or a reinstall onto one account, the human's agents hold the socket.
        if (value.place === 'host-root' && !await root.separation()) {
          throw new SpaceError('agent_separation_missing', 'A root space is reached only while OpenChamber runs with its agent on an account of its own');
        }
        return executor.run(value, io);
      case 'create': return serialized(async () => (await lifecycle()).create(value));
      case 'start': return serialized(async () => {
        const record = await state.requireRecord(value.place, value.id);
        return (await lifecycle()).start(record, { assertion: value.assertion ?? null });
      });
      case 'stop': return serialized(async () => (await lifecycle()).stop(await state.requireRecord(value.place, value.id)));
      case 'verify': return (await lifecycle()).verify(await state.requireRecord(value.place, value.id));
      case 'remove': return serialized(async () => {
        const record = await state.read(value.id);
        if (!record || record.place !== value.place) return { removed: [], failed: [] };
        try { return await (await lifecycle()).remove(record); }
        catch (error) { return { removed: [], failed: [{ kind: 'space', name: value.id, message: error.message }] }; }
      });
      default: throw new SpaceError('invalid_request', 'Unknown hostd operation');
    }
  };
  return { request, state, executor, paths, system };
}

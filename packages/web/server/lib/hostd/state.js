import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SpaceError } from '../spaces/errors.js';
import { spaceId } from './validation.js';

export function layout(root = '/') {
  const at = (name) => path.join(root, name);
  return {
    state: at('/var/lib/openchamber-hostd'),
    metadata: at('/var/lib/openchamber-hostd/spaces'),
    tools: at('/var/lib/openchamber-hostd/tools'),
    runtime: at('/run/openchamber-hostd'),
    pins: at('/run/openchamber-hostd/ns'),
    units: at('/run/systemd/system'),
    privateState: at('/var/lib/private/openchamber-spaces'),
    spaceState: at('/var/lib/openchamber-spaces'),
    // The protected MCP service's subject folders; units.js binds a space's from the same place.
    mcpSubjects: at('/run/openchamber-protected-mcp/subjects'),
  };
}

export async function writeJson(file, value) {
  const temporary = `${file}.${randomBytes(6).toString('hex')}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export function allocateSubnet(records) {
  const used = new Set(records.map((record) => record.subnet));
  for (let index = 0; index < 16384; index += 1) if (!used.has(index)) return index;
  throw new SpaceError('subnets_exhausted', 'All host space subnets are in use');
}

export function addresses(index) {
  if (!Number.isInteger(index) || index < 0 || index >= 16384) throw new SpaceError('invalid_subnet', 'Invalid host space subnet');
  const prefix = `10.233.${Math.floor(index / 64)}.`;
  const base = (index % 64) * 4;
  return { gatekeeper: `${prefix}${base + 1}`, space: `${prefix}${base + 2}` };
}

export function createState(paths) {
  const file = (id) => path.join(paths.metadata, `${spaceId(id)}.json`);
  const initialize = async () => {
    for (const directory of [paths.state, paths.metadata, paths.tools, paths.pins]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
    }
  };
  const read = async (id) => {
    try { return JSON.parse(await fs.readFile(file(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const requireRecord = async (place, id) => {
    const record = await read(id);
    if (!record || record.place !== place) throw new SpaceError('space_not_found', `There is no space ${id} on ${place}`);
    return record;
  };
  const list = async () => {
    const names = await fs.readdir(paths.metadata);
    return Promise.all(names.filter((name) => /^[0-9a-f]{12}\.json$/.test(name)).map((name) => read(name.slice(0, 12))));
  };
  return { initialize, read, requireRecord, list, save: (record) => writeJson(file(record.id), record), remove: (id) => fs.rm(file(id), { force: true }) };
}

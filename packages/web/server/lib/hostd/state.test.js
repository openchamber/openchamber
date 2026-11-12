import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addresses, allocateSubnet, createState, layout } from './state.js';
import { createTools, sealTools } from './tools.js';

const directories = [];
const temporary = async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-state-')); directories.push(root); return root; };
afterEach(async () => { for (const root of directories.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe('hostd state', () => {
  it('allocates distinct /30 subnets and reuses only a released slot', () => {
    const records = [{ subnet: 0 }, { subnet: 2 }];
    const chosen = allocateSubnet(records);
    expect(chosen).toBe(1);
    expect(addresses(chosen)).toEqual({ gatekeeper: '10.233.0.5', space: '10.233.0.6' });
    expect(addresses(16383)).toEqual({ gatekeeper: '10.233.255.253', space: '10.233.255.254' });
  });
  it('refuses allocation when the pool is full', () => {
    expect(() => allocateSubnet(Array.from({ length: 16384 }, (_, subnet) => ({ subnet })))).toThrow(expect.objectContaining({ code: 'subnets_exhausted' }));
  });
  it('persists records privately and refuses cross-place adoption', async () => {
    const root = await temporary();
    const paths = layout(root);
    const state = createState(paths);
    await state.initialize();
    const record = { id: '123456abcdef', place: 'host', subnet: 0 };
    await state.save(record);
    expect(await state.requireRecord('host', record.id)).toEqual(record);
    await expect(state.requireRecord('host-root', record.id)).rejects.toMatchObject({ code: 'space_not_found' });
    expect((await fs.stat(paths.metadata)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(paths.metadata, `${record.id}.json`))).mode & 0o777).toBe(0o600);
  });
  it('seals executable and plain files without following internal links', async () => {
    const directory = await temporary();
    await fs.mkdir(path.join(directory, 'bin'));
    await fs.writeFile(path.join(directory, 'bin', 'run'), 'code', { mode: 0o777 });
    await fs.writeFile(path.join(directory, 'data'), 'data', { mode: 0o666 });
    await fs.symlink('../data', path.join(directory, 'bin', 'link'));
    const owned = [];
    await sealTools({ directory, system: { chown: async (file, uid, gid) => { owned.push({ file, uid, gid }); } } });
    expect((await fs.stat(path.join(directory, 'data'))).mode & 0o777).toBe(0o644);
    expect((await fs.stat(path.join(directory, 'bin', 'run'))).mode & 0o777).toBe(0o755);
    expect(await fs.readlink(path.join(directory, 'bin', 'link'))).toBe('../data');
    expect(owned).toEqual(expect.arrayContaining([{ file: directory, uid: 0, gid: 0 }, { file: path.join(directory, 'bin', 'link'), uid: 0, gid: 0 }]));
  });
  it('refuses an external symlink before changing its target', async () => {
    const directory = await temporary();
    const outside = await temporary();
    const target = path.join(outside, 'secret');
    await fs.writeFile(target, 'unchanged', { mode: 0o600 });
    await fs.symlink(target, path.join(directory, 'escape'));
    await expect(sealTools({ directory, system: { chown: async () => {} } })).rejects.toMatchObject({ code: 'tools_unsafe_link' });
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(target, 'utf8')).toBe('unchanged');
  });
  it('refuses a filler that replaces its output directory with a symlink', async () => {
    const staging = await temporary();
    const outside = await temporary();
    await fs.symlink(outside, path.join(staging, 'tools'));
    const changed = [];
    await expect(sealTools({ directory: path.join(staging, 'tools'), system: { chown: async (file) => { changed.push(file); } } })).rejects.toMatchObject({ code: 'tools_unsafe_file' });
    expect(changed).toEqual([]);
    expect((await fs.stat(outside)).mode & 0o777).toBe(0o700);
  });
  it('reads only a regular key-sized tools marker', async () => {
    const root = await temporary();
    const paths = layout(root);
    const key = '1234567890abcdef';
    const directory = path.join(paths.tools, key);
    await fs.mkdir(directory, { recursive: true });
    const marker = path.join(directory, '.filled');
    const tools = createTools({ paths, system: {}, state: {} });
    await fs.symlink('/dev/zero', marker);
    expect(await tools.ready(key)).toBe(false);
    await fs.rm(marker);
    await fs.writeFile(marker, key.repeat(2));
    expect(await tools.ready(key)).toBe(false);
    await fs.writeFile(marker, key);
    expect(await tools.ready(key)).toBe(true);
  });
});

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfigEdit, readSuggestedTasksConfig } from './config.js';
import { listRepositoryLenses } from './repo-lenses.js';

const lens = { id: 'a', name: 'A', prompt: 'Find defects.' };

describe('lens configuration compatibility', () => {
  it('loads old configs with denied MCP access and the default execution policy', () => {
    const read = readSuggestedTasksConfig({ lenses: [lens] });
    expect(read.ok).toBe(true);
    expect(read.config.lenses[0]).toMatchObject({ mcp: [], permissionMode: 'default' });
    expect(parseConfigEdit(JSON.parse(JSON.stringify(read.config))).lenses).toEqual(read.config.lenses);
  });

  it.each(['default', 'ask', 'safety', 'auto'])('round trips per-tool rules and %s mode', (permissionMode) => {
    const mcp = [{ server: 'jira', tools: { search: 'allow', update: 'ask', delete: 'deny' } }];
    const config = parseConfigEdit({ lenses: [{ ...lens, mcp, permissionMode }] });
    expect(readSuggestedTasksConfig(JSON.parse(JSON.stringify(config))).config.lenses[0]).toMatchObject({ mcp, permissionMode });
  });

  it('rejects invalid modes, effects, empty names and more than 10 servers', () => {
    for (const fields of [
      { permissionMode: 'all' },
      { mcp: [{ server: 'jira', tools: { search: true } }] },
      { mcp: [{ server: '', tools: {} }] },
      { mcp: [{ server: 'jira', tools: { ' ': 'allow' } }] },
      { mcp: Array.from({ length: 11 }, (_, index) => ({ server: `server${index}`, tools: {} })) },
    ]) expect(() => parseConfigEdit({ lenses: [{ ...lens, ...fields }] })).toThrow();
  });

  it('preserves old repository approvals and requires approval when MCP or mode changes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lens-config-'));
    try {
      const lenses = path.join(directory, '.agents/lenses');
      await fs.mkdir(lenses, { recursive: true });
      const file = path.join(lenses, 'a.md');
      const original = { name: 'A', prompt: 'Find defects.', model: { useDefaults: true }, web: false, action: 'suggest' };
      const fingerprint = createHash('sha256').update(JSON.stringify(original)).digest('hex');
      const write = (fields = '') => fs.writeFile(file, `---\nname: A\n${fields}---\nFind defects.\n`);
      await write();
      expect((await listRepositoryLenses(directory, { [file]: fingerprint }))[0]).toMatchObject({ status: 'enabled', mcp: [], permissionMode: 'default' });
      await write('permissionMode: auto\n');
      expect((await listRepositoryLenses(directory, { [file]: fingerprint }))[0].status).toBe('changed');
      await write('mcp:\n  - server: jira\n    tools:\n      search: allow\n');
      expect((await listRepositoryLenses(directory, { [file]: fingerprint }))[0]).toMatchObject({ status: 'changed', mcp: [{ server: 'jira', tools: { search: 'allow' } }] });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

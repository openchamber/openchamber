import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createSpaceRecords, networkSchema } from './space-records.js';

const ID = 'a1b2c3d4e5f6';
const folders = [];
const temporary = () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-space-records-'));
  folders.push(folder);
  return folder;
};
const quiet = { warn: () => {} };

afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

describe('space records', () => {
  it('writes a record readable by the user only, reads it back, changes a field and removes it', () => {
    const dataDir = temporary();
    const records = createSpaceRecords({ dataDir, logger: quiet });
    expect(records.read(ID)).toEqual({ status: 'missing', record: null });

    const written = records.write(ID, { network: { mode: 'allowlist', domains: ['api.anthropic.com'] }, repository: '/home/me/project' });
    expect(written).toEqual({ version: 1, network: { mode: 'allowlist', domains: ['api.anthropic.com'] }, repository: '/home/me/project', spacePath: null, base: null, history: 'pending' });
    const file = path.join(dataDir, 'spaces', 'records', `${ID}.json`);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual([`${ID}.json`]);

    expect(records.update(ID, { spacePath: `/spaces/${ID}/project`, base: 'a'.repeat(40) }).record).toMatchObject({ spacePath: `/spaces/${ID}/project`, base: 'a'.repeat(40), history: 'pending' });
    expect(records.update(ID, { history: 'sent' }).record.history).toBe('sent');
    expect(records.read(ID)).toEqual({ status: 'ok', record: expect.objectContaining({ history: 'sent', network: { mode: 'allowlist', domains: ['api.anthropic.com'] } }) });

    records.remove(ID);
    expect(records.read(ID)).toEqual({ status: 'missing', record: null });
    records.remove(ID);
  });

  it('reports a file it cannot read as unreadable, never as a fresh record, and does not write over it', () => {
    const dataDir = temporary();
    const records = createSpaceRecords({ dataDir, logger: quiet });
    const directory = path.join(dataDir, 'spaces', 'records');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${ID}.json`), '{ "version": 1, "network": { "mode": "everything" } }');
    expect(records.read(ID)).toEqual({ status: 'unreadable', record: null });
    fs.writeFileSync(path.join(directory, `${ID}.json`), 'not json');
    expect(records.read(ID)).toEqual({ status: 'unreadable', record: null });
    expect(records.update(ID, { history: 'sent' })).toEqual({ status: 'unreadable', record: null });
    expect(fs.readFileSync(path.join(directory, `${ID}.json`), 'utf8')).toBe('not json');
  });

  it('refuses a record that is not one, and an id that is not a space id', () => {
    const records = createSpaceRecords({ dataDir: temporary(), logger: quiet });
    expect(() => records.write(ID, { network: { mode: 'open', domains: ['not a name'] } })).toThrow();
    expect(() => records.write('../etc', { network: { mode: 'open' } })).toThrow(/space id/i);
    expect(() => records.read('../etc')).toThrow(/space id/i);
  });

  it('takes domain names the allowlist takes, and nothing else', () => {
    const accepted = (domains) => networkSchema.safeParse({ mode: 'allowlist', domains }).success;
    expect(accepted(['api.anthropic.com', 'registry.npmjs.org', 'a-b.example'])).toBe(true);
    expect(accepted([])).toBe(true);
    for (const bad of [['localhost'], ['10.0.0.1'], ['Api.Example.com'], ['a_b.example'], ['-a.example'], ['a.example.'], ['a..example'], ['https://a.example'], ['a.example/path']]) {
      expect(accepted(bad), bad[0]).toBe(false);
    }
    expect(networkSchema.safeParse({ mode: 'open' }).data).toEqual({ mode: 'open', domains: [] });
    expect(networkSchema.safeParse({ mode: 'all' }).success).toBe(false);
  });
});

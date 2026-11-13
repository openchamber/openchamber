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
  it('preserves an approval purpose across host reconstruction and rejects relabeling in either direction', () => {
    // Given a fresh protected record and a separate ordinary space with an irrevocable grant.
    const dataDir = temporary();
    const records = createSpaceRecords({ dataDir, logger: quiet });
    const protectedRecord = { purpose: 'pr-fix-loop-approval', approvalModel: { providerID: 'openai', modelID: 'gpt-4.1' }, network: { mode: 'allowlist', domains: [] } };
    records.write(ID, protectedRecord);
    const ordinaryId = '112233445566';
    records.write(ordinaryId, { network: { mode: 'open' }, grants: [{ kind: 'domain', id: 'github', upstream: 'https://api.github.com' }] });
    const reopened = createSpaceRecords({ dataDir, logger: quiet });
    // When a record update or a whole replacement tries to change either purpose.
    for (const mutate of [
      () => reopened.update(ID, { purpose: 'general' }),
      () => reopened.write(ID, { network: { mode: 'open' } }),
      () => reopened.write(ordinaryId, protectedRecord),
      () => reopened.update(ID, { approvalModel: { providerID: 'openai', modelID: 'gpt-5.4' } }),
    ]) expect(mutate).toThrow(expect.objectContaining({ code: 'space_purpose_immutable' }));
    // Then unrelated progress can still be persisted without weakening the purpose.
    expect(reopened.update(ID, { history: 'sent' }).record).toMatchObject({ purpose: protectedRecord.purpose, history: 'sent' });
  });

  it.each([
    { network: { mode: 'open' } },
    { network: { mode: 'allowlist', domains: ['api.github.com'] } },
    { grants: [{ kind: 'domain', id: 'github', upstream: 'https://api.github.com' }] },
    { grants: [{ kind: 'custom', id: 'proxy', provider: 'proxy' }] },
  ])('refuses unsafe persisted approval permissions %j', (changes) => {
    // Given an approval record with no publishing capability.
    const records = createSpaceRecords({ dataDir: temporary(), logger: quiet });
    records.write(ID, { purpose: 'pr-fix-loop-approval', approvalModel: { providerID: 'openai', modelID: 'gpt-4.1' }, network: { mode: 'allowlist', domains: [] } });
    // When a generic persistence mutation adds unsafe access.
    expect(() => records.update(ID, changes)).toThrow();
    // Then the original valid profile remains usable.
    expect(records.read(ID).record).toMatchObject({ purpose: 'pr-fix-loop-approval', network: { mode: 'allowlist', domains: [] }, grants: [] });
  });

  it.each([undefined, { providerID: 'openai', modelID: 'gpt-5-search-api' }])('restores no permissions from a protected record with an unreviewed model %j', (approvalModel) => {
    // Given a legacy or altered protected record with an otherwise supported model grant.
    const dataDir = temporary();
    const directory = path.join(dataDir, 'spaces', 'records');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${ID}.json`), JSON.stringify({ version: 1, purpose: 'pr-fix-loop-approval', approvalModel, network: { mode: 'allowlist', domains: [] }, grants: [{ kind: 'model', id: 'openai', provider: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization', source: { kind: 'env', name: 'MODEL_KEY' } }] }));
    // When a host reconstructs its records.
    const read = createSpaceRecords({ dataDir, logger: quiet }).read(ID);
    // Then it cannot restore access using an implicit or hosted-search selection.
    expect(read).toEqual({ status: 'unreadable', record: null });
  });

  it('drops a malformed display title while still enforcing protected record permissions', () => {
    const dataDir = temporary();
    const records = createSpaceRecords({ dataDir, logger: quiet });
    const record = records.write(ID, { purpose: 'pr-fix-loop-approval',
      approvalModel: { providerID: 'openai', modelID: 'gpt-4.1' }, network: { mode: 'allowlist', domains: [] } });
    const file = path.join(dataDir, 'spaces', 'records', `${ID}.json`);
    const malformedTitle = { title: 42, by: 'agent' };
    fs.writeFileSync(file, JSON.stringify({ ...record, taskTitle: malformedTitle }));
    expect(records.read(ID)).toEqual({ status: 'ok', record: { ...record, taskTitle: null } });
    fs.writeFileSync(file, JSON.stringify({ ...record, taskTitle: malformedTitle, network: { mode: 'open', domains: [] } }));
    expect(records.read(ID)).toEqual({ status: 'unreadable', record: null });
  });

  it('writes a record readable by the user only, reads it back, changes a field and removes it', () => {
    const dataDir = temporary();
    const records = createSpaceRecords({ dataDir, logger: quiet });
    expect(records.read(ID)).toEqual({ status: 'missing', record: null });

    const written = records.write(ID, { network: { mode: 'allowlist', domains: ['api.anthropic.com'] }, repository: '/home/me/project' });
    expect(written).toEqual({ version: 1, purpose: 'general', approvalModel: null, placeId: 'docker', name: null, taskTitle: null, created: null, network: { mode: 'allowlist', domains: ['api.anthropic.com'] }, repository: '/home/me/project', spacePath: null, base: null, history: 'pending', grants: [], setup: null });
    const file = path.join(dataDir, 'spaces', 'records', `${ID}.json`);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual([`${ID}.json`]);

    expect(records.update(ID, { spacePath: `/spaces/${ID}/project`, base: 'a'.repeat(40) }).record).toMatchObject({ spacePath: `/spaces/${ID}/project`, base: 'a'.repeat(40), history: 'pending' });
    expect(records.update(ID, { history: 'sent' }).record.history).toBe('sent');
    expect(records.read(ID)).toEqual({ status: 'ok', record: expect.objectContaining({ history: 'sent', network: { mode: 'allowlist', domains: ['api.anthropic.com'] } }) });

    records.remove(ID);
    expect(records.read(ID)).toEqual({ status: 'missing', record: null });
    records.remove(ID);
    expect(records.list()).toEqual([]);
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

  it('remembers a grant without its value, and refuses one that carries a value under any name', () => {
    const records = createSpaceRecords({ dataDir: temporary(), logger: quiet });
    const model = { kind: 'model', id: 'anthropic', provider: 'anthropic', upstream: 'https://api.anthropic.com/v1', header: 'x-api-key', source: { kind: 'env', name: 'ANTHROPIC_API_KEY' } };
    const typed = { ...model, id: 'openai', provider: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization', source: { kind: 'typed' } };
    const domain = { kind: 'domain', id: 'open-0a1b2c3d4e5f', upstream: 'https://registry.example.com/npm/' };
    const login = { kind: 'login', id: 'openai', provider: 'openai', method: 'chatgpt-token-sharing' };
    const custom = { kind: 'custom', id: 'ollama-local', provider: 'ollama-local' };
    const written = records.write(ID, { network: { mode: 'open' }, grants: [model, typed, domain, login, custom] });
    expect(written.grants).toEqual([model, typed, domain, login, custom]);
    expect(records.read(ID).record.grants).toEqual([model, typed, domain, login, custom]);

    for (const bad of [
      { ...model, secret: 'sk-live-1' },
      { ...login, access: 'eyJ-live' },
      { ...login, upstream: 'https://api.openai.com/v1' },
      { ...login, method: 'not a method' },
      // A custom provider's address and key live on the host, never in the record.
      { ...custom, upstream: 'http://localhost:11434/v1' },
      { ...custom, secret: 'sk-live-1' },
      { ...model, value: 'sk-live-1' },
      { ...model, source: { kind: 'typed', value: 'sk-live-1' } },
      { ...model, source: { kind: 'env', name: 'ANTHROPIC_API_KEY', value: 'sk-live-1' } },
      { ...domain, secret: 'sk-live-1' },
      { ...domain, header: 'authorization' },
      { ...model, upstream: 'file:///etc/passwd' },
      { ...model, header: 'X-Api-Key' },
      { ...model, id: '../x' },
      { ...model, source: { kind: 'file', name: '/tmp/key' } },
    ]) {
      expect(() => records.write(ID, { network: { mode: 'open' }, grants: [bad] }), JSON.stringify(bad)).toThrow();
    }
    // A grant this host cannot read, from a later version, is left out; the rest of the record stays.
    const later = temporary();
    const withUnknown = createSpaceRecords({ dataDir: later, logger: quiet });
    fs.mkdirSync(path.join(later, 'spaces', 'records'), { recursive: true });
    fs.writeFileSync(path.join(later, 'spaces', 'records', `${ID}.json`), JSON.stringify({ version: 1, network: { mode: 'allowlist', domains: ['a.example.com'] }, repository: '/home/me/project', history: 'sent', grants: [{ kind: 'git', id: 'github' }, domain] }));
    expect(withUnknown.read(ID)).toEqual({ status: 'ok', record: expect.objectContaining({ network: { mode: 'allowlist', domains: ['a.example.com'] }, repository: '/home/me/project', history: 'sent', grants: [domain] }) });
    // A malformed upstream is refused, not thrown.
    expect(() => records.write(ID, { network: { mode: 'open' }, grants: [{ ...domain, upstream: 'not a url' }] })).toThrow();

    // A record written before grants existed reads back with none.
    const dataDir = temporary();
    const older = createSpaceRecords({ dataDir, logger: quiet });
    fs.mkdirSync(path.join(dataDir, 'spaces', 'records'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'spaces', 'records', `${ID}.json`), JSON.stringify({ version: 1, network: { mode: 'open', domains: [] } }));
    expect(older.read(ID)).toEqual({ status: 'ok', record: expect.objectContaining({ grants: [] }) });
  });

  it('keeps the last run of the setup commands, and forgets only a setup it cannot read', () => {
    const dataDir = temporary();
    const records = createSpaceRecords({ dataDir, logger: quiet });
    records.write(ID, { network: { mode: 'open' }, grants: [] });
    const failed = { state: 'failed', total: 2, index: 1, command: 'npm install', exitCode: 1, timedOut: false, output: 'npm ERR! 403', finishedAt: '2026-09-28T10:00:00.000Z' };
    expect(records.update(ID, { setup: failed }).record.setup).toEqual(failed);
    expect(records.read(ID).record.setup).toEqual(failed);
    // A value the host never writes is refused rather than kept.
    expect(() => records.update(ID, { setup: { ...failed, secret: 'x' } })).toThrow();
    expect(() => records.update(ID, { setup: { ...failed, output: 'x'.repeat(40 * 1024) } })).toThrow();

    // A setup from a later version leaves the network and the grants readable.
    const file = path.join(dataDir, 'spaces', 'records', `${ID}.json`);
    fs.writeFileSync(file, JSON.stringify({ version: 1, network: { mode: 'allowlist', domains: ['a.example.com'] }, setup: { state: 'paused' } }));
    expect(records.read(ID)).toEqual({ status: 'ok', record: expect.objectContaining({ network: { mode: 'allowlist', domains: ['a.example.com'] }, setup: null }) });
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
  it('lists every readable record with its place, name and time, and reads a record from before there were two places as the local Docker place', () => {
    const dataDir = temporary();
    const records = createSpaceRecords({ dataDir, logger: quiet });
    expect(records.list()).toEqual([]);
    records.write(ID, { placeId: 'docker-ssh', name: 'On the box', created: '2026-10-11T10:00:00.000Z', network: { mode: 'open' }, repository: '/home/me/project' });
    // A record a host before this one wrote: no place, no name, no time.
    fs.writeFileSync(path.join(dataDir, 'spaces', 'records', 'b1b2c3d4e5f6.json'), JSON.stringify({ version: 1, network: { mode: 'open', domains: [] }, repository: '/home/me/other' }));
    // Not records: a half-written temporary file and a stranger's file.
    fs.writeFileSync(path.join(dataDir, 'spaces', 'records', 'c1c2c3d4e5f6.json.1.tmp'), '{');
    fs.writeFileSync(path.join(dataDir, 'spaces', 'records', 'notes.json'), '{}');
    expect(records.list().map(({ id, record }) => [id, record.placeId, record.name, record.created]).sort()).toEqual([
      [ID, 'docker-ssh', 'On the box', '2026-10-11T10:00:00.000Z'],
      ['b1b2c3d4e5f6', 'docker', null, null],
    ]);
  });
});

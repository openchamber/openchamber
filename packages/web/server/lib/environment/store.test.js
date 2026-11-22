import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEnvironmentStore, EnvironmentPatchError, EnvironmentStoreError, MAX_ENVIRONMENT_FILE_BYTES } from './store.js';

describe('environment store', () => {
  let directory;
  let filePath;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-environment-'));
    filePath = path.join(directory, 'environment.json');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('answers names only and keeps values in a 0600 file', async () => {
    const store = createEnvironmentStore({ filePath });
    expect(await store.updateUser({ variables: { API_TOKEN: 'secret', DEBUG: '1' } })).toEqual({ names: ['API_TOKEN', 'DEBUG'] });
    expect(store.describeUser()).toEqual({ names: ['API_TOKEN', 'DEBUG'] });
    expect(JSON.stringify(store.describeUser())).not.toContain('secret');
    expect(store.userVariables()).toEqual({ API_TOKEN: 'secret', DEBUG: '1' });
    if (process.platform !== 'win32') {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it('sets, removes and keeps variables by patch', async () => {
    const store = createEnvironmentStore({ filePath });
    await store.updateUser({ variables: { A: '1', B: '2' } });
    await store.updateUser({ variables: { A: null, C: '3' } });
    expect(store.userVariables()).toEqual({ B: '2', C: '3' });
    await store.updateUser({ variables: { B: null, C: null } });
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 1 });
  });

  it('stores a project command and variables and drops an emptied project', async () => {
    const store = createEnvironmentStore({ filePath });
    expect(await store.updateProject('path_abc', { variables: { GOFLAGS: '-mod=mod' }, command: '  direnv export json ' }))
      .toEqual({ names: ['GOFLAGS'], command: 'direnv export json' });
    expect(store.projectEntry('path_abc')).toEqual({ variables: { GOFLAGS: '-mod=mod' }, command: 'direnv export json' });
    expect(store.hasProjectEntries()).toBe(true);
    await store.updateProject('path_abc', { variables: { GOFLAGS: null }, command: null });
    expect(store.hasProjectEntries()).toBe(false);
    expect(store.describeProject('path_abc')).toEqual({ names: [], command: null });
  });

  it.each([
    [{ variables: { DEBUG: '1' }, command: 'env' }, { variables: { DEBUG: '1' }, command: 'env' }],
    [{ variables: { DEBUG: '1' } }, { variables: { DEBUG: '1' } }],
    [{ command: 'env' }, { command: 'env' }],
    [{}, undefined],
  ])('preserves optional project fields for %j', async (patch, expected) => {
    const store = createEnvironmentStore({ filePath });
    await store.updateProject('path_abc', patch);
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8')).projects?.path_abc;
    expect(stored).toEqual(expected);
    expect(JSON.stringify(stored)).toBe(JSON.stringify(expected));
    const fresh = createEnvironmentStore({ filePath });
    expect(fresh.projectEntry('path_abc')).toEqual({
      variables: expected?.variables ?? {}, command: expected?.command ?? null,
    });
  });

  it('refuses a malformed patch without writing', async () => {
    const store = createEnvironmentStore({ filePath });
    await store.updateUser({ variables: { KEEP: 'x' } });
    await expect(store.updateUser({ variables: { 'NOT-A-NAME': 'x' } })).rejects.toBeInstanceOf(EnvironmentPatchError);
    // A request body parses `__proto__` as an own key, as JSON.parse does
    // here; it never reaches the store.
    await store.updateUser(JSON.parse('{"variables":{"__proto__":"x"}}'));
    expect(Object.hasOwn(store.userVariables(), '__proto__')).toBe(false);
    await expect(store.updateUser({ variables: { A: 5 } })).rejects.toBeInstanceOf(EnvironmentPatchError);
    await expect(store.updateUser({ other: true })).rejects.toBeInstanceOf(EnvironmentPatchError);
    await expect(store.updateProject('__proto__', { command: 'x' })).rejects.toBeInstanceOf(EnvironmentPatchError);
    await expect(store.updateProject('../escape', { command: 'x' })).rejects.toBeInstanceOf(EnvironmentPatchError);
    expect(store.userVariables()).toEqual({ KEEP: 'x' });
  });

  it('treats an unreadable file as an error, never as an empty store', async () => {
    fs.writeFileSync(filePath, '{ broken');
    const store = createEnvironmentStore({ filePath });
    expect(() => store.userVariables()).toThrow(EnvironmentStoreError);
    await expect(store.updateUser({ variables: { A: '1' } })).rejects.toBeInstanceOf(EnvironmentStoreError);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{ broken');
  });

  it('reads a missing file as an empty version 1 store', () => {
    const store = createEnvironmentStore({ filePath });
    expect(store.userVariables()).toEqual({});
    expect(store.hasProjectEntries()).toBe(false);
  });

  // The bounded-reader tests below name their oracle in each case: the file
  // size against MAX_ENVIRONMENT_FILE_BYTES for over-cap and at-cap, and
  // prompt completion for the FIFO (a blocking read would hang the suite).
  it('refuses an oversized file as an error, never as an empty store, and retries the read', () => {
    const document = JSON.stringify({ version: 1, user: { variables: { A: '1' } } });
    fs.writeFileSync(filePath, document + ' '.repeat(MAX_ENVIRONMENT_FILE_BYTES + 1 - Buffer.byteLength(document)));
    expect(fs.statSync(filePath).size).toBeGreaterThan(MAX_ENVIRONMENT_FILE_BYTES);
    const store = createEnvironmentStore({ filePath });
    expect(() => store.userVariables()).toThrow(EnvironmentStoreError);
    // A failed read is not cached: the same store reads the fixed file.
    fs.writeFileSync(filePath, document);
    expect(store.userVariables()).toEqual({ A: '1' });
  });

  it('reads a file at exactly the cap', () => {
    const document = JSON.stringify({ version: 1, user: { variables: { A: '1' } } });
    // Trailing spaces are JSON whitespace, so the padded file is the same
    // document at exactly the cap.
    fs.writeFileSync(filePath, document + ' '.repeat(MAX_ENVIRONMENT_FILE_BYTES - Buffer.byteLength(document)));
    expect(fs.statSync(filePath).size).toBe(MAX_ENVIRONMENT_FILE_BYTES);
    const store = createEnvironmentStore({ filePath });
    expect(store.userVariables()).toEqual({ A: '1' });
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO at the store path promptly, as an error', () => {
    execFileSync('mkfifo', [filePath]);
    const store = createEnvironmentStore({ filePath });
    expect(() => store.userVariables()).toThrow(EnvironmentStoreError);
  });

  it.skipIf(process.platform === 'win32')('refuses a directory at the store path as an error', () => {
    const store = createEnvironmentStore({ filePath: directory });
    expect(() => store.userVariables()).toThrow(EnvironmentStoreError);
  });

  it('serializes concurrent writes so neither change is lost', async () => {
    const store = createEnvironmentStore({ filePath });
    await Promise.all([
      store.updateUser({ variables: { A: '1' } }),
      store.updateProject('path_p', { variables: { B: '2' } }),
      store.updateUser({ variables: { C: '3' } }),
    ]);
    const fresh = createEnvironmentStore({ filePath });
    expect(fresh.userVariables()).toEqual({ A: '1', C: '3' });
    expect(fresh.projectEntry('path_p').variables).toEqual({ B: '2' });
  });
});

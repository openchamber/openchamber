import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEnvironmentStore, EnvironmentPatchError, EnvironmentStoreError } from './store.js';

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
    expect(await store.updateUser({ variables: { API_TOKEN: 'sk-hidden-1', DEBUG: '1' } })).toEqual({ names: ['API_TOKEN', 'DEBUG'], secrets: [] });
    expect(store.describeUser()).toEqual({ names: ['API_TOKEN', 'DEBUG'], secrets: [] });
    expect(JSON.stringify(store.describeUser())).not.toContain('sk-hidden-1');
    expect(store.userVariables()).toEqual({ API_TOKEN: 'sk-hidden-1', DEBUG: '1' });
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
      .toEqual({ names: ['GOFLAGS'], command: 'direnv export json', secrets: [] });
    expect(store.projectEntry('path_abc')).toEqual({ variables: { GOFLAGS: '-mod=mod' }, command: 'direnv export json' });
    expect(store.hasProjectEntries()).toBe(true);
    await store.updateProject('path_abc', { variables: { GOFLAGS: null }, command: null });
    expect(store.hasProjectEntries()).toBe(false);
    expect(store.describeProject('path_abc')).toEqual({ names: [], command: null, secrets: [] });
  });

  it('keeps saved secrets apart from the variables a spawn gets', async () => {
    const store = createEnvironmentStore({ filePath });
    await store.updateProject('path_abc', { variables: { DEBUG: '1' }, secrets: { API_TOKEN: 'tok-1' } });
    expect(store.projectEntry('path_abc')).toEqual({ variables: { DEBUG: '1' }, command: null });
    expect(store.projectSecrets('path_abc')).toEqual({ API_TOKEN: 'tok-1' });
    expect(store.describeProject('path_abc')).toEqual({ names: ['DEBUG'], command: null, secrets: ['API_TOKEN'] });
    await store.updateProject('path_abc', { variables: { DEBUG: null } });
    expect(store.projectSecrets('path_abc')).toEqual({ API_TOKEN: 'tok-1' });
    expect(store.hasProjectEntries()).toBe(false);
    await store.updateProject('path_abc', { secrets: { API_TOKEN: null } });
    expect(store.hasProjectEntries()).toBe(false);
  });

  it('keeps secrets saved for all projects apart from the user variables', async () => {
    const store = createEnvironmentStore({ filePath });
    await store.updateUser({ variables: { DEBUG: '1' }, secrets: { API_TOKEN: 'tok-1' } });
    expect(store.userVariables()).toEqual({ DEBUG: '1' });
    expect(store.userSecrets()).toEqual({ API_TOKEN: 'tok-1' });
    expect(store.describeUser()).toEqual({ names: ['DEBUG'], secrets: ['API_TOKEN'] });
    await store.updateUser({ variables: { DEBUG: null } });
    expect(store.userSecrets()).toEqual({ API_TOKEN: 'tok-1' });
    await store.updateUser({ secrets: { API_TOKEN: null } });
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ version: 1 });
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

  it('reads only own project entries for names inherited from Object', async () => {
    const store = createEnvironmentStore({ filePath });
    await store.updateProject('path_p', { variables: { A: '1' } });
    expect(store.projectEntry('constructor')).toEqual({ variables: {}, command: null });
    expect(store.describeProject('toString')).toEqual({ names: [], command: null, secrets: [] });
    expect(store.projectSecrets('toString')).toEqual({});
    await store.updateProject('constructor', { variables: { OWN: 'yes' } });
    expect(store.projectEntry('constructor')).toEqual({ variables: { OWN: 'yes' }, command: null });
  });
});

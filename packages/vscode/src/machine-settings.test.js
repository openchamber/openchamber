import { beforeEach, describe, expect, mock, test } from 'bun:test';

const LOCAL_PATH = '/home/client/.opencode/bin/opencode';
const SERVER_PATH = '/home/server/opencode';

let remoteName;
let levels;
let effective;

mock.module('vscode', () => ({
  env: {
    get remoteName() {
      return remoteName;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: () => effective,
      inspect: () => levels,
    }),
  },
}));

const { readMachineSetting } = await import('./machine-settings.ts');

describe('readMachineSetting', () => {
  beforeEach(() => {
    remoteName = 'ssh-remote';
    levels = undefined;
    effective = undefined;
  });

  test('ignores a value set only in local User settings in a remote window', () => {
    levels = { globalLocalValue: LOCAL_PATH, globalValue: LOCAL_PATH };
    effective = LOCAL_PATH;
    expect(readMachineSetting('opencodeBinary')).toBe('');
  });

  test('keeps the local User value in a local window', () => {
    remoteName = undefined;
    levels = { globalLocalValue: LOCAL_PATH, globalValue: LOCAL_PATH };
    effective = LOCAL_PATH;
    expect(readMachineSetting('opencodeBinary')).toBe(LOCAL_PATH);
  });

  for (const level of ['globalRemoteValue', 'workspaceValue']) {
    test(`uses the effective value when ${level} is set in a remote window`, () => {
      levels = { globalLocalValue: LOCAL_PATH, [level]: SERVER_PATH };
      effective = SERVER_PATH;
      expect(readMachineSetting('opencodeBinary')).toBe(SERVER_PATH);
    });
  }

  test('uses the effective value when VS Code does not report the local level', () => {
    levels = { globalValue: LOCAL_PATH };
    effective = LOCAL_PATH;
    expect(readMachineSetting('opencodeBinary')).toBe(LOCAL_PATH);
  });

  test('returns an empty string when nothing is set', () => {
    expect(readMachineSetting('apiUrl')).toBe('');
  });
});

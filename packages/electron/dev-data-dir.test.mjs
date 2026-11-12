import { expect, test } from 'bun:test';
import path from 'node:path';
import { configureDevDataDir } from './dev-data-dir.mjs';

test('unpackaged desktop defaults to separate data and records the injected value', () => {
  const env = {};
  configureDevDataDir(env, false, '/home/test');
  expect(env.OPENCHAMBER_DATA_DIR).toBe(path.join('/home/test', '.config', 'openchamber-dev'));
  expect(env.OPENCHAMBER_INJECTED_ENV).toBe('OPENCHAMBER_DATA_DIR');
});

test('explicit paths and packaged desktop keep their existing data location', () => {
  const explicit = { OPENCHAMBER_DATA_DIR: '/custom' };
  configureDevDataDir(explicit, false, '/home/test');
  expect(explicit).toEqual({ OPENCHAMBER_DATA_DIR: '/custom' });
  const packaged = {};
  configureDevDataDir(packaged, true, '/home/test');
  expect(packaged).toEqual({});
});

import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';

import { createDevServerScanner } from './routes.js';

/** A spawn that answers each command from a table, as the real tools would. */
const fakeSpawn = (answers) => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args].join(' '));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    const answer = answers(command, args);
    queueMicrotask(() => {
      if (answer === null) {
        child.emit('close', 1);
        return;
      }
      child.stdout.emit('data', answer);
      child.emit('close', 0);
    });
    return child;
  };
  return { spawn, calls };
};

const LISTENERS = ['p10', 'cnode', 'n*:5173', 'p11', 'cControlCenter', 'n*:7000'].join('\n');

describe('dev server scanner', () => {
  test('reports the folder each server runs in', async () => {
    const { spawn, calls } = fakeSpawn((_command, args) => (
      args.includes('cwd') ? ['p10', 'fcwd', 'n/Users/me/site', 'p11', 'fcwd', 'n/'].join('\n') : LISTENERS
    ));
    const scanner = createDevServerScanner({ spawn, platform: 'darwin' });

    const result = await scanner.discover();

    expect(result.servers.map(({ port, directory }) => ({ port, directory }))).toEqual([
      { port: 5173, directory: '/Users/me/site' },
      { port: 7000, directory: '/' },
    ]);
    // One extra call for all processes together, never one per process.
    expect(calls.filter((call) => call.includes('cwd'))).toEqual(['lsof -a -d cwd -p 10,11 -F pn']);
  });

  test('still lists the servers when their folders cannot be read', async () => {
    const { spawn } = fakeSpawn((_command, args) => (args.includes('cwd') ? null : LISTENERS));
    const scanner = createDevServerScanner({ spawn, platform: 'darwin' });

    const result = await scanner.discover();

    expect(result.servers.map((server) => server.port)).toEqual([5173, 7000]);
    expect(result.servers.every((server) => server.directory === undefined)).toBe(true);
  });
});

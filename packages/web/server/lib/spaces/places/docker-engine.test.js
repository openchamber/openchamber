import { describe, expect, it } from 'vitest';

import { createDockerEngine, entryLabels, entryName, isInterrupted } from './docker-engine.js';

const engineFor = (stdout, code = 0, stderr = '') => createDockerEngine({
  dockerPath: 'docker',
  runCommand: async () => ({ code, stdout, stderr }),
});

describe('Docker inspect boundaries', () => {
  it('returns the first entry without claiming that JSON established its shape', async () => {
    for (const [json, expected] of [
      ['[{"Name":"volume"}]', { Name: 'volume' }],
      ['[17]', 17],
      ['[null]', null],
      ['[]', undefined],
      ['{"0":"array-like"}', 'array-like'],
      ['"text"', 't'],
      ['false', undefined],
    ]) {
      expect(await engineFor(json).inspect('volume', 'volume')).toEqual(expected);
    }
  });

  it('preserves malformed, null and missing-resource failures separately', async () => {
    await expect(engineFor('not json').inspect('volume', 'volume')).rejects.toMatchObject({ code: 'docker_output_unreadable' });
    await expect(engineFor('null').inspect('volume', 'volume')).rejects.toThrow(TypeError);
    expect(await engineFor('not json', 1, 'No such volume: volume').inspect('volume', 'volume')).toBeNull();
    await expect(engineFor('[]', 1, 'permission denied').inspect('volume', 'volume')).rejects.toMatchObject({ code: 'docker_command_failed' });
  });

  it('passes label-query JSON through without inventing an array contract', async () => {
    for (const json of ['[{"Name":"volume"}]', '{"entry":17}', 'null', '"text"']) {
      const engine = createDockerEngine({
        dockerPath: 'docker',
        runCommand: async (_file, args) => ({ code: 0, stdout: args.includes('ls') ? 'volume\n' : json, stderr: '' }),
      });
      expect(await engine.findByLabel('volume', [])).toEqual(JSON.parse(json));
    }
  });

  it('keeps inherited fields, primitive boxing and unchecked label values', () => {
    const labels = { constructor: 'label' };
    expect(entryLabels('container', Object.create({ Config: Object.create({ Labels: labels }) }))).toBe(labels);
    expect(entryLabels('volume', Object.create({ Labels: 17 }))).toBe(17);
    expect(entryLabels('container', { Config: null })).toBeUndefined();
    expect(entryLabels('container', { Config: 'text' })).toBeUndefined();
    expect(entryLabels('volume', false)).toBeUndefined();
    expect(entryName(Object.create({ Name: '/inherited' }))).toBe('inherited');
    expect(entryName({ Name: 17 })).toBe('17');
    expect(entryName(false)).toBe('');
    expect(() => entryLabels('volume', null)).toThrow(TypeError);
    expect(() => entryName(undefined)).toThrow(TypeError);
  });
});

describe('Docker command boundaries', () => {
  it('keeps host arguments, command options and the caller array intact', async () => {
    const calls = [];
    const engine = createDockerEngine({
      dockerPath: '/bin/docker',
      dockerHost: 'ssh://machine',
      runCommand: async (...args) => {
        calls.push(args);
        return { code: 0, stdout: 'done', stderr: '' };
      },
    });
    const args = ['exec', 'container'];
    expect(await engine.run(args, 123, { stdin: 'input', keepTail: true })).toEqual({ code: 0, stdout: 'done', stderr: '' });
    expect(calls).toEqual([['/bin/docker', ['--host', 'ssh://machine', ...args], { stdin: 'input', keepTail: true, timeoutMs: 123 }]]);
    expect(args).toEqual(['exec', 'container']);
  });

  it('keeps rejected message fields unchecked and preserves null rejection failures', async () => {
    for (const cause of [Object.create({ message: 17 }), 'failure']) {
      const engine = createDockerEngine({
        dockerPath: 'docker',
        runCommand: async () => { throw cause; },
      });
      expect(await engine.removeOne('volume', 'volume')).toEqual({ kind: 'volume', name: 'volume', message: cause.message });
    }
    const engine = createDockerEngine({
      dockerPath: 'docker',
      runCommand: async () => { throw null; },
    });
    await expect(engine.removeOne('volume', 'volume')).rejects.toThrow(TypeError);
  });

  it('recognizes interrupted codes through inherited fields and accepts missing errors', () => {
    for (const code of ['command_timeout', 'command_killed', 'command_output_too_large']) {
      expect(isInterrupted(Object.create({ code }))).toBe(true);
    }
    for (const error of [null, undefined, false, 'command_timeout', { code: 17 }, { code: 'other' }]) {
      expect(isInterrupted(error)).toBe(false);
    }
  });

  it('reads an interruption code only once', () => {
    let reads = 0;
    const error = { get code() { reads += 1; return 'command_output_too_large'; } };
    expect(isInterrupted(error)).toBe(true);
    expect(reads).toBe(1);
  });
});

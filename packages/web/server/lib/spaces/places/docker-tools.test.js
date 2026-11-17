// The fill-failure error tail of docker-tools: what a tools_fill_failed
// message may carry from the filler stderr, cut to its last 2,000 characters.

import { describe, expect, it } from 'vitest';

import { createRegistryToolsSource } from '../tools.js';
import { createDockerTools } from './docker-tools.js';

/**
 * A tools fill over a stub engine whose fill run always fails with `stderr`.
 * Everything before the fill answers like an empty Docker: no volume yet,
 * and no one-shot containers for the clean-up to remove.
 */
const makeFailingTools = (stderr) => {
  const engine = {
    inspect: async () => null,
    findByLabel: async () => [],
    removeOne: async () => null,
    removeByName: async () => [],
    docker: async () => '',
    run: async () => ({ code: 1, stdout: '', stderr }),
    failure: (_args, result) => new Error(`docker run failed: ${result.stderr}`),
  };
  return createDockerTools({
    engine,
    owner: 'owner-a',
    toolsSource: createRegistryToolsSource({ webVersion: '1.24.2', openCodeVersion: '1.18.31' }),
    image: 'node@test',
    now: () => new Date('2026-11-11T00:00:00Z'),
    wait: async () => {},
  });
};

/** The error `ensure` rejects with when the fill run fails with `stderr`. */
const fillError = async (stderr) => {
  let error;
  try {
    await makeFailingTools(stderr).ensure();
  } catch (caught) {
    error = caught;
  }
  expect(error?.code).toBe('tools_fill_failed');
  return error;
};

describe('docker tools: the fill-failure tail', () => {
  it('never starts inside a surrogate pair (#2041, #2080)', async () => {
    // stderr is 2,002 chars, so the 2,000-char cut lands between the halves
    // of the astral character: the partial character is dropped.
    const error = await fillError(`x\u{1F600}${'y'.repeat(1_999)}`);
    expect(error.message).toContain(`failed: ${'y'.repeat(1_999)}. Common causes`);
    expect(error.message).not.toContain('\u{1F600}');
    expect(new TextDecoder().decode(new TextEncoder().encode(error.message))).not.toContain('\uFFFD');
  });

  it('keeps ASCII over-limit tails at exact length and under-limit text unchanged', async () => {
    const over = await fillError('y'.repeat(5_000));
    expect(over.message).toContain(`failed: ${'y'.repeat(2_000)}. Common causes`);
    expect(over.message).not.toContain('y'.repeat(2_001));

    const under = await fillError('hello \u{1F600}');
    expect(under.message).toContain('failed: hello \u{1F600}. Common causes');
  });
});

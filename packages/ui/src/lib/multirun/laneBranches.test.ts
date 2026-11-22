import { describe, expect, test } from 'bun:test';

import { uniqueLaneBranchName } from './laneBranches';

/** The oracle: git's rule that no branch may equal another or sit under it as a folder. */
const gitAccepts = (names: readonly string[]): boolean => names.every((name, i) => names.every((other, j) => (
  i === j || (name !== other && !name.startsWith(`${other}/`) && !other.startsWith(`${name}/`))
)));

/** A small deterministic PRNG, so a failing case reproduces. */
const random = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};

describe('uniqueLaneBranchName', () => {
  test('keeps the seed when nothing collides', () => {
    expect(uniqueLaneBranchName('fix-it/anthropic-claude', new Set(['main', 'fix-it-later']))).toBe('fix-it/anthropic-claude');
  });

  test('suffixes the last segment for an existing branch of the same name or below it', () => {
    expect(uniqueLaneBranchName('fix-it/openai-gpt', new Set(['fix-it/openai-gpt']))).toBe('fix-it/openai-gpt-2');
    expect(uniqueLaneBranchName('fix-it/openai-gpt', new Set(['fix-it/openai-gpt/1']))).toBe('fix-it/openai-gpt-2');
    expect(uniqueLaneBranchName('fix-it/openai-gpt', new Set(['fix-it/openai-gpt', 'fix-it/openai-gpt-2']))).toBe('fix-it/openai-gpt-3');
  });

  test('suffixes the segment a shorter branch occupies', () => {
    expect(uniqueLaneBranchName('fix-it/openai-gpt', new Set(['fix-it']))).toBe('fix-it-2/openai-gpt');
    expect(uniqueLaneBranchName('fix-it/openai-gpt/1', new Set(['fix-it/openai-gpt']))).toBe('fix-it/openai-gpt-2/1');
  });

  test('names that git accepts side by side, for generated seeds and existing branches', () => {
    const segments = ['run', 'run-2', 'g1', 'openai-gpt', 'openai-gpt-2', '1', '2'];
    for (let round = 0; round < 500; round += 1) {
      const next = random(round + 1);
      const pick = () => segments[Math.floor(next() * segments.length)];
      const path = () => Array.from({ length: 1 + Math.floor(next() * 3) }, pick).join('/');
      // Existing branches must themselves be valid in git.
      const existing: string[] = [];
      for (let i = 0; i < Math.floor(next() * 6); i += 1) {
        const candidate = path();
        if (gitAccepts([...existing, candidate])) existing.push(candidate);
      }
      const taken = new Set(existing);
      const lanes: string[] = [];
      for (let i = 0; i < 1 + Math.floor(next() * 6); i += 1) {
        const seed = path();
        const name = uniqueLaneBranchName(seed, taken);
        const seedFree = gitAccepts([...taken, seed]);
        // A seed that fits is kept as is; anything else changes.
        expect(name === seed).toBe(seedFree);
        expect(name.split('/').length).toBe(seed.split('/').length);
        taken.add(name);
        lanes.push(name);
      }
      expect(gitAccepts([...existing, ...lanes])).toBe(true);
    }
  });
});

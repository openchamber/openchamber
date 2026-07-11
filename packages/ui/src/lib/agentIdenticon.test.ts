import { describe, expect, test } from 'bun:test';
import { getAgentIdenticonMatrix, hashAgentSeed } from './agentIdenticon';

describe('agentIdenticon', () => {
  test('hashes the same seed deterministically', () => {
    expect(hashAgentSeed('orchestrator')).toBe(hashAgentSeed('orchestrator'));
    expect(hashAgentSeed('build')).not.toBe(hashAgentSeed('plan'));
  });

  test('builds a mirrored 5x5 matrix', () => {
    const matrix = getAgentIdenticonMatrix('orchestrator');
    expect(matrix).toHaveLength(5);
    for (const row of matrix) {
      expect(row).toHaveLength(5);
      expect(row[0]).toBe(row[4]);
      expect(row[1]).toBe(row[3]);
    }
  });

  test('returns an empty matrix for missing seed', () => {
    const matrix = getAgentIdenticonMatrix(undefined);
    expect(matrix.every((row) => row.every((cell) => cell === false))).toBe(true);
  });

  test('keeps distinct seeds visually distinct enough to differ', () => {
    const a = getAgentIdenticonMatrix('build').flat().join('');
    const b = getAgentIdenticonMatrix('orchestrator').flat().join('');
    expect(a).not.toBe(b);
  });
});

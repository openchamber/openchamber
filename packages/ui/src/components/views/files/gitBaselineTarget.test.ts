import { describe, expect, test } from 'bun:test';

import { gitBaselineTarget } from './gitBaselineTarget';

describe('gitBaselineTarget', () => {
  test('a file in the selected nested repository reads that repository', () => {
    expect(gitBaselineTarget('/workspace/frontend/src/app.ts', '/workspace', '/workspace/frontend'))
      .toEqual({ directory: '/workspace/frontend', relativePath: 'src/app.ts' });
  });

  test('a file outside the selected repository falls back to the project folder', () => {
    expect(gitBaselineTarget('/workspace/backend/main.go', '/workspace', '/workspace/frontend'))
      .toEqual({ directory: '/workspace', relativePath: 'backend/main.go' });
  });

  test('a sibling folder sharing the selected repository prefix is outside it', () => {
    expect(gitBaselineTarget('/workspace/frontend-old/app.ts', '/workspace', '/workspace/frontend'))
      .toEqual({ directory: '/workspace', relativePath: 'frontend-old/app.ts' });
  });

  test('without a nested selection the project folder is the repository', () => {
    expect(gitBaselineTarget('/repo/src/app.ts', '/repo', '/repo'))
      .toEqual({ directory: '/repo', relativePath: 'src/app.ts' });
  });

  test('Windows paths match whatever their separators and drive case', () => {
    expect(gitBaselineTarget('c:/workspace/frontend/src/app.ts', 'C:\\workspace', 'C:\\workspace\\frontend'))
      .toEqual({ directory: 'C:\\workspace\\frontend', relativePath: 'src/app.ts' });
  });

  test('whitespace in a file name is part of the name', () => {
    expect(gitBaselineTarget('/repo/note.txt ', '/repo', '/repo'))
      .toEqual({ directory: '/repo', relativePath: 'note.txt ' });
    expect(gitBaselineTarget('/repo/note.txt', '/repo', '/repo'))
      .toEqual({ directory: '/repo', relativePath: 'note.txt' });
  });

  test('a file named like the selected repository plus a space is outside it', () => {
    expect(gitBaselineTarget('/workspace/frontend ', '/workspace', '/workspace/frontend'))
      .toEqual({ directory: '/workspace', relativePath: 'frontend ' });
  });

  test('a file outside the project has no target', () => {
    expect(gitBaselineTarget('/elsewhere/app.ts', '/workspace', '/workspace/frontend')).toBeNull();
    expect(gitBaselineTarget(null, '/workspace', '/workspace/frontend')).toBeNull();
  });
});

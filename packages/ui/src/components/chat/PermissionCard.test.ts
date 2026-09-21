import { describe, expect, test } from 'bun:test';

import { getVisiblePermissionPatterns } from './permissionCardPatterns';
import { permissionFilePreviewsSchema } from './permissionFilePreviews';

describe('permission file previews', () => {
  test('reads edit and new-file patches from OpenCode FileDiff.Info entries', () => {
    const files = [
      { file: '/repo/existing.ts', patch: '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1, status: 'modified' },
      { file: '/repo/new.ts', patch: '@@ -0,0 +1 @@\n+created', additions: 1, deletions: 0, status: 'added' },
    ];
    expect(permissionFilePreviewsSchema.parse(files)).toEqual(files.map(({ file, patch }) => ({ file, patch })));
  });

  test('keeps valid files when another entry is malformed', () => {
    const valid = { file: '/repo/a.ts', patch: '@@ -0,0 +1 @@\n+ok' };
    expect(permissionFilePreviewsSchema.parse([null, { file: 'bad', patch: 42 }, valid, { file: 'empty', patch: '' }])).toEqual([valid]);
  });

  test('leaves legacy metadata and invalid lists to the existing preview path', () => {
    expect(permissionFilePreviewsSchema.parse(undefined)).toEqual([]);
    expect(permissionFilePreviewsSchema.parse({ diff: 'legacy' })).toEqual([]);
    expect(permissionFilePreviewsSchema.parse([])).toEqual([]);
  });
});

describe('getVisiblePermissionPatterns', () => {
  test('omits a pattern already rendered as the bash command', () => {
    const command = 'bunx eslint "src/components/session/SessionSidebar.tsx"';

    expect(getVisiblePermissionPatterns([command], command)).toEqual([]);
  });

  test('preserves distinct permission patterns', () => {
    const command = 'bunx eslint "src/components/session/SessionSidebar.tsx"';

    expect(getVisiblePermissionPatterns(['bunx eslint *', command], command)).toEqual(['bunx eslint *']);
  });
});

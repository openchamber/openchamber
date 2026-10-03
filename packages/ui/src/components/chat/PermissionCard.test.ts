import { describe, expect, test } from 'bun:test';

import { getVisiblePermissionPatterns } from './permissionCardPatterns';
import { permissionFilePreviewsSchema } from './permissionFilePreviews';
import { describeSavePatterns, permissionSummaryMetadataSchema, summarizePermission } from './permissionSummary';

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

describe('summarizePermission', () => {
  test('shows an external directory without its glob and names the file that triggered it', () => {
    const metadata = permissionSummaryMetadataSchema.parse({ filepath: '/home/me/.config/app/themes/jade.json', parentDir: '/home/me/.config/app/themes' });
    const summary = summarizePermission('external_directory', ['/home/me/.config/app/themes/*'], metadata, true);
    expect(summary.titleKey).toBe('chat.permissionCard.summary.externalDirectory');
    expect(summary.targets).toEqual([{ value: '/home/me/.config/app/themes', isPath: true, file: 'jade.json' }]);
    expect(summary.metadataExplained).toBe(true);
  });

  test('keeps the raw details available for tools it cannot explain', () => {
    const summary = summarizePermission('linear_create_issue', ['*'], permissionSummaryMetadataSchema.parse({ title: 'x' }), true);
    expect(summary).toEqual({ titleKey: 'chat.permissionCard.summary.tool', tool: 'linear_create_issue', targets: [], metadataExplained: false });
  });

  test('reports a search scope and ignores malformed metadata', () => {
    expect(summarizePermission('grep', ['TODO'], permissionSummaryMetadataSchema.parse({ path: 'src' }), true).scope).toBe('src');
    expect(summarizePermission('glob', ['*.ts'], permissionSummaryMetadataSchema.parse({ path: 42 }), true).scope).toBeUndefined();
  });
});

describe('describeSavePatterns', () => {
  test('hides a whole-capability save and shows directories without globs', () => {
    expect(describeSavePatterns('read', ['*'])).toEqual([]);
    expect(describeSavePatterns('external_directory', ['/home/me/.config/*'])).toEqual(['/home/me/.config']);
    expect(describeSavePatterns('shell', ['git *'])).toEqual(['git *']);
  });
});

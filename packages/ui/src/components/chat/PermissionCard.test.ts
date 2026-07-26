import { describe, expect, test } from 'bun:test';

import { getVisiblePermissionPatterns } from './permissionCardPatterns';

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

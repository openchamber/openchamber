import { describe, expect, test } from 'bun:test';

import { getProjectDisplayLabel, getProjectLabel } from './mobilePaths';

describe('mobile project labels', () => {
  test('uses the directory basename without changing its text', () => {
    expect(getProjectLabel('/workspace/my-project_Name')).toBe('my-project_Name');
  });

  test('prefers a trimmed custom label over the directory basename', () => {
    expect(getProjectDisplayLabel({
      id: 'project-1',
      path: '/workspace/my-project',
      label: '  My Custom_Project  ',
    }, '/workspace/fallback')).toBe('My Custom_Project');
  });
});

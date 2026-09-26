import { describe, expect, test } from 'bun:test';

import { getProjectDisplayLabel, getProjectPathLabel } from './projectDisplayLabel';

describe('project display labels', () => {
  test('uses a custom label unchanged', () => {
    expect(getProjectDisplayLabel({ path: '/workspace/my-project', label: 'MyProject' })).toBe('MyProject');
  });

  test('falls back to the exact directory basename', () => {
    expect(getProjectDisplayLabel({ path: '/workspace/my-project_Name' })).toBe('my-project_Name');
    expect(getProjectPathLabel('C:\\workspace\\my-project')).toBe('my-project');
  });
});

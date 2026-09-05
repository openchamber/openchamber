import { describe, expect, test } from 'bun:test';

import { getProjectLabel } from './mobilePaths';

describe('mobile project labels', () => {
  test('uses the directory basename without changing its text', () => {
    expect(getProjectLabel('/workspace/my-project_Name')).toBe('my-project_Name');
  });
});

import { describe, expect, test } from 'bun:test';
import { isRequestFromSubagent } from './requestSource';

describe('isRequestFromSubagent', () => {
  const sessions = [
    { id: 'parent' },
    { id: 'child', parentID: 'parent' },
    { id: 'grandchild', parentID: 'child' },
  ];

  test('marks a permission or question from a subagent at any depth under the open session', () => {
    expect(isRequestFromSubagent(sessions, 'child', 'parent')).toBe(true);
    expect(isRequestFromSubagent(sessions, 'grandchild', 'parent')).toBe(true);
  });

  test('leaves the open session\'s own request unmarked, also when that session is a subagent opened from its parent\'s badge', () => {
    expect(isRequestFromSubagent(sessions, 'parent', 'parent')).toBe(false);
    expect(isRequestFromSubagent(sessions, 'child', 'child')).toBe(false);
    expect(isRequestFromSubagent(sessions, 'child', null)).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';
import { createBranchValidationRequests } from './branchValidationRequests';

describe('branch validation request ownership', () => {
  test('deduplicates a branch within one project and runtime', () => {
    const requests = createBranchValidationRequests();
    requests.setScope('runtime-a:project-a');
    const first = requests.begin('runtime-a:project-a', 'feature');

    expect(first).not.toBeNull();
    if (!first) throw new Error('Expected the first request to start');
    expect(requests.begin('runtime-a:project-a', 'feature')).toBeNull();
    requests.finish('runtime-a:project-a', 'feature', first);
    expect(requests.begin('runtime-a:project-a', 'feature')).not.toBeNull();
  });

  test('rejects completion after project or runtime scope changes', () => {
    const requests = createBranchValidationRequests();
    requests.setScope('runtime-a:project-a');
    const token = requests.begin('runtime-a:project-a', 'feature');
    requests.setScope('runtime-b:project-b');

    expect(token).not.toBeNull();
    if (!token) throw new Error('Expected the request to start');
    expect(requests.isCurrent('runtime-a:project-a', 'feature', token)).toBe(false);
  });
});

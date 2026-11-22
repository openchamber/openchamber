import { describe, expect, test } from 'bun:test';

import { commitRequestRepository, commitRequestShown } from './mobileChangesCommitRequest';

const request = (directory: string) => ({ scope: 'commit' as const, directory });

describe('a commit request on the phone', () => {
  test('switches Changes to the repository the commit was read from, never one outside the folder', () => {
    expect(commitRequestRepository('/repo', request('/repo'))).toBe('/repo');
    expect(commitRequestRepository('/repo', request('/repo/'))).toBe('/repo');
    expect(commitRequestRepository('/repo', request('/repo/vendor/lib'))).toBe('/repo/vendor/lib');
    expect(commitRequestRepository('/repo', request('/repo-other'))).toBeNull();
    expect(commitRequestRepository('', request('/repo'))).toBeNull();
  });

  test('opens the commit scope only while that repository is the one on screen', () => {
    // A nested checkout picked in Changes reads another commit selection.
    expect(commitRequestShown('/repo/vendor/lib', request('/repo'))).toBe(false);
    expect(commitRequestShown('/repo', request('/repo/'))).toBe(true);
    expect(commitRequestShown('', request('/repo'))).toBe(false);
  });
});

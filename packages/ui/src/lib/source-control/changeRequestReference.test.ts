import { describe, expect, test } from 'bun:test';
import { parseChangeRequestReference } from './changeRequestReference';

describe('change-request references', () => {
  test('accepts GitHub and GitLab change-request references', () => {
    expect(parseChangeRequestReference('#12')).toEqual({ number: 12 });
    expect(parseChangeRequestReference('!13')).toEqual({ number: 13 });
    expect(parseChangeRequestReference('https://github.com/openchamber/openchamber/pull/14')).toEqual({
      number: 14,
      identity: { provider: 'github', instance: 'github.com' },
      project: { owner: 'openchamber', name: 'openchamber' },
    });
    expect(parseChangeRequestReference('https://gitlab.example.com/platform/tools/project/-/merge_requests/15')).toEqual({
      number: 15,
      identity: { provider: 'gitlab', instance: 'https://gitlab.example.com' },
      project: { owner: 'platform/tools', name: 'project' },
    });
  });

  test('rejects invalid and unrelated references', () => {
    expect(parseChangeRequestReference('0')).toBeNull();
    expect(parseChangeRequestReference('issue #12')).toBeNull();
    expect(parseChangeRequestReference('https://gitlab.com/group/project/-/issues/15')).toBeNull();
  });
});

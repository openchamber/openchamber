import { describe, expect, test } from 'bun:test';
import { boardTargetOfUrl } from './openOnBoard';

describe('boardTargetOfUrl', () => {
  test('names the board tab a link belongs on', () => {
    expect(boardTargetOfUrl('https://github.com/openchamber/openchamber/pull/4500')).toEqual({ source: 'repository', kind: 'pull' });
    expect(boardTargetOfUrl('https://github.com/openchamber/openchamber/issues/4483')).toEqual({ source: 'repository', kind: 'issue' });
    expect(boardTargetOfUrl('https://gitlab.com/group/sub/app/-/merge_requests/7')).toEqual({ source: 'repository', kind: 'pull' });
    expect(boardTargetOfUrl('https://gitlab.com/group/sub/app/-/issues/3')).toEqual({ source: 'repository', kind: 'issue' });
    expect(boardTargetOfUrl('https://linear.app/openchamber/issue/ope-282/some-title')).toEqual({ source: 'linear', identifier: 'OPE-282' });
  });

  test('leaves anything else to the browser', () => {
    expect(boardTargetOfUrl('#12')).toBeNull();
    expect(boardTargetOfUrl('https://example.com/tickets/12')).toBeNull();
    expect(boardTargetOfUrl('https://github.com/openchamber/openchamber')).toBeNull();
  });
});

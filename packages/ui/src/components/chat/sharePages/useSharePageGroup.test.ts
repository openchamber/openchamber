import { describe, expect, test } from 'bun:test';

import { isSharingTurnedOff, SharePageRequestError, type SharePageGroup } from '@/lib/share-pages/api';
import { failedReadState, type SharePageGroupState } from './useSharePageGroup';

const group: SharePageGroup = {
  title: 'Pick', kind: 'questionnaire', expectAnswer: true, summary: null, expiresAt: 1, documentState: 'ready', recipients: [],
};
const shown: SharePageGroupState = { group, error: null, missing: false, turnedOff: false };

describe('a failed read of a shared page', () => {
  test('turns sharing off only on the policy refusal, dropping links and PINs', () => {
    const refusal = new SharePageRequestError('Sharing pages is not available in enterprise mode', 403, 'enterprise_mode');
    expect(isSharingTurnedOff(refusal)).toBe(true);
    expect(failedReadState(shown, refusal)).toEqual({ group: null, error: null, missing: false, turnedOff: true });
    // Another 403 is an ordinary failure.
    expect(isSharingTurnedOff(new SharePageRequestError('Forbidden', 403, null))).toBe(false);
  });

  test('keeps the group shown on any other failure, and never reads as an empty group', () => {
    const down = new Error('Failed to fetch');
    expect(failedReadState(shown, down)).toEqual({ group, error: 'Failed to fetch', missing: false, turnedOff: false });
    const gone = new SharePageRequestError('No shared page for this call', 404, null);
    expect(failedReadState(shown, gone)).toEqual({ group: null, error: 'No shared page for this call', missing: true, turnedOff: false });
  });
});

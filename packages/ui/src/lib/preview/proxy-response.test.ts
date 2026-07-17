import { describe, expect, test } from 'bun:test';

import {
  getPreviewTargetErrorCode,
  getPreviewTargetRecoveryAction,
  PREVIEW_TARGET_ERROR_HEADER,
} from './proxy-response';

describe('preview proxy response classification', () => {
  test('recognizes proxy-owned target failures', () => {
    for (const code of ['missing', 'expired', 'invalid-token'] as const) {
      const headers = new Headers({ [PREVIEW_TARGET_ERROR_HEADER]: code });
      expect(getPreviewTargetErrorCode(headers)).toBe(code);
    }
  });

  test('does not classify ordinary upstream responses as target failures', () => {
    expect(getPreviewTargetErrorCode(new Headers())).toBeNull();
    expect(getPreviewTargetErrorCode(new Headers({ [PREVIEW_TARGET_ERROR_HEADER]: 'unknown' }))).toBeNull();
    expect(getPreviewTargetRecoveryAction(new Headers(), false)).toBe('none');
  });

  test('bounds automatic target recovery to one registration retry', () => {
    const headers = new Headers({ [PREVIEW_TARGET_ERROR_HEADER]: 'expired' });
    expect(getPreviewTargetRecoveryAction(headers, false)).toBe('retry-registration');
    expect(getPreviewTargetRecoveryAction(headers, true)).toBe('stop-retrying');
  });
});

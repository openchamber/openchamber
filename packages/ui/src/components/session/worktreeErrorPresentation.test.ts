import { describe, expect, test } from 'bun:test';
import { dict as englishMessages } from '@/lib/i18n/messages/en';
import {
  getWorktreeErrorPresentationKey,
  PULL_REQUEST_SOURCE_UNAVAILABLE_CODE,
  PULL_REQUEST_SOURCE_UNAVAILABLE_TRANSLATION_KEY,
} from './worktreeErrorPresentation';

describe('worktree error presentation', () => {
  test('maps the stable pull-request source code from validation and create transports', () => {
    expect(getWorktreeErrorPresentationKey({
      code: PULL_REQUEST_SOURCE_UNAVAILABLE_CODE,
      message: 'diagnostic detail',
    })).toBe(PULL_REQUEST_SOURCE_UNAVAILABLE_TRANSLATION_KEY);

    const transportedError = Object.assign(
      new Error(PULL_REQUEST_SOURCE_UNAVAILABLE_CODE),
      { code: PULL_REQUEST_SOURCE_UNAVAILABLE_CODE },
    );
    expect(getWorktreeErrorPresentationKey(transportedError)).toBe(PULL_REQUEST_SOURCE_UNAVAILABLE_TRANSLATION_KEY);
    expect(englishMessages[PULL_REQUEST_SOURCE_UNAVAILABLE_TRANSLATION_KEY]).toContain('repository access');
  });

  test('leaves unrelated worktree errors unchanged', () => {
    expect(getWorktreeErrorPresentationKey(new Error('Existing branch not found'))).toBeNull();
  });
});

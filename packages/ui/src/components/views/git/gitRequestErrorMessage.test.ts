import { describe, expect, test } from 'bun:test';

import { GitNetworkOperationRequestError } from '@/lib/api/types';
import type { I18nKey } from '@/lib/i18n';

import { gitRequestErrorMessage } from './gitRequestErrorMessage';

const t = (key: I18nKey) => `t:${key}`;

describe('gitRequestErrorMessage', () => {
  test('a remote URL with a name before @ gets the translated fix', () => {
    const error = new GitNetworkOperationRequestError('REMOTE_URL_USERINFO', 'Remove the name before @ from remote URL', 400);
    expect(gitRequestErrorMessage(error, t)).toBe('t:gitView.toast.remoteUrlUserinfo');
  });

  test('any other refusal keeps the server reason', () => {
    const error = new GitNetworkOperationRequestError('INVALID_REQUEST', 'Git endpoint is invalid', 400);
    expect(gitRequestErrorMessage(error, t)).toBe('Git endpoint is invalid');
    expect(gitRequestErrorMessage(new Error('Network down'), t)).toBe('Network down');
  });
});

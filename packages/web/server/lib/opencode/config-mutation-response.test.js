import { describe, expect, test } from 'bun:test';

import {
  buildAppliedResponse,
  buildExternalManualRestartResponse,
} from './config-mutation-response.js';

describe('config mutation response helpers', () => {
  test('buildAppliedResponse reports plain success with no restart flags', () => {
    expect(buildAppliedResponse('Agent saved.')).toEqual({
      success: true,
      message: 'Agent saved.',
    });
  });

  test('buildExternalManualRestartResponse asks for external restart', () => {
    expect(buildExternalManualRestartResponse('Restart your server.')).toEqual({
      success: true,
      requiresReload: false,
      requiresManualRestart: true,
      message: 'Restart your server.',
    });
  });
});

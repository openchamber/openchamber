import { describe, expect, test } from 'bun:test';

import {
  buildDeferredRestartResponse,
  buildExternalManualRestartResponse,
} from './config-mutation-response.js';

describe('config mutation response helpers', () => {
  test('buildDeferredRestartResponse marks restart as deferred', () => {
    expect(buildDeferredRestartResponse('Saved. Restart OpenCode to apply.')).toEqual({
      success: true,
      requiresReload: false,
      requiresRestart: true,
      restartDeferred: true,
      message: 'Saved. Restart OpenCode to apply.',
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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPackagedUiRuntimeRequest } from './packaged-ui-routing.mjs';

describe('packaged UI runtime routing', () => {
  it('recognizes runtime paths without treating packaged assets as runtime requests', () => {
    for (const path of ['/api', '/api/session/ses_1', '//api/session/ses_1', '/%61pi/session/ses_1', '/auth', '/auth/session', '/health']) {
      assert.equal(isPackagedUiRuntimeRequest(`openchamber-ui://app${path}`), true);
    }
    for (const path of ['/assets/main.js', '/index.html', '/healthy']) {
      assert.equal(isPackagedUiRuntimeRequest(`openchamber-ui://app${path}`), false);
    }
  });
});

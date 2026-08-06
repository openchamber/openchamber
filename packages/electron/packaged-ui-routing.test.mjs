import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPackagedUiRuntimeRequest, resolvePackagedUiRuntimeRequest } from './packaged-ui-routing.mjs';

describe('packaged UI runtime routing', () => {
  it('forwards API requests to the active runtime with query parameters intact', () => {
    assert.equal(
      resolvePackagedUiRuntimeRequest(
        'openchamber-ui://app/api/session/ses_1/prompt_async?directory=%2Frepo',
        'http://127.0.0.1:4096',
      ),
      'http://127.0.0.1:4096/api/session/ses_1/prompt_async?directory=%2Frepo',
    );
  });

  it('recognizes runtime paths without treating packaged assets as runtime requests', () => {
    assert.equal(isPackagedUiRuntimeRequest('openchamber-ui://app/health'), true);
    assert.equal(isPackagedUiRuntimeRequest('openchamber-ui://app/assets/main.js'), false);
    assert.equal(resolvePackagedUiRuntimeRequest('openchamber-ui://app/api/session', ''), null);
  });
});

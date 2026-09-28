import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldBlockGuestFrameNavigation } from './guest-frame-navigation.mjs';

const isAppOrigin = (url) => new URL(url).origin === 'http://127.0.0.1:3902';
const guest = (url) => shouldBlockGuestFrameNavigation({ isMainFrame: false, frameOrigin: 'null', url, isAppOrigin });

test('refuses an extension frame leaving for any other address', () => {
  for (const url of [
    'https://example.com/?data=conversation',
    'http://127.0.0.1:3902/api/session',
    'http://127.0.0.1:3902/',
    'http://127.0.0.1:9999/api/guests/demo/index.html',
    'javascript:alert(1)',
    'not a url',
  ]) {
    assert.equal(guest(url), true, url);
  }
});

test('lets an extension frame load its own pages and local documents', () => {
  for (const url of [
    'http://127.0.0.1:3902/api/guests/demo/index.html?oc_url_token=x',
    'http://127.0.0.1:3902/api/guests/demo/other/page.html',
    'about:srcdoc',
    'about:blank',
    'data:text/html,<p>hi</p>',
    'blob:http://127.0.0.1:3902/0f2d',
  ]) {
    assert.equal(guest(url), false, url);
  }
});

test('leaves the main frame and frames with an origin of their own alone', () => {
  assert.equal(shouldBlockGuestFrameNavigation({ isMainFrame: true, frameOrigin: 'null', url: 'https://example.com/', isAppOrigin }), false);
  assert.equal(shouldBlockGuestFrameNavigation({ isMainFrame: false, frameOrigin: 'https://docs.example', url: 'https://example.com/', isAppOrigin }), false);
});

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

test('allows the app HTML preview without letting an extension reach it', () => {
  const mainFrame = {};
  const grantA = 'http://127.0.0.1:3902/api/fs/preview/grant-a/tmp/site/index.html';
  const grantAOther = 'http://127.0.0.1:3902/api/fs/preview/grant-a/tmp/site/about.html';
  const grantB = 'http://127.0.0.1:3902/api/fs/preview/grant-b/tmp/site/index.html';
  const emptyFrame = { url: '', parent: mainFrame };
  const previewFrame = { url: grantA, parent: mainFrame };
  const guestFrame = { url: 'http://127.0.0.1:3902/api/guests/demo/index.html', parent: mainFrame };
  const navigate = (frame, initiator, url) => shouldBlockGuestFrameNavigation({
    isMainFrame: false, frameOrigin: 'null', frame, initiator, mainFrame, url, isAppOrigin,
  });

  assert.equal(navigate(emptyFrame, mainFrame, grantA), false, 'the app loads a preview into a new frame');
  assert.equal(navigate(previewFrame, mainFrame, grantB), false, 'the app reloads the preview with a new grant after a save');
  assert.equal(navigate(previewFrame, previewFrame, grantAOther), false, 'the preview follows its own links within its grant');
  assert.equal(navigate(previewFrame, previewFrame, grantB), true, 'the preview cannot reach another grant');
  assert.equal(navigate(previewFrame, previewFrame, 'http://127.0.0.1:3902/api/fs/raw?path=/etc/hosts'), true, 'the preview cannot reach other file routes');
  assert.equal(navigate(previewFrame, previewFrame, 'https://example.com/'), true, 'the preview cannot leave the app origin');
  assert.equal(navigate(emptyFrame, emptyFrame, grantA), true, 'an empty frame cannot navigate itself to a preview');
  assert.equal(navigate(guestFrame, guestFrame, grantA), true, 'a loaded guest cannot navigate to a preview');
  assert.equal(navigate(guestFrame, mainFrame, grantA), true, 'a loaded guest frame is not a preview frame');
  assert.equal(navigate({ url: '', parent: guestFrame }, mainFrame, grantA), true, 'a nested frame cannot load a preview');
  assert.equal(navigate(emptyFrame, mainFrame, 'https://example.com/api/fs/preview/grant-a/x.html'), true, 'a preview cannot come from another origin');
  assert.equal(navigate({ get url() { throw new Error('detached'); } }, mainFrame, grantA), true, 'a detached frame cannot claim the preview exception');
  assert.equal(navigate(emptyFrame, mainFrame, 'http://127.0.0.1:3902/api/fs/serve/tmp/index.html'), true, 'the retired serve route is not opened');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSameOpenCodeServer } from './opencodeServiceUrl';

test('treats loopback spellings of one port as the same server', () => {
  assert.equal(isSameOpenCodeServer('http://127.0.0.1:49374', 'http://localhost:49374/'), true);
  assert.equal(isSameOpenCodeServer('http://127.0.0.1:49374', 'http://[::1]:49374'), true);
});

test('never matches another port, scheme, or host', () => {
  assert.equal(isSameOpenCodeServer('http://127.0.0.1:49374', 'http://127.0.0.1:4096'), false);
  assert.equal(isSameOpenCodeServer('http://127.0.0.1:49374', 'https://127.0.0.1:49374'), false);
  assert.equal(isSameOpenCodeServer('http://127.0.0.1:49374', 'http://example.com:49374'), false);
  assert.equal(isSameOpenCodeServer('not a url', 'http://127.0.0.1:49374'), false);
});

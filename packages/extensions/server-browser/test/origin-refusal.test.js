import assert from 'node:assert/strict';
import test from 'node:test';
import { createOriginRefusal } from '../src/origin-refusal.js';

test('refuses equivalent own origins while retaining unrelated browsing', () => {
  // Given host-owned loopback and public origins.
  const refuses = createOriginRefusal(['http://localhost:3000', 'https://CHAMBER.example.']);
  // When the browser requests alternate spellings of those origins.
  for (const url of [
    'http://LOCALHOST.:3000/private', 'http://sub.localhost:3000',
    'http://127.2:3000', 'http://2130706433:3000', 'http://0x7f000001:3000',
    'http://0177.0.0.1:3000', 'http://127.0.0.1.:3000', 'http://[::1]:3000',
    'http://[::ffff:127.0.0.1]:3000', 'http://0.0.0.0:3000',
    'http://[::ffff:0.0.0.0]:3000',
    'https://chamber.EXAMPLE/path', 'https://chamber.example.:443',
    'wss://chamber.example/socket', 'file:///etc/passwd',
    'https://localhost:3000', 'wss://127.1:3000/socket',
  ]) {
    // Then it refuses before the request reaches its destination.
    assert.equal(refuses(url), true, url);
  }
  for (const url of ['http://localhost:5173', 'https://example.com', 'https://chamber.example.evil', 'http://chamber.example', 'about:blank', 'data:text/html,hello']) {
    assert.equal(refuses(url), false, url);
  }
});

test('rejects malformed host policy instead of losing the refusal', () => {
  // Given malformed origins supplied by the host.
  for (const origins of [null, 'http://localhost:3000', ['garbage'], ['http://example.com/path']]) {
    // When parsing the policy, then startup fails closed.
    assert.throws(() => createOriginRefusal(origins));
  }
});

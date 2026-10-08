import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveForwardedNotificationRuntimeKey, resolveHostEntryForRuntimeKey, stampForwardedNotification } from './notification-host-routing.mjs';

test('local runtime key resolves to a local host entry', () => {
  assert.deepEqual(resolveHostEntryForRuntimeKey('local', {
    hosts: [],
    localUrl: 'http://127.0.0.1:3912',
    localClientToken: 'tok',
  }), { id: 'local', url: 'http://127.0.0.1:3912', clientToken: 'tok', requestHeaders: {} });
});

test('local runtime key without a local server has no target', () => {
  assert.equal(resolveHostEntryForRuntimeKey('local', {
    hosts: [],
    localUrl: null,
    localClientToken: '',
  }), null);
});

test('host runtime key resolves the matching configured host', () => {
  const hosts = [
    { id: 'abc', url: 'https://one.example' },
    { id: 'def', url: 'https://two.example' },
  ];
  assert.equal(resolveHostEntryForRuntimeKey('host:def', {
    hosts,
    localUrl: null,
    localClientToken: '',
  }), hosts[1]);
});

test('unknown host runtime key resolves to null', () => {
  assert.equal(resolveHostEntryForRuntimeKey('host:missing', {
    hosts: [{ id: 'abc', url: 'https://one.example' }],
    localUrl: null,
    localClientToken: '',
  }), null);
});

test('other runtime keys are not routable', () => {
  const deps = { hosts: [], localUrl: 'http://127.0.0.1:3912', localClientToken: '' };
  assert.equal(resolveHostEntryForRuntimeKey('url:https://example.com', deps), null);
  assert.equal(resolveHostEntryForRuntimeKey('transient', deps), null);
  assert.equal(resolveHostEntryForRuntimeKey('', deps), null);
  assert.equal(resolveHostEntryForRuntimeKey(undefined, deps), null);
});

test('runtime keys are trimmed before resolution', () => {
  assert.deepEqual(resolveHostEntryForRuntimeKey('  local  ', {
    hosts: [],
    localUrl: 'http://127.0.0.1:3912',
    localClientToken: '',
  }), { id: 'local', url: 'http://127.0.0.1:3912', clientToken: '', requestHeaders: {} });
});

test('host windows forward their own host id regardless of the renderer key', () => {
  assert.equal(resolveForwardedNotificationRuntimeKey({ runtimeKey: 'url:https://b.example.com', hostWindowId: 'host-b' }), 'host:host-b');
  assert.equal(resolveForwardedNotificationRuntimeKey({ runtimeKey: 'host:stale', hostWindowId: 'host-b' }), 'host:host-b');
  assert.equal(resolveForwardedNotificationRuntimeKey({ runtimeKey: 'local', hostWindowId: 'host-b' }), 'host:host-b');
  assert.equal(resolveForwardedNotificationRuntimeKey({ runtimeKey: '', hostWindowId: 'host-b' }), 'host:host-b');
  assert.equal(resolveForwardedNotificationRuntimeKey({ runtimeKey: undefined, hostWindowId: ' host-b ' }), 'host:host-b');
});

test('untagged windows keep the renderer-provided runtime key', () => {
  assert.equal(resolveForwardedNotificationRuntimeKey({ runtimeKey: 'local', hostWindowId: null }), 'local');
  assert.equal(resolveForwardedNotificationRuntimeKey({ runtimeKey: 'host:host-a', hostWindowId: undefined }), 'host:host-a');
  assert.equal(resolveForwardedNotificationRuntimeKey({ runtimeKey: 'url:https://b.example.com', hostWindowId: '' }), 'url:https://b.example.com');
  assert.equal(resolveForwardedNotificationRuntimeKey({ runtimeKey: '  local  ', hostWindowId: null }), 'local');
  assert.equal(resolveForwardedNotificationRuntimeKey({ runtimeKey: undefined, hostWindowId: null }), '');
});

test('url runtime keys match the host entry their API URL belongs to', () => {
  const deps = {
    hosts: [
      { id: 'host-a', url: 'https://a.example.com', apiUrl: 'https://api.a.example.com' },
      { id: 'host-b', url: 'https://b.example.com/' },
    ],
    localUrl: 'http://127.0.0.1:3912',
    localClientToken: '',
  };
  // A window bound to the entry's API URL (apiUrl wins, url as fallback).
  assert.equal(resolveHostEntryForRuntimeKey('url:https://api.a.example.com', deps)?.id, 'host-a');
  assert.equal(resolveHostEntryForRuntimeKey('url:https://b.example.com', deps)?.id, 'host-b');
  // Unknown origins stay unroutable.
  assert.equal(resolveHostEntryForRuntimeKey('url:https://c.example.com', deps), null);
});

test('a wrapped forwarded payload from a tagged window carries the window tag, not the nested key', () => {
  const stamped = stampForwardedNotification(
    { payload: { title: 't', sessionId: 'ses_x', runtimeKey: 'host:stale' } },
    'b-tag',
  );
  assert.equal(stamped.runtimeKey, 'host:b-tag');
  assert.equal(stamped.title, 't');
  assert.equal(stamped.sessionId, 'ses_x');
  // The nested payload copy is stripped: maybeShowNativeNotification
  // normalizes again, and a surviving nested runtimeKey would shadow the
  // stamp.
  assert.equal(stamped.payload, undefined);
});

test('a forwarded payload from an untagged window keeps the renderer key', () => {
  const stamped = stampForwardedNotification(
    { payload: { title: 't', runtimeKey: 'url:https://b.example' } },
    null,
  );
  assert.equal(stamped.runtimeKey, 'url:https://b.example');
  assert.equal(stamped.payload, undefined);
});

test('a flat forwarded payload is stamped the same way', () => {
  const stamped = stampForwardedNotification({ title: 't', runtimeKey: 'host:x' }, null);
  assert.equal(stamped.runtimeKey, 'host:x');
});

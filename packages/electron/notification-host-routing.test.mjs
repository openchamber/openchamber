import assert from 'node:assert/strict';
import test from 'node:test';

import { findReusableHostWindowIndex, resolveForwardedNotificationRuntimeKey, resolveHostEntryForRuntimeKey, resolveSenderHostId, runtimeKeyForDeepLinkHost, stampForwardedNotification } from './notification-host-routing.mjs';

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

const reuseDeps = {
  hosts: [
    { id: 'host-a', url: 'https://a.example.com' },
    { id: 'host-b', url: 'https://b.example.com', apiUrl: 'https://api.b.example.com' },
  ],
  localUrl: 'http://127.0.0.1:3912',
  localClientToken: 'tok',
};

test('reuse finds the window whose renderer reports the host', () => {
  assert.equal(findReusableHostWindowIndex(
    [{ runtimeKey: 'host:host-b', hostWindowId: null }],
    'host-b',
    reuseDeps,
  ), 0);
  assert.equal(findReusableHostWindowIndex(
    [{ runtimeKey: 'host:host-b', hostWindowId: null }],
    'host-a',
    reuseDeps,
  ), -1);
});

test('a reported key wins over the window creation tag', () => {
  const switched = [{ runtimeKey: 'host:host-b', hostWindowId: 'host-a' }];
  assert.equal(findReusableHostWindowIndex(switched, 'host-b', reuseDeps), 0);
  assert.equal(findReusableHostWindowIndex(switched, 'host-a', reuseDeps), -1);
});

test('a window that has not reported yet is reused by its creation tag', () => {
  assert.equal(findReusableHostWindowIndex(
    [{ runtimeKey: '', hostWindowId: 'host-a' }],
    'host-a',
    reuseDeps,
  ), 0);
  // A booting window is still preferred over nothing when no ready window exists.
  assert.equal(findReusableHostWindowIndex(
    [{ runtimeKey: 'host:host-b', hostWindowId: null }, { runtimeKey: '', hostWindowId: 'host-a' }],
    'host-a',
    reuseDeps,
  ), 1);
});

test('a reported key that resolves to no host does not fall back to the tag', () => {
  assert.equal(findReusableHostWindowIndex(
    [{ runtimeKey: 'url:https://gone.example', hostWindowId: 'host-a' }],
    'host-a',
    reuseDeps,
  ), -1);
});

test('a url runtime key is reused for the host it belongs to', () => {
  assert.equal(findReusableHostWindowIndex(
    [{ runtimeKey: 'url:https://api.b.example.com', hostWindowId: null }],
    'host-b',
    reuseDeps,
  ), 0);
});

test('the local runtime key is reused for the local host', () => {
  assert.equal(findReusableHostWindowIndex(
    [{ runtimeKey: 'local', hostWindowId: null }],
    'local',
    reuseDeps,
  ), 0);
  assert.equal(findReusableHostWindowIndex(
    [{ runtimeKey: 'local', hostWindowId: null }],
    'local',
    { hosts: [], localUrl: null, localClientToken: '' },
  ), -1);
});

test('destroyed windows are skipped and a ready match beats a booting one', () => {
  assert.equal(findReusableHostWindowIndex(
    [null, { runtimeKey: 'host:host-a', hostWindowId: null }],
    'host-a',
    reuseDeps,
  ), 1);
  assert.equal(findReusableHostWindowIndex(
    [{ runtimeKey: '', hostWindowId: 'host-a' }, { runtimeKey: 'host:host-a', hostWindowId: 'host-b' }],
    'host-a',
    reuseDeps,
  ), 1);
});

test('host windows forward their own host id regardless of the renderer key', () => {
  assert.equal(resolveForwardedNotificationRuntimeKey({ runtimeKey: 'url:https://b.example.com', hostWindowId: 'host-b' }), 'host:host-b');
  assert.equal(resolveForwardedNotificationRuntimeKey({ runtimeKey: 'host:stale', hostWindowId: 'host-b' }), 'host:host-b');
  assert.equal(resolveForwardedNotificationRuntimeKey({ runtimeKey: 'local', hostWindowId: 'host-b' }), 'host:host-b');
  assert.equal(resolveForwardedNotificationRuntimeKey({ runtimeKey: '', hostWindowId: 'host-b' }), 'host:host-b');
  assert.equal(resolveForwardedNotificationRuntimeKey({ runtimeKey: undefined, hostWindowId: ' host-b ' }), 'host:host-b');
});

test('a window tagged for the local instance forwards the local key', () => {
  assert.equal(resolveForwardedNotificationRuntimeKey({ runtimeKey: 'host:x', hostWindowId: 'local' }), 'local');
});

test('the sender host is the runtime the window reports, not its creation tag', () => {
  // Opened for host-a, switched in place to Local: its notifications are Local.
  assert.equal(resolveSenderHostId({ runtimeKey: 'local', hostWindowId: 'host-a' }, reuseDeps), 'local');
  assert.equal(resolveSenderHostId({ runtimeKey: 'host:host-b', hostWindowId: 'host-a' }, reuseDeps), 'host-b');
  assert.equal(resolveSenderHostId({ runtimeKey: 'url:https://api.b.example.com', hostWindowId: null }, reuseDeps), 'host-b');
  const stamped = stampForwardedNotification(
    { payload: { sessionId: 'ses_x', runtimeKey: 'local' } },
    resolveSenderHostId({ runtimeKey: 'local', hostWindowId: 'host-a' }, reuseDeps),
  );
  assert.equal(stamped.runtimeKey, 'local');
});

test('the sender host falls back to the creation tag only before the window reports', () => {
  assert.equal(resolveSenderHostId({ runtimeKey: '', hostWindowId: 'host-a' }, reuseDeps), 'host-a');
  assert.equal(resolveSenderHostId({ runtimeKey: null, hostWindowId: null }, reuseDeps), null);
  // A reported key that names no saved host leaves the renderer key in charge.
  assert.equal(resolveSenderHostId({ runtimeKey: 'url:https://gone.example', hostWindowId: 'host-a' }, reuseDeps), null);
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

test('a deep link host id resolves like a notification runtime key', () => {
  const deps = {
    hosts: [{ id: 'host-a', url: 'https://a.example.com' }],
    localUrl: 'http://127.0.0.1:3912',
    localClientToken: '',
  };
  assert.equal(runtimeKeyForDeepLinkHost(' host-a '), 'host:host-a');
  assert.equal(resolveHostEntryForRuntimeKey(runtimeKeyForDeepLinkHost('host-a'), deps), deps.hosts[0]);
  assert.equal(resolveHostEntryForRuntimeKey(runtimeKeyForDeepLinkHost('local'), deps)?.id, 'local');
  assert.equal(resolveHostEntryForRuntimeKey(runtimeKeyForDeepLinkHost('missing'), deps), null);
  // A crafted id stays a host id and cannot select a host by URL.
  assert.equal(runtimeKeyForDeepLinkHost('url:https://a.example.com'), 'host:url:https://a.example.com');
  assert.equal(runtimeKeyForDeepLinkHost(''), '');
  assert.equal(runtimeKeyForDeepLinkHost(null), '');
});

test('a flat forwarded payload is stamped the same way', () => {
  const stamped = stampForwardedNotification({ title: 't', runtimeKey: 'host:x' }, null);
  assert.equal(stamped.runtimeKey, 'host:x');
});

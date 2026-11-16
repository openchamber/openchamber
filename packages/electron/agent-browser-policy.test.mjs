import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_BROWSER_PARTITION,
  BROWSER_PANEL_PARTITION,
  buildAgentBrowserPolicy,
  isStandaloneBrowserPanelPartition,
  shouldCancelAgentBrowserRequest,
} from './agent-browser-policy.mjs';

const policy = buildAgentBrowserPolicy({
  serverUrls: ['http://127.0.0.1:3901', 'https://tunnel.example/app'],
  connectionSettings: [{ url: 'https://STUDIO.example./app', apiUrl: 'http://192.168.1.20:7000/base' }],
  localAddresses: ['192.168.1.10', '::ffff:192.168.1.10'],
});
const cancel = (url, extra = {}) => shouldCancelAgentBrowserRequest({ partition: AGENT_BROWSER_PARTITION, url, policy, ...extra });

test('accepts only the exact human and agent panel partition names', () => {
  assert.equal(AGENT_BROWSER_PARTITION, 'persist:openchamber-browser-agent');
  assert.equal(isStandaloneBrowserPanelPartition(BROWSER_PANEL_PARTITION), true);
  assert.equal(isStandaloneBrowserPanelPartition(AGENT_BROWSER_PARTITION), true);
  for (const partition of ['', 'persist:openchamber-agent', `${AGENT_BROWSER_PARTITION}-other`, ` ${AGENT_BROWSER_PARTITION}`]) {
    assert.equal(isStandaloneBrowserPanelPartition(partition), false);
  }
});

test('blocks app origins through every resource type, including redirected requests', () => {
  for (const resourceType of ['mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font', 'object', 'xhr', 'ping', 'cspReport', 'media', 'webSocket', 'other']) {
    assert.equal(cancel('https://studio.example/api/config/settings', { resourceType }), true);
    assert.equal(cancel('wss://studio.example/api/global/event/ws', { resourceType }), true);
    // The redirect destination reaches onBeforeRequest as a new request.
    assert.equal(cancel('https://tunnel.example/auth/session', { resourceType }), true);
    assert.equal(cancel('https://public.example/asset', { resourceType }), false);
  }
});

test('normalizes hostile loopback spellings and LAN aliases on server ports', () => {
  for (const host of ['localhost', 'LOCALHOST.', '127.1', '0x7f000001', '2130706433', '127.0.0.2', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '0.0.0.0', '[::]', '192.168.1.10', '[::ffff:192.168.1.10]']) {
    assert.equal(cancel(`http://${host}:3901/api`), true, host);
    assert.equal(cancel(`ws://${host}:3901/events`), true, host);
  }
  assert.equal(cancel('http://localhost:3000/dev'), false);
  assert.equal(cancel('http://192.168.1.10:3000/dev'), false);
  assert.equal(cancel('http://localhost.example:3901'), false);
  assert.equal(cancel('https://studio.example.evil'), false);
  assert.equal(cancel('https://studio.example:444'), false);
  assert.equal(cancel('http://192.168.1.20:7000'), true);
});

test('blocks privileged schemes and malformed requests only for the agent', () => {
  for (const url of ['file:///etc/passwd', 'FILE:///etc/passwd', 'devtools://devtools/bundled/inspector.html', 'chrome://settings', 'chrome-extension://id/page', 'about:version', 'blob:https://studio.example/id', 'openchamber-ui://app/index.html', 'not a URL']) {
    assert.equal(cancel(url), true, url);
    assert.equal(cancel(url, { partition: BROWSER_PANEL_PARTITION }), false);
    assert.equal(cancel(url, { partition: 'persist:openchamber-space-example' }), false);
  }
  for (const url of ['about:blank', 'data:text/html,hello', 'blob:https://public.example/id']) assert.equal(cancel(url), false);
});

test('collects all connection URL candidates and refreshes from current inputs', () => {
  const first = buildAgentBrowserPolicy({ connectionSettings: {
    hosts: [{ url: 'https://one.example', apiUrl: 'http://10.1.1.2:8080', candidates: [{ type: 'lan', url: 'http://10.1.1.3:8080' }, { type: 'tunnel', url: 'https://two.example' }] }],
    urls: ['https://three.example'], apiUrls: ['https://four.example'],
    lanUrl: 'http://10.1.1.4:8080', tunnelUrl: 'https://five.example',
    clientToken: 'https://not-an-address.example',
  } });
  for (const url of ['https://one.example', 'http://10.1.1.2:8080', 'http://10.1.1.3:8080', 'https://two.example', 'https://three.example', 'https://four.example', 'http://10.1.1.4:8080', 'https://five.example', 'http://127.1:8080']) {
    assert.equal(cancel(url, { policy: first }), true, url);
  }
  assert.equal(cancel('https://not-an-address.example', { policy: first }), false);
  const second = buildAgentBrowserPolicy({ connectionSettings: { apiUrl: 'https://new.example' } });
  assert.equal(cancel('https://new.example', { policy: second }), true);
  assert.equal(cancel('https://one.example', { policy: second }), false);
});

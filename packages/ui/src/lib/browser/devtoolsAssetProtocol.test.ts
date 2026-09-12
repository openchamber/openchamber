import { describe, expect, test } from 'bun:test';

import {
  encodeDevToolsOwnerClientId,
  parseDevToolsAssetPath,
  parseDevToolsFrontendPath,
  parseScopedDevToolsRequest,
} from './devtoolsAssetProtocol';

const grant = 'abcdefghijklmnopqrstuvwxyzABCDEF';
const routeKey = '0123456789abcdef0123456789abcdef';
const scope = 'https://app.example/assets/openchamber-devtools/';
const ownerClientId = 'window-owner-a';
const ownerPath = encodeDevToolsOwnerClientId(ownerClientId) ?? '';

describe('DevTools asset proxy path contract', () => {
  test('accepts the exact server grant entrypoint', () => {
    expect(parseDevToolsFrontendPath(`/api/browser-devtools/${grant}/inspector.html`)).toEqual({
      assetRoot: `/api/browser-devtools/${grant}`,
    });
  });

  test('rejects grants that could escape or widen the static route', () => {
    for (const path of [
      `/api/browser-devtools/${grant}/../json/version`,
      `/api/browser-devtools/${grant}/%2e%2e/json/version`,
      `/api/browser-devtools/${grant}/inspector.html?token=secret`,
      `https://runtime.example/api/browser-devtools/${grant}/inspector.html`,
    ]) {
      expect(parseDevToolsFrontendPath(path)).toBeNull();
    }
  });

  test('parses only relative static paths for the parent fetch boundary', () => {
    expect(parseDevToolsAssetPath('entrypoints/inspector/inspector.js')).toBe('entrypoints/inspector/inspector.js');
    for (const path of ['../json/version', 'entrypoints/%2e%2e/json', 'json/version', '/api/config', 'bridge.js?debug=true']) {
      expect(parseDevToolsAssetPath(path)).toBeNull();
    }
  });

  test('accepts static assets and only the owned bootstrap query', () => {
    expect(parseScopedDevToolsRequest(
      `${scope}${ownerPath}/${routeKey}/entrypoints/inspector/inspector.js`,
      scope,
    )).toEqual({ routeKey, ownerClientId, assetPath: 'entrypoints/inspector/inspector.js' });
    expect(parseScopedDevToolsRequest(
      `${scope}${ownerPath}/${routeKey}/inspector.html?parentOrigin=https%3A%2F%2Fapp.example&devtoolsId=devtools-a&attachmentRequestId=attach-a`,
      scope,
    )).toEqual({ routeKey, ownerClientId, assetPath: 'inspector.html' });
  });

  test('rejects traversal, cross-origin, encoded, and query-bearing asset requests', () => {
    for (const url of [
      `https://other.example/assets/openchamber-devtools/${ownerPath}/${routeKey}/inspector.html`,
      `${scope}${ownerPath}/${routeKey}/entrypoints/%2e%2e/json/version`,
      `${scope}${ownerPath}/${routeKey}/entrypoints%2Finspector/inspector.js`,
      `${scope}${ownerPath}/${routeKey}/entrypoints/inspector/inspector.js?debug=true`,
      `${scope}${ownerPath}/${routeKey}/inspector.html?parentOrigin=https%3A%2F%2Fevil.example`,
      `${scope}${ownerPath}/${routeKey}/inspector.html?devtoolsId=a&devtoolsId=b`,
      `${scope}not-hex/${routeKey}/inspector.html`,
    ]) {
      expect(parseScopedDevToolsRequest(url, scope)).toBeNull();
    }
  });
});

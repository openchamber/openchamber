import { describe, expect, test } from 'bun:test';

import {
  isLoopbackPreviewHostname,
  isLoopbackPreviewUrl,
} from './screenshot-capture';

describe('isLoopbackPreviewHostname', () => {
  test('accepts the same loopback hosts as the preview proxy non-external path', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'LOCALHOST']) {
      expect(isLoopbackPreviewHostname(host)).toBe(true);
    }
  });

  test('rejects public and private non-loopback hosts', () => {
    for (const host of ['example.com', '192.168.1.1', '10.0.0.5', 'docs.openchamber.dev']) {
      expect(isLoopbackPreviewHostname(host)).toBe(false);
    }
  });
});

describe('isLoopbackPreviewUrl', () => {
  test('detects loopback http(s) URLs used by the web browser pane', () => {
    expect(isLoopbackPreviewUrl('http://localhost:5173/app')).toBe(true);
    expect(isLoopbackPreviewUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isLoopbackPreviewUrl('https://example.com')).toBe(false);
    expect(isLoopbackPreviewUrl('not a url')).toBe(false);
  });
});

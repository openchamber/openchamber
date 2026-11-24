import { describe, expect, test } from 'bun:test';

import { readVoiceListAnswer } from './useCustomServerVoices';

describe('readVoiceListAnswer', () => {
  test('a list of voices is listed', () => {
    expect(readVoiceListAnswer(200, '{"voices":["af_bella","af_sky"]}')).toEqual({ kind: 'listed', voices: ['af_bella', 'af_sky'] });
  });

  test('an empty list means the server has none', () => {
    expect(readVoiceListAnswer(200, '{"voices":[]}')).toEqual({ kind: 'none' });
  });

  test('a known failure keeps its reason', () => {
    for (const code of ['rejected_key', 'key_not_sent', 'remote_disabled', 'enterprise_mode', 'invalid_base_url', 'unreachable', 'upstream_error']) {
      expect(readVoiceListAnswer(502, JSON.stringify({ code }))).toEqual({ kind: 'failed', code });
    }
  });

  test('an answer it cannot read is a failure, never a server without a list', () => {
    for (const [status, text] of [[502, '{"code":"something_new"}'], [200, '<html></html>'], [500, ''], [502, '{"error":"Bad gateway"}']] as const) {
      expect(readVoiceListAnswer(status, text)).toEqual({ kind: 'failed', code: 'upstream_error' });
    }
  });

  test('a server too old to have the route has no list to offer', () => {
    expect(readVoiceListAnswer(404, '{"error":"Not found"}')).toEqual({ kind: 'none' });
    expect(readVoiceListAnswer(405, '')).toEqual({ kind: 'none' });
  });
});

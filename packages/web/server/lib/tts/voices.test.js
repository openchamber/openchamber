import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { listCustomServerVoices, parseVoiceList } from './voices.js';

const listen = async (handler) => {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
};

describe('parseVoiceList', () => {
  it('reads Kokoro-FastAPI voices in both answer forms', () => {
    const current = JSON.stringify({
      voices: [{ id: 'af_bella', name: 'af_bella', overall_grade: 'A' }, { id: 'af_sky', name: 'af_sky' }],
      default_voice: 'af_bella',
    });
    expect(parseVoiceList(current)).toEqual(['af_bella', 'af_sky']);
    expect(parseVoiceList(JSON.stringify({ voices: ['af_bella', 'af_sky'] }))).toEqual(['af_bella', 'af_sky']);
  });

  it('reads Speaches voices', () => {
    const answer = JSON.stringify({
      voices: [{ name: 'lessac', id: 'lessac', language: 'en_US', gender: 'male' }],
      object: 'list',
    });
    expect(parseVoiceList(answer)).toEqual(['lessac']);
  });

  it('flattens LocalAI voice groups and drops repeats', () => {
    const answer = JSON.stringify({
      data: [
        { model: 'kokoro', voices: [{ name: 'af_bella' }] },
        { model: 'piper', voices: [{ name: 'amy' }, { name: 'af_bella' }] },
        { model: 'broken' },
      ],
    });
    expect(parseVoiceList(answer)).toEqual(['af_bella', 'amy']);
  });

  it('treats anything that is not a voice list as no list', () => {
    for (const text of ['<html></html>', 'null', '42', '[]', '["a"]', '{}', '{"voices":"x"}', '{"models":[]}', '{not json']) {
      expect(parseVoiceList(text)).toEqual([]);
    }
  });

  it('keeps the usable entries of a list and caps its length', () => {
    const answer = JSON.stringify({ voices: [' af_sky ', '', '  ', 5, { language: 'en' }, { id: 7, name: 'am_adam' }, null] });
    expect(parseVoiceList(answer)).toEqual(['af_sky', 'am_adam']);

    const many = JSON.stringify({ voices: Array.from({ length: 1001 }, (_, index) => `voice_${index}`) });
    expect(parseVoiceList(many)).toHaveLength(1000);
  });
});

describe('listCustomServerVoices', () => {
  it('gives up on a server that never answers', async () => {
    const upstream = await listen(() => {});
    try {
      expect(await listCustomServerVoices(upstream.baseURL, undefined, 50)).toEqual({ code: 'unreachable' });
    } finally {
      upstream.close();
    }
  });

  it('gives up on a server that never finishes its answer', async () => {
    const upstream = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"voices":[');
    });
    try {
      expect(await listCustomServerVoices(upstream.baseURL, undefined, 50)).toEqual({ code: 'unreachable' });
    } finally {
      upstream.close();
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenAICompatibleTranscriptionSession } from './openai-compatible-session.js';

describe('OpenAICompatibleTranscriptionSession endpoint path', () => {
  let server;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      server = undefined;
    }
  });

  const listen = async (handler) => {
    server = createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}/v1`;
  };

  it.each([
    ['/speech_to_text', '/v1/speech_to_text'],
    ['', '/v1/audio/transcriptions'],
  ])('transcribes a committed segment with endpoint path %j', async (endpointPath, expectedUrl) => {
    let received;
    const baseURL = await listen(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const form = await new Response(Buffer.concat(chunks), {
        headers: { 'Content-Type': request.headers['content-type'] },
      }).formData();
      received = {
        url: request.url,
        model: form.get('model'), language: form.get('language'), format: form.get('response_format'),
      };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ text: 'custom path transcript' }));
    });

    const session = new OpenAICompatibleTranscriptionSession({
      baseURL, model: 'whisper-1', language: 'en', endpointPath,
    });
    await session.connect();
    session.appendPcm16(Buffer.alloc(3200, 1));
    const transcript = once(session, 'transcript');
    session.commit();

    const [payload] = await transcript;

    expect(received).toEqual({
      url: expectedUrl, model: 'whisper-1', language: 'en', format: 'json',
    });
    expect(payload).toMatchObject({ transcript: 'custom path transcript', isFinal: true });
  });

  it('refuses an invalid endpoint path before recording', async () => {
    const session = new OpenAICompatibleTranscriptionSession({
      baseURL: 'http://127.0.0.1:9/v1', model: 'whisper-1', endpointPath: 'https://example.com/x',
    });

    await expect(session.connect()).rejects.toThrow(/path, not a URL/i);
  });
});

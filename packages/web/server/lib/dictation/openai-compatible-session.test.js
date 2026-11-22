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

  const listen = async (expectedUrl, handler) => {
    const received = Promise.withResolvers();
    received.promise.catch(() => {});
    server = createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== expectedUrl) {
        response.writeHead(404);
        response.end();
        return;
      }
      Promise.resolve().then(() => handler(request, response)).then(received.resolve, (error) => {
        response.writeHead(500);
        response.end();
        received.reject(error);
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, received: received.promise };
  };

  it.each([
    ['/speech_to_text', '/v1/speech_to_text'],
    ['', '/v1/audio/transcriptions'],
  ])('transcribes a committed segment with endpoint path %j', async (endpointPath, expectedUrl) => {
    const { baseURL, received } = await listen(expectedUrl, async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const form = await new Response(Buffer.concat(chunks), {
        headers: { 'Content-Type': request.headers['content-type'] },
      }).formData();
      const fields = {
        url: request.url,
        model: form.get('model'), language: form.get('language'), format: form.get('response_format'),
      };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ text: 'custom path transcript' }));
      return fields;
    });

    const session = new OpenAICompatibleTranscriptionSession({
      baseURL, model: 'whisper-1', language: 'en', endpointPath,
    });
    await session.connect();
    session.appendPcm16(Buffer.alloc(3200, 1));
    const transcript = once(session, 'transcript');
    const unrelated = fetch(new URL('/health', baseURL));
    session.commit();

    const [fields, [payload]] = await Promise.all([received, transcript]);

    expect(fields).toEqual({
      url: expectedUrl, model: 'whisper-1', language: 'en', format: 'json',
    });
    expect(payload).toMatchObject({ transcript: 'custom path transcript', isFinal: true });
    expect((await unrelated).status).toBe(404);
  });

  it.each([
    ['sends the prompt with every committed segment', 'Español e inglés.\nTérminos: OpenChamber, 東京'],
    ['sends no prompt field without a prompt', undefined],
  ])('%s', async (_name, prompt) => {
    const requests = [];
    server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const form = await new Response(Buffer.concat(chunks), {
        headers: { 'Content-Type': request.headers['content-type'] },
      }).formData();
      requests.push({ hasPrompt: form.has('prompt'), prompt: form.get('prompt'), language: form.get('language') });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ text: `segment ${requests.length}` }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const session = new OpenAICompatibleTranscriptionSession({
      baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: 'whisper-1', language: 'es', prompt,
    });
    await session.connect();
    for (const expected of ['segment 1', 'segment 2']) {
      session.appendPcm16(Buffer.alloc(3200, 1));
      const transcript = once(session, 'transcript');
      session.commit();
      expect((await transcript)[0].transcript).toBe(expected);
    }

    // Multipart form encoding writes line breaks as CRLF.
    const expected = prompt
      ? { hasPrompt: true, prompt: prompt.replaceAll('\n', '\r\n'), language: 'es' }
      : { hasPrompt: false, prompt: null, language: 'es' };
    expect(requests).toEqual([expected, expected]);
  });

  it('refuses an invalid endpoint path before recording', async () => {
    const session = new OpenAICompatibleTranscriptionSession({
      baseURL: 'http://127.0.0.1:9/v1', model: 'whisper-1', endpointPath: 'https://example.com/x',
    });

    await expect(session.connect()).rejects.toThrow(/path, not a URL/i);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { TTSService } from './service.js';
import { transcribeAudio } from './stt.js';

describe('OpenAI audio SDK compatibility', () => {
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

  it('sends custom speech options and returns the audio bytes', async () => {
    const audio = Buffer.from('speech-response');
    let received;
    const baseURL = await listen(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received = { url: request.url, method: request.method, body: JSON.parse(Buffer.concat(chunks).toString()) };
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      response.end(audio);
    });

    const result = await new TTSService().generateSpeechStream({
      text: 'Hello', model: 'custom-tts', voice: 'coral', speed: 1.2, baseURL,
    });

    // OpenRouter and other strict OpenAI-compatible servers reject /audio/speech
    // requests without an explicit response_format; mp3 is the documented default.
    expect(received).toEqual({
      url: '/v1/audio/speech', method: 'POST',
      body: { input: 'Hello', model: 'custom-tts', voice: 'coral', speed: 1.2, response_format: 'mp3' },
    });
    expect(result).toEqual({ buffer: audio, contentType: 'audio/mpeg' });
  });

  it('uploads transcription audio as multipart data and reads the text', async () => {
    const audio = Buffer.from('transcription-input');
    let received;
    const baseURL = await listen(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const form = await new Response(Buffer.concat(chunks), {
        headers: { 'Content-Type': request.headers['content-type'] },
      }).formData();
      const file = form.get('file');
      received = {
        url: request.url, method: request.method,
        model: form.get('model'), language: form.get('language'), format: form.get('response_format'),
        filename: file.name, audio: Buffer.from(await file.arrayBuffer()),
      };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ text: 'Hello from transcription' }));
    });

    const result = await transcribeAudio({
      audioBuffer: audio, mimeType: 'audio/webm', model: 'whisper-1', language: 'en', baseURL,
    });

    expect(received).toEqual({
      url: '/v1/audio/transcriptions', method: 'POST', model: 'whisper-1', language: 'en',
      format: 'json', filename: 'audio.webm', audio,
    });
    expect(result).toBe('Hello from transcription');
  });
});

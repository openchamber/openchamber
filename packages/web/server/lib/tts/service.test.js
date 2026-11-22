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

  it('passes the upstream content type through to the caller', async () => {
    const audio = Buffer.from('wav-response');
    const baseURL = await listen(async (request, response) => {
      response.writeHead(200, { 'Content-Type': 'audio/wav' });
      response.end(audio);
    });

    const result = await new TTSService().generateSpeechStream({
      text: 'Hello', model: 'custom-tts', voice: 'coral', speed: 1, baseURL,
    });

    expect(result).toEqual({ buffer: audio, contentType: 'audio/wav' });
  });

  it('falls back to audio/mpeg when the server omits the content type', async () => {
    const audio = Buffer.from('unlabelled-response');
    const baseURL = await listen(async (request, response) => {
      response.end(audio);
    });

    const result = await new TTSService().generateSpeechStream({
      text: 'Hello', model: 'custom-tts', voice: 'coral', speed: 1, baseURL,
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

  it('fails a speech request whose server never responds, at the configured deadline', async () => {
    const baseURL = await listen(() => {
      // Accepts the request and never answers: a wedged local speech server.
    });

    await expect(new TTSService().generateSpeechStream({
      text: 'Hello', model: 'custom-tts', voice: 'coral', speed: 1, baseURL, timeoutMs: 250,
    })).rejects.toThrow('timed out');
  });

  it('fails a speech request whose server answers and then stalls the body', async () => {
    let serverSawClose = false;
    const baseURL = await listen(async (request, response) => {
      response.on('close', () => { serverSawClose = true; });
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      response.write('partial-audio');
      // The body never ends: the create call has settled, so only the
      // body-phase deadline can fail this request.
    });

    await expect(new TTSService().generateSpeechStream({
      text: 'Hello', model: 'custom-tts', voice: 'coral', speed: 1, baseURL, timeoutMs: 250,
    })).rejects.toThrow('Speech request timed out after 250 ms');

    // The deadline must also terminate the active body read and close the
    // upstream connection, not just reject for the caller (Codex P2 on
    // PR #839: body.cancel() cannot cancel a read-locked stream).
    for (let attempt = 0; attempt < 80 && !serverSawClose; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(serverSawClose).toBe(true);
  });

  it('fails at one whole deadline when the server answers near it and then stalls the body', async () => {
    let serverSawClose = false;
    const baseURL = await listen(async (request, response) => {
      response.on('close', () => { serverSawClose = true; });
      // Answer at ~200 ms of the 250 ms budget, then stall the body: a
      // body phase armed with its own fresh budget would not fail the
      // request until ~450 ms from the start of the call.
      await new Promise((resolve) => setTimeout(resolve, 200));
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      response.write('partial-audio');
    });

    const startedAt = Date.now();
    await expect(new TTSService().generateSpeechStream({
      text: 'Hello', model: 'custom-tts', voice: 'coral', speed: 1, baseURL, timeoutMs: 250,
    })).rejects.toThrow('Speech request timed out after 250 ms');
    expect(Date.now() - startedAt).toBeLessThan(400);

    for (let attempt = 0; attempt < 80 && !serverSawClose; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(serverSawClose).toBe(true);
  });

  it('fails a speech body that streams past the byte cap, without buffering it all', async () => {
    let serverSawClose = false;
    let chunksWritten = 0;
    const chunk = Buffer.alloc(4 * 1024 * 1024, 1);
    const baseURL = await listen(async (request, response) => {
      response.on('close', () => { serverSawClose = true; });
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      // 32 chunks is 128 MiB -- twice the 64 MiB cap. A client that
      // buffered the whole body before failing would let every chunk
      // through; a capped read cancels the stream shortly past the cap.
      const writeNext = () => {
        while (chunksWritten < 32 && !response.destroyed) {
          chunksWritten += 1;
          if (!response.write(chunk)) {
            response.once('drain', writeNext);
            return;
          }
        }
        if (!response.destroyed) response.end();
      };
      writeNext();
    });

    await expect(new TTSService().generateSpeechStream({
      text: 'Hello', model: 'custom-tts', voice: 'coral', speed: 1, baseURL, timeoutMs: 30_000,
    })).rejects.toThrow('byte limit');

    for (let attempt = 0; attempt < 80 && !serverSawClose; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(serverSawClose).toBe(true);
    expect(chunksWritten).toBeLessThan(32);
  });

  it('returns a small speech response byte-identically through the stream and buffer paths', async () => {
    const audio = Buffer.from('small-speech-response');
    const baseURL = await listen(async (request, response) => {
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      response.end(audio);
    });

    const streamResult = await new TTSService().generateSpeechStream({
      text: 'Hello', model: 'custom-tts', voice: 'coral', speed: 1, baseURL,
    });
    expect(streamResult.buffer).toEqual(audio);

    const previousApiKey = process.env.OPENAI_API_KEY;
    const previousBaseURL = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = baseURL;
    try {
      const bufferResult = await new TTSService().generateSpeechBuffer({
        text: 'Hello', model: 'custom-tts', voice: 'coral', speed: 1,
      });
      expect(bufferResult).toEqual(audio);
    } finally {
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousApiKey;
      if (previousBaseURL === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previousBaseURL;
    }
  });

  it('fails a transcription whose server never responds, at the configured deadline', async () => {
    const baseURL = await listen(() => {
      // Accepts the upload and never answers.
    });

    await expect(transcribeAudio({
      audioBuffer: Buffer.from('transcription-input'), mimeType: 'audio/webm',
      model: 'whisper-1', baseURL, timeoutMs: 250,
    })).rejects.toThrow('timed out');
  });
});

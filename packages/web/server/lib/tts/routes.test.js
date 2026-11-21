import { describe, expect, it, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerTtsRoutes, speechVoiceHeaderValue } from './routes.js';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';
import { updateVoiceKeys } from './voice-keys.js';

const createApp = (sayTTSCapability = null) => {
  const app = express();
  app.use(express.json());
  registerTtsRoutes(app, {
    resolveZenModel: async () => 'gpt-5-nano',
    sayTTSCapability,
  });
  return app;
};

describe('tts routes', () => {
  it('waits for the authoritative macOS say capability', async () => {
    let resolveCapability;
    const capability = new Promise((resolve) => {
      resolveCapability = resolve;
    });
    const pending = request(createApp(capability)).get('/api/tts/say/status');

    resolveCapability({ available: true, voices: [{ name: 'Samantha', locale: 'en_US' }] });

    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      available: true,
      voices: [{ name: 'Samantha', locale: 'en_US' }],
    });
  });

  it('switches the say voice to the language of the text when asked to', async () => {
    const capability = Promise.resolve({
      available: true,
      voices: [
        { name: 'Samantha', locale: 'en_US' },
        { name: 'Lesya', locale: 'uk_UA' },
        { name: 'Lesya (Enhanced)', locale: 'uk_UA' },
      ],
    });
    const app = createApp(capability);
    const response = await request(app)
      .post('/api/tts/say/speak')
      .send({ text: 'Привіт! Це відповідь українською мовою, і вона досить довга.', voice: 'Samantha', language: 'auto' });

    // On macOS the route synthesizes; elsewhere it refuses before running say.
    // Either way the chosen voice must be the Ukrainian one when the platform
    // allows the request to proceed.
    if (process.platform === 'darwin') {
      expect(response.status).toBe(200);
      expect(response.headers['x-speech-voice']).toBe('Lesya%20(Enhanced)');
      expect(response.headers['x-speech-language']).toBe('uk');
    } else {
      expect(response.status).toBe(503);
    }
  });

  it('refuses a say form post, which another site can send without asking', async () => {
    const app = express();
    app.use(express.urlencoded({ extended: true }));
    registerTtsRoutes(app, { sayTTSCapability: null });

    const response = await request(app)
      .post('/api/tts/say/speak')
      .set('Origin', 'https://elsewhere.example')
      .type('form')
      .send({ text: 'Hello', voice: 'Samantha' });

    expect(response.status).toBe(415);
  });

  it.skipIf(process.platform !== 'darwin')('hands voice, rate and text to say as plain values, never to a shell', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-say-'));
    try {
      const app = createApp(Promise.resolve({ available: true, voices: [] }));
      const viaVoice = path.join(dir, 'voice');
      const viaRate = path.join(dir, 'rate');
      const viaText = path.join(dir, 'text.m4a');

      await request(app).post('/api/tts/say/speak').send({ text: 'Hello', voice: `$(touch ${viaVoice})` });
      await request(app).post('/api/tts/say/speak').send({ text: 'Hello', voice: 'Samantha', rate: `200 $(touch ${viaRate})` });
      const spoken = await request(app).post('/api/tts/say/speak').send({ text: `-o${viaText}`, voice: 'Samantha' });

      expect(fs.existsSync(viaVoice)).toBe(false);
      expect(fs.existsSync(viaRate)).toBe(false);
      expect(fs.existsSync(viaText)).toBe(false);
      expect(spoken.status).toBe(200);
      expect(spoken.headers['content-type']).toBe('audio/mp4');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps localized say voice names HTTP-header-safe', () => {
    const encoded = speechVoiceHeaderValue('Milena (Русский (Россия))');
    // Header values must stay printable ASCII or Node rejects the response outright.
    expect(encoded).toMatch(/^[\x21-\x7E]*$/);
    expect(decodeURIComponent(encoded)).toBe('Milena (Русский (Россия))');
    expect(speechVoiceHeaderValue('Samantha')).toBe('Samantha');
  });

  it('refuses OpenAI cloud speech in enterprise mode and says so in the status', async () => {
    process.env.OPENCHAMBER_ENTERPRISE_MODE = 'true';
    try {
      const app = createApp();
      const status = await request(app).get('/api/tts/status');
      expect(status.body).toMatchObject({ available: false, enterpriseMode: true });
      const speak = await request(app).post('/api/tts/speak').send({ text: 'The migration is done', apiKey: 'sk-test' });
      expect(speak.status).toBe(403);
      expect((await request(app).post('/api/voice/token').send({})).status).toBe(403);
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
  });

  it('returns local note fallback while model summarization is retired', async () => {
    const response = await request(createApp())
      .post('/api/text/summarize')
      .send({
        text: 'First sentence. Second sentence with the useful insight.',
        threshold: 0,
        maxLength: 100,
        mode: 'note',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      summary: 'First sentence.',
      summarized: false,
      reason: 'Model summarization provider unavailable',
    });
  });

  it('keeps notification fallback behavior without calling zen', async () => {
    const response = await request(createApp())
      .post('/api/text/summarize')
      .send({
        text: 'Notification text that should fall back cleanly.',
        threshold: 0,
        maxLength: 100,
        mode: 'notification',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      summary: 'Notification text that should fall back cleanly.',
      summarized: false,
      reason: 'Model summarization provider unavailable',
    });
  });

  it('uses the default summary limits for limits that are not numbers', async () => {
    const response = await request(createApp())
      .post('/api/text/summarize')
      .send({ text: 'A short sentence.', threshold: '5', maxLength: null });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      summary: 'A short sentence.',
      summarized: false,
      reason: 'Text under threshold',
    });

    const numeric = await request(createApp())
      .post('/api/text/summarize')
      .send({ text: 'A short sentence.', threshold: 5 });
    expect(numeric.body.reason).toBe('Model summarization provider unavailable');

    const note = await request(createApp())
      .post('/api/text/summarize')
      .send({ text: 'A short sentence.', maxLength: null, mode: 'note' });
    expect(note.body.summary).not.toBe('');
  });

  it.runIf(process.platform === 'darwin')('never hands the say voice or rate to a shell', async () => {
    const marker = path.join(os.tmpdir(), `openchamber-say-injection-${process.pid}-${Date.now()}`);
    const app = createApp(Promise.resolve({ available: true, voices: [] }));
    await request(app).post('/api/tts/say/speak').send({ text: 'Hi', voice: `Samantha" ; touch ${marker} ; echo "` });
    await request(app).post('/api/tts/say/speak').send({ text: 'Hi', rate: `200 ; touch ${marker}` });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('rejects a custom speech endpoint path that is a URL', async () => {
    const response = await request(createApp())
      .post('/api/tts/speak')
      .send({
        text: 'Hello',
        apiKey: 'sk-test',
        baseURL: 'http://127.0.0.1:9/v1',
        endpointPath: 'https://example.com/v1/audio/speech',
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/path, not a URL/i);
  });

  it('forwards the custom speech endpoint path to the upstream server', async () => {
    let seenUrl;
    const upstream = createServer((upstreamRequest, upstreamResponse) => {
      seenUrl = upstreamRequest.url;
      upstreamResponse.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      upstreamResponse.end(Buffer.from('custom-path'));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');

    try {
      const baseURL = `http://127.0.0.1:${upstream.address().port}/v1`;
      const response = await request(createApp())
        .post('/api/tts/speak')
        .send({ text: 'Hello', model: 'custom-tts', voice: 'coral', baseURL, endpointPath: '/custom/speech' });

      expect(response.status).toBe(200);
      expect(Buffer.from(response.body)).toEqual(Buffer.from('custom-path'));
      expect(seenUrl).toBe('/v1/custom/speech');
    } finally {
      upstream.close();
      upstream.closeAllConnections();
    }
  });

  it('rejects a custom transcription endpoint path on the stt route', async () => {
    const response = await request(createApp())
      .post('/api/stt/transcribe')
      .set('Content-Type', 'audio/wav')
      .set('X-Base-URL', 'http://127.0.0.1:9/v1')
      .set('X-Endpoint-Path', '/speech_to_text?trace=1')
      .send(Buffer.from('audio'));

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/query or fragment/i);
  });

  it('forwards the custom transcription endpoint path to the upstream server', async () => {
    let seenUrl;
    const upstream = createServer((upstreamRequest, upstreamResponse) => {
      seenUrl = upstreamRequest.url;
      upstreamResponse.writeHead(200, { 'Content-Type': 'application/json' });
      upstreamResponse.end(JSON.stringify({ text: 'custom path transcript' }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');

    try {
      const baseURL = `http://127.0.0.1:${upstream.address().port}/v1`;
      const response = await request(createApp())
        .post('/api/stt/transcribe')
        .set('Content-Type', 'audio/wav')
        .set('X-Base-URL', baseURL)
        .set('X-Model', 'whisper-1')
        .set('X-Endpoint-Path', '/speech_to_text')
        .send(Buffer.from('audio'));

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ transcript: 'custom path transcript' });
      expect(seenUrl).toBe('/v1/speech_to_text');
    } finally {
      upstream.close();
      upstream.closeAllConnections();
    }
  });

  describe('with the stored custom server key', () => {
    const upstreams = [];

    const startUpstream = async (handler) => {
      const seen = [];
      const server = createServer((upstreamRequest, upstreamResponse) => {
        seen.push({ url: upstreamRequest.url, authorization: upstreamRequest.headers.authorization });
        handler(upstreamRequest, upstreamResponse);
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      upstreams.push(server);
      const origin = `http://127.0.0.1:${server.address().port}`;
      return { seen, origin, baseURL: `${origin}/v1` };
    };

    const redirectTo = (location) => (_request, response) => {
      response.writeHead(307, { Location: location });
      response.end();
    };

    afterEach(() => {
      for (const server of upstreams.splice(0)) {
        server.close();
        server.closeAllConnections();
      }
      updateVoiceKeys({ openaiCompatible: null, stt: null });
    });

    it('refuses a speech form post, which another site can send without asking', async () => {
      const upstream = await startUpstream((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        response.end(Buffer.from('audio'));
      });
      updateVoiceKeys({ openaiCompatible: 'sk-compat' });
      const app = express();
      app.use(express.json());
      app.use(express.urlencoded({ extended: true }));
      registerTtsRoutes(app, { sayTTSCapability: null });

      const response = await request(app)
        .post('/api/tts/speak')
        .set('Origin', 'https://elsewhere.example')
        .type('form')
        .send({ text: 'Hello', baseURL: upstream.baseURL });

      expect(response.status).toBe(415);
      expect(upstream.seen).toHaveLength(0);
    });

    it('never follows a redirect from the speech server, so the text reaches only the approved host', async () => {
      const target = await startUpstream((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        response.end(Buffer.from('audio'));
      });
      const upstream = await startUpstream(redirectTo(`${target.origin}/v1/audio/speech`));
      updateVoiceKeys({ openaiCompatible: 'sk-compat' });

      const response = await request(createApp())
        .post('/api/tts/speak')
        .send({ text: 'Hello', baseURL: upstream.baseURL });

      expect(response.status).toBe(500);
      expect(upstream.seen).toEqual([{ url: '/v1/audio/speech', authorization: 'Bearer sk-compat' }]);
      expect(target.seen).toHaveLength(0);
    });

    it('never follows a redirect from the transcription server, so the audio reaches only the approved host', async () => {
      const target = await startUpstream((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ text: 'stolen' }));
      });
      const upstream = await startUpstream(redirectTo(`${target.origin}/v1/audio/transcriptions`));
      updateVoiceKeys({ stt: 'sk-stt' });

      const response = await request(createApp())
        .post('/api/stt/transcribe')
        .set('Content-Type', 'audio/wav')
        .set('X-Base-URL', upstream.baseURL)
        .send(Buffer.from('audio'));

      expect(response.status).toBe(500);
      expect(upstream.seen).toEqual([{ url: '/v1/audio/transcriptions', authorization: 'Bearer sk-stt' }]);
      expect(target.seen).toHaveLength(0);
    });
  });
});

describe('normalizeCustomOpenAIBaseURL', () => {
  const originalRuntime = process.env.OPENCHAMBER_RUNTIME;
  const originalAllowRemote = process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;

  afterEach(() => {
    // Restore env vars after each test
    if (originalRuntime === undefined) {
      delete process.env.OPENCHAMBER_RUNTIME;
    } else {
      process.env.OPENCHAMBER_RUNTIME = originalRuntime;
    }
    if (originalAllowRemote === undefined) {
      delete process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;
    } else {
      process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS = originalAllowRemote;
    }
  });

  it('rejects remote URLs when OPENCHAMBER_RUNTIME is not set (web)', () => {
    delete process.env.OPENCHAMBER_RUNTIME;
    delete process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;

    const result = normalizeCustomOpenAIBaseURL('https://my-tts-server.example.com/v1');
    expect(result.error).toMatch(/Remote custom server URLs are disabled/);
    expect(result.value).toBeUndefined();
  });

  it('allows remote URLs when OPENCHAMBER_RUNTIME is desktop', () => {
    process.env.OPENCHAMBER_RUNTIME = 'desktop';
    delete process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;

    const result = normalizeCustomOpenAIBaseURL('https://my-tts-server.example.com/v1');
    expect(result.error).toBeUndefined();
    expect(result.value).toBe('https://my-tts-server.example.com/v1');
  });

  it('allows remote URLs when OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS is true', () => {
    delete process.env.OPENCHAMBER_RUNTIME;
    process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS = 'true';

    const result = normalizeCustomOpenAIBaseURL('https://my-tts-server.example.com/v1');
    expect(result.error).toBeUndefined();
    expect(result.value).toBe('https://my-tts-server.example.com/v1');
  });

  it('allows localhost URLs regardless of runtime', () => {
    delete process.env.OPENCHAMBER_RUNTIME;
    delete process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;

    const result = normalizeCustomOpenAIBaseURL('http://localhost:8880/v1');
    expect(result.error).toBeUndefined();
    expect(result.value).toBe('http://localhost:8880/v1');
  });

  it('strips query strings and trailing slashes', () => {
    process.env.OPENCHAMBER_RUNTIME = 'desktop';

    const result = normalizeCustomOpenAIBaseURL('https://my-server.com/v1/?key=123');
    expect(result.value).toBe('https://my-server.com/v1');
  });

  it('keeps custom servers on this machine in enterprise mode, whatever else allows remote', () => {
    process.env.OPENCHAMBER_RUNTIME = 'desktop';
    process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS = 'true';
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      expect(normalizeCustomOpenAIBaseURL('https://my-tts-server.example.com/v1').error).toMatch(/enterprise mode/);
      expect(normalizeCustomOpenAIBaseURL('http://127.0.0.1:8880/v1').value).toBe('http://127.0.0.1:8880/v1');
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
  });

  it('denies remote URLs on desktop when env var is explicitly false', () => {
    process.env.OPENCHAMBER_RUNTIME = 'desktop';
    process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS = 'false';

    const result = normalizeCustomOpenAIBaseURL('https://my-tts-server.example.com/v1');
    expect(result.error).toMatch(/Remote custom server URLs are disabled/);
    expect(result.value).toBeUndefined();
  });
});

import { describe, expect, it, afterEach, vi } from 'vitest';
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
import { configureOpenCodeCredentials, openCodeCredentialSource } from '../opencode/auth.js';

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
    expect(result.code).toBe('remote_disabled');
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
      expect(normalizeCustomOpenAIBaseURL('https://my-tts-server.example.com/v1').code).toBe('enterprise_mode');
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
    expect(result.code).toBe('remote_disabled');
    expect(result.value).toBeUndefined();
  });
});

describe('tts voices route', () => {
  const originalRuntime = process.env.OPENCHAMBER_RUNTIME;
  const originalAllowRemote = process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;
  const upstreams = [];

  const startUpstream = async (handler) => {
    const seen = [];
    const server = createServer((upstreamRequest, upstreamResponse) => {
      seen.push({ method: upstreamRequest.method, url: upstreamRequest.url, authorization: upstreamRequest.headers.authorization });
      handler(upstreamRequest, upstreamResponse);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    upstreams.push(server);
    const origin = `http://127.0.0.1:${server.address().port}`;
    return { seen, origin, baseURL: `${origin}/v1` };
  };

  const answerJson = (body, status = 200) => (_request, response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  const approve = (body) => request(createApp()).post('/api/tts/voices/approval').send(body);
  const saveKey = (key, speechServer) => request(createApp()).put('/api/voice/keys')
    .query(speechServer === undefined ? {} : { speechServer })
    .send({ openaiCompatible: key });
  const listedVoices = { voices: ['af_sky'] };

  const askVoices = (body) => request(createApp()).post('/api/tts/voices').send(body);

  afterEach(() => {
    for (const server of upstreams.splice(0)) {
      server.close();
      server.closeAllConnections();
    }
    updateVoiceKeys({ openaiCompatible: null });
    if (originalRuntime === undefined) delete process.env.OPENCHAMBER_RUNTIME;
    else process.env.OPENCHAMBER_RUNTIME = originalRuntime;
    if (originalAllowRemote === undefined) delete process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;
    else process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS = originalAllowRemote;
  });

  it('lists the voices of the custom server with the stored key, ignoring a key or path in the request', async () => {
    const upstream = await startUpstream(answerJson({ voices: [{ id: 'af_bella', name: 'af_bella' }, { id: 'af_sky', name: 'af_sky' }] }));
    updateVoiceKeys({ openaiCompatible: 'sk-compat' }, upstream.origin);

    const response = await askVoices({ baseURL: upstream.baseURL, apiKey: 'sk-body', endpointPath: '/custom/speech' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ voices: ['af_bella', 'af_sky'], keyId: expect.any(String) });
    expect(response.text).not.toContain('sk-compat');
    expect(upstream.seen).toEqual([{ method: 'GET', url: '/v1/audio/voices', authorization: 'Bearer sk-compat' }]);
  });

  it('answers no list for a server without one, authenticating as speech does without a key', async () => {
    const upstream = await startUpstream(answerJson({ detail: 'Not Found' }, 404));

    const response = await askVoices({ baseURL: upstream.baseURL });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ voices: [] });
    expect(upstream.seen[0].authorization).toBe('Bearer not-required');
  });

  it('answers no list for a server that answers every path with a page', async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>app</title>');
    });

    const response = await askVoices({ baseURL: upstream.baseURL });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ voices: [] });
  });

  it('nothing a background read sends approves a server', async () => {
    const upstream = await startUpstream(answerJson(listedVoices));
    await saveKey('sk-compat');
    const { keyId } = (await askVoices({ baseURL: upstream.baseURL })).body;

    for (const extra of [{ sendStoredKey: true }, { keyId }, { approve: true, keyId }, { approval: 'added', speechServer: upstream.origin }]) {
      await request(createApp()).post('/api/tts/voices').query({ speechServer: upstream.origin, keyId }).send({ baseURL: upstream.baseURL, ...extra });
    }
    await askVoices({ baseURL: upstream.baseURL });

    expect(upstream.seen.map((seen) => seen.authorization)).toEqual(Array(6).fill('Bearer not-required'));
  });

  it('sends a key one device saved for its server to no server another device approved before', async () => {
    const a = await startUpstream(answerJson({ detail: 'no' }, 401));
    const b = await startUpstream(answerJson(listedVoices));
    await saveKey('sk-a');
    const { keyId } = (await askVoices({ baseURL: a.baseURL })).body;
    expect((await approve({ baseURL: a.baseURL, keyId })).body).toEqual({ approval: 'added' });
    await askVoices({ baseURL: a.baseURL });
    expect(a.seen.at(-1).authorization).toBe('Bearer sk-a');

    await saveKey('sk-b', b.origin);

    const reopened = await askVoices({ baseURL: a.baseURL });
    expect(a.seen.at(-1).authorization).toBe('Bearer not-required');
    expect(reopened.body).toEqual({ code: 'key_not_sent', keyId: expect.any(String) });
    expect((await approve({ baseURL: a.baseURL, keyId })).body).toEqual({ approval: 'refused' });
    await askVoices({ baseURL: a.baseURL });
    expect(a.seen.map((seen) => seen.authorization)).not.toContain('Bearer sk-b');

    await askVoices({ baseURL: b.baseURL });
    expect(b.seen.at(-1).authorization).toBe('Bearer sk-b');

    expect((await approve({ baseURL: a.baseURL, keyId: reopened.body.keyId })).body).toEqual({ approval: 'added' });
    expect((await approve({ baseURL: a.baseURL, keyId: reopened.body.keyId })).body).toEqual({ approval: 'kept' });
    await askVoices({ baseURL: a.baseURL });
    expect(a.seen.at(-1).authorization).toBe('Bearer sk-b');
  });

  it('a key replaced while a read is under way leaves that read with the key and answer it started with', async () => {
    const b = await startUpstream(answerJson(listedVoices));
    const a = await startUpstream((_request, response) => {
      void saveKey('sk-b', b.origin).then(() => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(listedVoices));
      });
    });
    await saveKey('sk-a', a.origin);
    const { keyId } = (await askVoices({ baseURL: a.baseURL })).body;

    expect((await approve({ baseURL: a.baseURL, keyId })).body).toEqual({ approval: 'refused' });
    await askVoices({ baseURL: a.baseURL });
    expect(a.seen.map((seen) => seen.authorization)).toEqual(['Bearer sk-a', 'Bearer not-required']);
  });

  it('keeps the key from a half-typed address, another server, and a changed scheme or port, but not another path', async () => {
    const a = await startUpstream(answerJson(listedVoices));
    const other = await startUpstream(answerJson(listedVoices));
    await saveKey('sk-a', a.origin);

    await askVoices({ baseURL: a.baseURL.replace('127.0.0.1', 'localhost') });
    await askVoices({ baseURL: other.baseURL });
    await askVoices({ baseURL: `${a.origin}/v2/` });

    expect(other.seen.map((seen) => seen.authorization)).toEqual(['Bearer not-required']);
    expect(a.seen.filter((seen) => seen.url === '/v1/audio/voices').map((seen) => seen.authorization)).toEqual(['Bearer not-required']);
    expect(a.seen.at(-1)).toMatchObject({ url: '/v2/audio/voices', authorization: 'Bearer sk-a' });
  });

  it('approves one server per saved key, and none for a save that names no readable server', async () => {
    const a = await startUpstream(answerJson(listedVoices));
    for (const [speechServer, sent] of [[`${a.baseURL}?x=1`, true], [undefined, false], ['', false], ['not an address', false], ['file:///etc', false], [[a.origin, a.origin], false]]) {
      await saveKey('sk-a', a.origin);
      await saveKey('sk-new', speechServer);
      await askVoices({ baseURL: a.baseURL });
      expect(a.seen.at(-1).authorization).toBe(sent ? 'Bearer sk-new' : 'Bearer not-required');
    }
  });

  it('removing the key takes every approval with it, and another key changes none', async () => {
    const a = await startUpstream(answerJson(listedVoices));
    const { openaiCompatibleKeyId } = (await saveKey('sk-a', a.origin)).body;
    expect((await request(createApp()).get('/api/voice/keys')).body.openaiCompatibleKeyId).toBe(openaiCompatibleKeyId);
    await request(createApp()).put('/api/voice/keys').query({ speechServer: 'http://localhost:9' }).send({ openai: 'sk-openai' });
    await askVoices({ baseURL: a.baseURL });
    expect(a.seen.at(-1).authorization).toBe('Bearer sk-a');

    const removed = await saveKey(null, a.origin);
    expect(removed.body).not.toHaveProperty('openaiCompatibleKeyId');
    expect((await approve({ baseURL: a.baseURL, keyId: openaiCompatibleKeyId })).body).toEqual({ approval: 'refused' });
    await saveKey('sk-a');
    await askVoices({ baseURL: a.baseURL });
    expect(a.seen.at(-1).authorization).toBe('Bearer not-required');
    updateVoiceKeys({ openai: null });
  });

  it('the approval route refuses what the list refuses, and an approval without the key id', async () => {
    const a = await startUpstream(answerJson(listedVoices));
    const { openaiCompatibleKeyId: keyId } = (await saveKey('sk-a')).body;
    for (const body of [{}, { keyId: '' }, { keyId: 'guess' }, { keyId: 7 }, { keyId: [keyId] }]) {
      expect((await approve({ baseURL: a.baseURL, ...body })).body).toEqual({ approval: 'refused' });
    }
    expect((await approve({ baseURL: 'ftp://localhost/v1', keyId })).status).toBe(400);
    const app = express();
    app.use(express.urlencoded({ extended: true }));
    registerTtsRoutes(app, { sayTTSCapability: null });
    expect((await request(app).post('/api/tts/voices/approval').type('form').send({ baseURL: a.baseURL, keyId })).status).toBe(415);
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      const remote = await approve({ baseURL: 'https://voices.example.com/v1', keyId });
      expect(remote.status).toBe(403);
      expect(remote.body.code).toBe('enterprise_mode');
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
    await askVoices({ baseURL: a.baseURL });
    expect(a.seen.at(-1).authorization).toBe('Bearer not-required');
  });

  it('tells a refused key from a stored key that was not sent', async () => {
    const upstream = await startUpstream(answerJson({ detail: 'Invalid API key' }, 401));
    await saveKey('sk-compat');

    const withheld = await askVoices({ baseURL: upstream.baseURL });
    expect(withheld.status).toBe(502);
    expect(withheld.body.code).toBe('key_not_sent');

    await approve({ baseURL: upstream.baseURL, keyId: withheld.body.keyId });
    expect((await askVoices({ baseURL: upstream.baseURL })).body.code).toBe('rejected_key');

    await saveKey(null);
    expect((await askVoices({ baseURL: upstream.baseURL })).body).toEqual({ code: 'rejected_key' });
  });

  it('never follows a redirect, and reports only one that leads to a voice list', async () => {
    const target = await startUpstream(answerJson({ voices: ['stolen'] }));
    for (const [location, status, body] of [
      [`${target.origin}/v1/audio/voices`, 502, { code: 'redirected' }],
      [`${target.origin}/v1/audio/voices/`, 502, { code: 'redirected' }],
      ['/api/v1/audio/voices?x=1', 502, { code: 'redirected' }],
      [`${target.origin}/`, 200, { voices: [] }],
      ['/login?next=/v1/audio/voices', 200, { voices: [] }],
      ['http://[', 200, { voices: [] }],
      [undefined, 200, { voices: [] }],
    ]) {
      const upstream = await startUpstream((_request, response) => {
        response.writeHead(302, location === undefined ? {} : { Location: location });
        response.end();
      });
      updateVoiceKeys({ openaiCompatible: 'sk-compat' }, upstream.origin);
      const response = await askVoices({ baseURL: upstream.baseURL });
      expect(response.status).toBe(status);
      expect(response.body).toMatchObject(body);
      expect(upstream.seen.map((seen) => seen.authorization)).toEqual(['Bearer sk-compat']);
    }
    expect(target.seen).toHaveLength(0);
  });

  it('reports a refused key without answering 401 itself', async () => {
    for (const status of [401, 403]) {
      const upstream = await startUpstream(answerJson({ detail: 'Invalid API key' }, status));

      const response = await askVoices({ baseURL: upstream.baseURL });

      expect(response.status).toBe(502);
      expect(response.body).toEqual({ code: 'rejected_key' });
    }
  });

  it('tells a server without the endpoint from a failing one', async () => {
    for (const [status, expected] of [[405, { voices: [] }], [501, { voices: [] }], [400, { voices: [] }], [410, { voices: [] }], [422, { voices: [] }], [500, { code: 'upstream_error' }], [429, { code: 'upstream_error' }]]) {
      const upstream = await startUpstream(answerJson({ detail: 'x' }, status));

      const response = await askVoices({ baseURL: upstream.baseURL });

      expect(response.body).toEqual(expected);
    }
  });

  it('refuses a form post, which another site can send without asking', async () => {
    const upstream = await startUpstream(answerJson({ voices: ['af_sky'] }));
    updateVoiceKeys({ openaiCompatible: 'sk-compat' }, upstream.origin);
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    registerTtsRoutes(app, { sayTTSCapability: null });

    const response = await request(app)
      .post('/api/tts/voices')
      .set('Origin', 'https://elsewhere.example')
      .type('form')
      .send({ baseURL: upstream.baseURL });

    expect(response.status).toBe(415);
    expect(upstream.seen).toHaveLength(0);
  });

  it('reports a server that is not running', async () => {
    const upstream = await startUpstream(() => {});
    const server = upstreams.pop();
    server.close();
    await once(server, 'close');

    const response = await askVoices({ baseURL: upstream.baseURL });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ code: 'unreachable' });
  });

  it('refuses an answer larger than the limit', async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(Buffer.alloc(1024 * 1024 + 1, 32));
    });

    const response = await askVoices({ baseURL: upstream.baseURL });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ code: 'list_too_large' });
  });

  it('refuses hosts the speech check refuses, before any request leaves', async () => {
    delete process.env.OPENCHAMBER_RUNTIME;
    delete process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS;

    const remote = await askVoices({ baseURL: 'http://voices.invalid/v1' });
    expect(remote.status).toBe(400);
    expect(remote.body.code).toBe('remote_disabled');

    const scheme = await askVoices({ baseURL: 'ftp://localhost/v1' });
    expect(scheme.status).toBe(400);
    expect(scheme.body.code).toBe('invalid_base_url');

    const missing = await askVoices({});
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('invalid_base_url');
  });

  it('keeps the voice list on this machine in enterprise mode', async () => {
    const upstream = await startUpstream(answerJson({ voices: ['af_sky'] }));
    process.env.OPENCHAMBER_RUNTIME = 'desktop';
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      const remote = await askVoices({ baseURL: 'https://voices.example.com/v1' });
      expect(remote.status).toBe(403);
      expect(remote.body.code).toBe('enterprise_mode');

      const local = await askVoices({ baseURL: upstream.baseURL });
      expect(local.status).toBe(200);
      expect(local.body).toEqual({ voices: ['af_sky'] });
    } finally {
      delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    }
  });
});

describe('OpenCode provider keys on the custom server', () => {
  const upstreams = [];

  const startUpstream = async (reply) => {
    const seen = [];
    const server = createServer((upstreamRequest, upstreamResponse) => {
      const authorization = upstreamRequest.headers.authorization;
      seen.push({ url: upstreamRequest.url, authorization });
      if (reply?.(upstreamRequest.url, upstreamResponse, authorization) === true) return;
      if (upstreamRequest.url.endsWith('/audio/voices')) {
        upstreamResponse.writeHead(200, { 'Content-Type': 'application/json' });
        upstreamResponse.end(JSON.stringify({ voices: ['af_sky'] }));
      } else if (upstreamRequest.url.endsWith('/audio/transcriptions')) {
        upstreamResponse.writeHead(200, { 'Content-Type': 'application/json' });
        upstreamResponse.end(JSON.stringify({ text: 'hello' }));
      } else {
        upstreamResponse.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        upstreamResponse.end(Buffer.from('audio'));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    upstreams.push(server);
    const origin = `http://127.0.0.1:${server.address().port}`;
    return { seen, origin, baseURL: `${origin}/v1` };
  };

  const openCode = ({ providers, credentials = [], launchEnvironment = null }) => configureOpenCodeCredentials({
    list: async () => credentials,
    listProviders: async () => providers,
    launchEnvironment: () => launchEnvironment,
  });
  const providerInfo = (id, settings = {}, name = id) => ({ id, name, activation: 'enabled', package: '@ai-sdk/openai-compatible', settings });
  const storedCredential = (integrationID, key, extra = {}) => ({ id: `credential-${integrationID}`, integrationID, label: '', active: true, value: { type: 'key', key }, ...extra });

  const configureProviders = (keys, baseURLs = {}) => openCode({
    providers: [...new Set([...Object.keys(baseURLs), ...Object.keys(keys)])].map((id) => (id in baseURLs ? providerInfo(id, { baseURL: baseURLs[id] }, `Name of ${id}`) : providerInfo(id))),
    credentials: Object.entries(keys).map(([integrationID, key]) => storedCredential(integrationID, key)),
  });

  const speak = (baseURL, extra = {}) => request(createApp()).post('/api/tts/speak').send({ text: 'Hello', baseURL, ...extra });
  const voices = (baseURL, extra = {}) => request(createApp()).post('/api/tts/voices').send({ baseURL, ...extra });
  const transcribe = (baseURL, keyProvider) => {
    const call = request(createApp()).post('/api/stt/transcribe').set('Content-Type', 'audio/wav').set('X-Base-URL', baseURL);
    return (keyProvider === undefined ? call : call.set('X-Key-Provider', keyProvider)).send(Buffer.from('audio'));
  };
  const keyProviders = (baseURL) => request(createApp()).get('/api/voice/key-providers').query(baseURL === undefined ? {} : { baseURL });
  const approve = (body) => request(createApp()).post('/api/tts/voices/approval').send(body);
  const lastAuthorization = (upstream) => upstream.seen.at(-1).authorization;
  // The user's one tap on Send key for a provider and a server.
  const allow = async (baseURL, id) => {
    const listed = (await keyProviders(baseURL)).body.providers.find((provider) => provider.id === id);
    expect((await approve({ baseURL, keyProvider: id, keyId: listed.keyId })).body).toEqual({ approval: 'added' });
  };

  afterEach(() => {
    for (const server of upstreams.splice(0)) {
      server.close();
      server.closeAllConnections();
    }
    configureOpenCodeCredentials(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    updateVoiceKeys({ openaiCompatible: null, stt: null });
    fs.rmSync(path.join(process.env.OPENCHAMBER_DATA_DIR, 'voice-keys.json'), { force: true });
  });

  it('preselects the provider whose base URL has the voice server origin, and sends its key only after the user approved that server, speech, voice list and transcription alike', async () => {
    const upstream = await startUpstream();
    configureProviders({ gateway: 'sk-gateway-madeup' }, { gateway: `${upstream.origin}/v1/chat` });
    const calls = [() => speak(upstream.baseURL), () => voices(upstream.baseURL), () => transcribe(upstream.baseURL)];

    expect((await keyProviders(upstream.baseURL)).body.providers).toEqual([{ id: 'gateway', name: 'Name of gateway', keyId: expect.any(String), matches: true, approved: false }]);
    for (const call of calls) {
      expect((await call()).status).toBe(200);
      expect(lastAuthorization(upstream)).toBe('Bearer not-required');
    }
    expect((await keyProviders(upstream.baseURL)).body.providers[0]).toMatchObject({ approved: false });

    await allow(upstream.baseURL, 'gateway');

    expect((await keyProviders(upstream.baseURL)).body.providers[0]).toMatchObject({ matches: true, approved: true });
    expect((await speak(upstream.baseURL)).status).toBe(200);
    expect(lastAuthorization(upstream)).toBe('Bearer sk-gateway-madeup');
    expect((await voices(upstream.baseURL)).body).toEqual({ voices: ['af_sky'] });
    expect(lastAuthorization(upstream)).toBe('Bearer sk-gateway-madeup');
    expect((await transcribe(upstream.baseURL)).body).toEqual({ transcript: 'hello' });
    expect(lastAuthorization(upstream)).toBe('Bearer sk-gateway-madeup');
  });

  it('an explicit choice of the matching provider is no approval either', async () => {
    const upstream = await startUpstream();
    configureProviders({ gateway: 'sk-gateway-madeup' }, { gateway: upstream.baseURL });

    for (const call of [() => speak(upstream.baseURL, { keyProvider: 'gateway' }), () => voices(upstream.baseURL, { keyProvider: 'gateway' }), () => transcribe(upstream.baseURL, 'gateway')]) {
      await call();
      expect(lastAuthorization(upstream)).toBe('Bearer not-required');
    }
  });

  it('takes the key of a provider that only inline or launch configuration defines, with {env:} resolved', async () => {
    const upstream = await startUpstream();
    openCode({ providers: [providerInfo('inline', { baseURL: upstream.baseURL, apiKey: '{env:VOICE_TEST_GATEWAY_KEY}' })], launchEnvironment: { VOICE_TEST_GATEWAY_KEY: 'sk-from-env-madeup' } });
    await allow(upstream.baseURL, 'inline');

    await speak(upstream.baseURL);

    expect(lastAuthorization(upstream)).toBe('Bearer sk-from-env-madeup');
  });

  it('prefers a key typed for the kind, then the provider key, then none', async () => {
    const upstream = await startUpstream();
    configureProviders({ gateway: 'sk-gateway-madeup' }, { gateway: upstream.baseURL });
    await allow(upstream.baseURL, 'gateway');
    updateVoiceKeys({ openaiCompatible: 'sk-typed-tts', stt: 'sk-typed-stt' });

    await speak(upstream.baseURL);
    expect(lastAuthorization(upstream)).toBe('Bearer sk-typed-tts');
    await speak(upstream.baseURL, { apiKey: 'sk-body' });
    expect(lastAuthorization(upstream)).toBe('Bearer sk-body');
    await voices(upstream.baseURL, { keyProvider: 'gateway' });
    expect(lastAuthorization(upstream)).toBe('Bearer not-required');
    await transcribe(upstream.baseURL, 'gateway');
    expect(lastAuthorization(upstream)).toBe('Bearer sk-typed-stt');

    updateVoiceKeys({ openaiCompatible: null, stt: null });
    await speak(upstream.baseURL);
    expect(lastAuthorization(upstream)).toBe('Bearer sk-gateway-madeup');
    configureProviders({}, { gateway: upstream.baseURL });
    await speak(upstream.baseURL);
    expect(lastAuthorization(upstream)).toBe('Bearer not-required');
  });

  it('sends nothing for a user who chose no provider, and nothing when two providers share the origin', async () => {
    const upstream = await startUpstream();
    configureProviders({ gateway: 'sk-gateway-madeup' }, { gateway: upstream.baseURL });
    await allow(upstream.baseURL, 'gateway');

    await speak(upstream.baseURL, { keyProvider: '' });
    expect(lastAuthorization(upstream)).toBe('Bearer not-required');
    await voices(upstream.baseURL, { keyProvider: '' });
    expect(lastAuthorization(upstream)).toBe('Bearer not-required');
    await transcribe(upstream.baseURL, '');
    expect(lastAuthorization(upstream)).toBe('Bearer not-required');

    configureProviders({ gateway: 'sk-gateway-madeup', twin: 'sk-twin-madeup' }, { gateway: upstream.baseURL, twin: `${upstream.origin}/other` });
    await allow(upstream.baseURL, 'twin');
    await speak(upstream.baseURL);
    expect(lastAuthorization(upstream)).toBe('Bearer not-required');
    await speak(upstream.baseURL, { keyProvider: 'twin' });
    expect(lastAuthorization(upstream)).toBe('Bearer sk-twin-madeup');
  });

  it.each(['None', 'a typed key', 'an untouched choice without a grant', 'an untouched choice with a grant elsewhere'])('makes no OpenCode reads for custom voice requests with %s', async (choice) => {
    const upstream = await startUpstream();
    if (choice === 'an untouched choice with a grant elsewhere') {
      const elsewhere = (await startUpstream()).baseURL;
      configureProviders({ gateway: 'sk-gateway-madeup' }, { gateway: elsewhere });
      await allow(elsewhere, 'gateway');
    }
    const listProviders = vi.fn(async () => []);
    const list = vi.fn(async () => []);
    const listEnvironmentKeys = vi.fn(async () => ({}));
    configureOpenCodeCredentials({ listProviders, list, listEnvironmentKeys });
    const keyProvider = choice === 'None' ? '' : choice === 'a typed key' ? 'gateway' : undefined;
    if (choice === 'a typed key') updateVoiceKeys({ openaiCompatible: 'sk-typed-tts', stt: 'sk-typed-stt' }, upstream.baseURL);

    expect((await speak(upstream.baseURL, { keyProvider })).status).toBe(200);
    expect((await voices(upstream.baseURL, { keyProvider })).status).toBe(200);
    expect((await transcribe(upstream.baseURL, keyProvider)).status).toBe(200);
    expect([listProviders.mock.calls.length, list.mock.calls.length, listEnvironmentKeys.mock.calls.length]).toEqual([0, 0, 0]);
    if (choice !== 'a typed key') expect(upstream.seen.map(({ authorization }) => authorization)).toEqual(Array(3).fill('Bearer not-required'));

    expect((await keyProviders(upstream.baseURL)).body).toEqual({ providers: [] });
    expect(listProviders).toHaveBeenCalledOnce();
  });

  it('keeps a provider key from any other origin until the user approves that origin for that provider', async () => {
    const own = await startUpstream();
    const voice = await startUpstream();
    const another = await startUpstream();
    configureProviders({ gateway: 'sk-gateway-madeup', other: 'sk-other-madeup' }, { gateway: own.baseURL });

    for (const call of [() => speak(voice.baseURL, { keyProvider: 'gateway' }), () => voices(voice.baseURL, { keyProvider: 'gateway' }), () => transcribe(voice.baseURL, 'gateway')]) {
      await call();
      expect(lastAuthorization(voice)).toBe('Bearer not-required');
    }

    const listed = (await keyProviders(voice.baseURL)).body.providers;
    expect(listed).toEqual([
      { id: 'gateway', name: 'Name of gateway', keyId: expect.any(String), matches: false, approved: false },
      { id: 'other', name: 'other', keyId: expect.any(String), matches: false, approved: false },
    ]);
    const { keyId } = listed[0];
    expect((await approve({ baseURL: voice.baseURL, keyProvider: 'gateway', keyId: 'guess' })).body).toEqual({ approval: 'refused' });
    expect((await approve({ baseURL: voice.baseURL, keyProvider: 'no-such', keyId })).body).toEqual({ approval: 'refused' });
    expect((await approve({ baseURL: voice.baseURL, keyId })).body).toEqual({ approval: 'refused' });
    expect((await approve({ baseURL: voice.baseURL, keyProvider: 'other', keyId })).body).toEqual({ approval: 'refused' });
    await speak(voice.baseURL, { keyProvider: 'gateway' });
    expect(lastAuthorization(voice)).toBe('Bearer not-required');

    expect((await approve({ baseURL: voice.baseURL, keyProvider: 'gateway', keyId })).body).toEqual({ approval: 'added' });
    expect((await approve({ baseURL: voice.baseURL, keyProvider: 'gateway', keyId })).body).toEqual({ approval: 'kept' });

    for (const call of [() => speak(voice.baseURL, { keyProvider: 'gateway' }), () => voices(voice.baseURL, { keyProvider: 'gateway' }), () => transcribe(voice.baseURL, 'gateway')]) {
      await call();
      expect(lastAuthorization(voice)).toBe('Bearer sk-gateway-madeup');
    }
    await speak(voice.baseURL, { keyProvider: 'other' });
    expect(lastAuthorization(voice)).toBe('Bearer not-required');
    await speak(another.baseURL, { keyProvider: 'gateway' });
    expect(lastAuthorization(another)).toBe('Bearer not-required');
    await speak(voice.baseURL);
    expect(lastAuthorization(voice)).toBe('Bearer not-required');
  });

  it('reports a withheld provider key as a rejected key with no key id, so only the provider approval can send it', async () => {
    const own = await startUpstream();
    const voice = await startUpstream((url, response) => {
      if (!url.endsWith('/audio/voices')) return false;
      response.writeHead(401);
      response.end('no');
      return true;
    });
    configureProviders({ gateway: 'sk-gateway-madeup' }, { gateway: own.baseURL });

    const answer = await voices(voice.baseURL, { keyProvider: 'gateway' });

    expect(answer.status).toBe(502);
    expect(answer.body).toEqual({ code: 'rejected_key' });
    expect(voice.seen.map(({ authorization }) => authorization)).toEqual(['Bearer not-required']);
  });

  it('sends no key to an approved origin once another account is the active credential of the provider', async () => {
    const own = await startUpstream();
    const voice = await startUpstream();
    const providers = [providerInfo('gateway', { baseURL: own.baseURL })];
    openCode({ providers, credentials: [storedCredential('gateway', 'sk-first-madeup', { id: 'account-1' })] });
    const { keyId } = (await keyProviders(voice.baseURL)).body.providers[0];
    expect((await approve({ baseURL: voice.baseURL, keyProvider: 'gateway', keyId })).body).toEqual({ approval: 'added' });
    for (const call of [() => speak(voice.baseURL, { keyProvider: 'gateway' }), () => voices(voice.baseURL, { keyProvider: 'gateway' }), () => transcribe(voice.baseURL, 'gateway')]) {
      await call();
      expect(lastAuthorization(voice)).toBe('Bearer sk-first-madeup');
    }

    openCode({ providers, credentials: [storedCredential('gateway', 'sk-first-madeup', { id: 'account-1', active: false }), storedCredential('gateway', 'sk-second-madeup', { id: 'account-2' })] });

    for (const call of [() => speak(voice.baseURL, { keyProvider: 'gateway' }), () => voices(voice.baseURL, { keyProvider: 'gateway' }), () => transcribe(voice.baseURL, 'gateway')]) {
      await call();
      expect(lastAuthorization(voice)).toBe('Bearer not-required');
    }
    expect((await keyProviders(voice.baseURL)).body.providers[0]).toMatchObject({ approved: false });
  });

  it('sends no key to an approved origin once the same credential entry holds other key bytes, until the user approves those', async () => {
    const own = await startUpstream();
    const voice = await startUpstream();
    const providers = [providerInfo('gateway', { baseURL: own.baseURL })];
    const calls = [() => speak(voice.baseURL, { keyProvider: 'gateway' }), () => voices(voice.baseURL, { keyProvider: 'gateway' }), () => transcribe(voice.baseURL, 'gateway')];
    openCode({ providers, credentials: [storedCredential('gateway', 'sk-first-madeup', { id: 'account-1' })] });
    await allow(voice.baseURL, 'gateway');
    for (const call of calls) {
      await call();
      expect(lastAuthorization(voice)).toBe('Bearer sk-first-madeup');
    }

    openCode({ providers, credentials: [storedCredential('gateway', 'sk-replaced-madeup', { id: 'account-1' })] });

    for (const call of calls) {
      await call();
      expect(lastAuthorization(voice)).toBe('Bearer not-required');
    }
    expect((await keyProviders(voice.baseURL)).body.providers[0]).toMatchObject({ approved: false });
    expect((await approve({ baseURL: voice.baseURL, keyProvider: 'gateway', keyId: 'stale' })).body).toEqual({ approval: 'refused' });

    await allow(voice.baseURL, 'gateway');
    for (const call of calls) {
      await call();
      expect(lastAuthorization(voice)).toBe('Bearer sk-replaced-madeup');
    }
    expect(JSON.stringify(JSON.parse(fs.readFileSync(path.join(process.env.OPENCHAMBER_DATA_DIR, 'voice-keys.json'), 'utf8')).providerApprovals)).not.toMatch(/sk-(first|replaced)-madeup/);
  });

  it.each([
    ['a trailing space', 'sk-gateway-madeup '],
    ['a leading space', ' sk-gateway-madeup'],
    ['a trailing line break', 'sk-gateway-madeup\n'],
    ['a leading tab', '\tsk-gateway-madeup'],
    ['an inner line break', 'sk-gateway\nmadeup'],
    ['a letter outside ASCII', 'sk-gatéway-madeup'],
  ])('offers and sends no provider key with %s, whose bytes would change in an HTTP header', async (_name, key) => {
    const upstream = await startUpstream();
    configureProviders({ gateway: key, plain: 'sk-plain-madeup' }, { gateway: upstream.baseURL, plain: upstream.baseURL });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect((await keyProviders(upstream.baseURL)).body.providers.map((provider) => provider.id)).toEqual(['plain']);
    for (const call of [() => speak(upstream.baseURL, { keyProvider: 'gateway' }), () => voices(upstream.baseURL, { keyProvider: 'gateway' }), () => transcribe(upstream.baseURL, 'gateway')]) {
      await call();
      expect(lastAuthorization(upstream)).toBe('Bearer not-required');
    }
    expect((await approve({ baseURL: upstream.baseURL, keyProvider: 'gateway', keyId: 'guess' })).body).toEqual({ approval: 'refused' });

    await allow(upstream.baseURL, 'plain');
    await speak(upstream.baseURL, { keyProvider: 'plain' });
    expect(lastAuthorization(upstream)).toBe('Bearer sk-plain-madeup');
  });

  it('approves the provider the request names, also when the same key is typed for read-aloud, and reports no success without the grant', async () => {
    const upstream = await startUpstream();
    configureProviders({ gateway: 'sk-same-madeup', other: 'sk-other-madeup' }, { gateway: upstream.baseURL });
    updateVoiceKeys({ openaiCompatible: 'sk-same-madeup' });
    const [{ keyId }, { keyId: otherKeyId }] = (await keyProviders(upstream.baseURL)).body.providers;
    await transcribe(upstream.baseURL, 'gateway');
    expect(lastAuthorization(upstream)).toBe('Bearer not-required');

    expect((await approve({ baseURL: upstream.baseURL, keyProvider: 'gateway', keyId: otherKeyId })).body).toEqual({ approval: 'refused' });
    expect((await approve({ baseURL: upstream.baseURL, keyProvider: 'gateway', keyId })).body).toEqual({ approval: 'added' });
    expect((await keyProviders(upstream.baseURL)).body.providers[0]).toMatchObject({ id: 'gateway', approved: true });
    expect((await approve({ baseURL: upstream.baseURL, keyProvider: 'gateway', keyId })).body).toEqual({ approval: 'kept' });
    await transcribe(upstream.baseURL, 'gateway');
    expect(lastAuthorization(upstream)).toBe('Bearer sk-same-madeup');

    expect((await approve({ baseURL: upstream.baseURL, keyId })).body).toEqual({ approval: 'added' });
    expect((await approve({ baseURL: upstream.baseURL, keyId: otherKeyId })).body).toEqual({ approval: 'refused' });
  });

  it('answers names and key ids, never a key, in every response', async () => {
    const upstream = await startUpstream();
    configureProviders({ gateway: 'sk-gateway-madeup', other: 'sk-other-madeup' }, { gateway: upstream.baseURL });

    const answers = [
      await keyProviders(upstream.baseURL),
      await keyProviders(),
      await voices(upstream.baseURL),
      await voices(upstream.baseURL, { keyProvider: 'other' }),
      await approve({ baseURL: upstream.baseURL, keyProvider: 'other', keyId: (await keyProviders()).body.providers[1].keyId }),
      await request(createApp()).get('/api/voice/keys'),
    ];

    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200, 200, 200]);
    for (const answer of answers) expect(answer.text).not.toMatch(/sk-(gateway|other)-madeup/);
    expect(answers[0].body.providers.map((provider) => [provider.id, provider.matches])).toEqual([['gateway', true], ['other', false]]);
    expect(answers[1].body.providers.map((provider) => [provider.id, provider.matches])).toEqual([['gateway', false], ['other', false]]);
    expect(fs.readFileSync(path.join(process.env.OPENCHAMBER_DATA_DIR, 'voice-keys.json'), 'utf8')).not.toMatch(/sk-(gateway|other)-madeup/);
  });

  it('lists no provider when OpenCode has no key, and no search integration even when it has one', async () => {
    openCode({ providers: [] });
    expect((await keyProviders()).body).toEqual({ providers: [] });

    openCode({ providers: [providerInfo('gateway')], credentials: [storedCredential('tavily', 'tvly-madeup')] });
    expect((await keyProviders()).body).toEqual({ providers: [] });
  });

  it('omits the OpenCode public placeholder but offers a saved OpenCode key', async () => {
    const providers = [providerInfo('opencode', { apiKey: 'public' }, 'OpenCode'), providerInfo('gateway', { apiKey: 'sk-gateway-madeup' })];
    openCode({ providers });
    expect((await keyProviders()).body.providers.map(({ id }) => id)).toEqual(['gateway']);

    openCode({ providers, credentials: [storedCredential('opencode', 'sk-opencode-madeup')] });
    expect((await keyProviders()).body.providers.map(({ id }) => id)).toEqual(['opencode', 'gateway']);
  });

  it('answers 503 when OpenCode cannot be asked for its providers, and sends no provider key meanwhile', async () => {
    const upstream = await startUpstream();
    configureProviders({ gateway: 'sk-gateway-madeup' }, { gateway: upstream.baseURL });
    await allow(upstream.baseURL, 'gateway');
    configureOpenCodeCredentials({ list: async () => [storedCredential('gateway', 'sk-gateway-madeup')], listProviders: async () => { throw new Error('OpenCode is not connected yet'); } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const answer = await keyProviders(upstream.baseURL);
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ error: expect.any(String) });
    await speak(upstream.baseURL);
    expect(lastAuthorization(upstream)).toBe('Bearer not-required');
  });

  it.each(['a stored key', 'an environment connection', 'an unavailable plugin probe'])('handles the cold provider list with %s', async (scenario) => {
    const upstream = await startUpstream();
    const key = 'sk-gateway-madeup';
    const usesEnvironment = scenario !== 'a stored key';
    if (usesEnvironment) {
      openCode({ providers: [providerInfo('gateway', { baseURL: upstream.baseURL, apiKey: key })] });
    } else {
      configureProviders({ gateway: key }, { gateway: upstream.baseURL });
    }
    await allow(upstream.baseURL, 'gateway');

    const activates = scenario !== 'an unavailable plugin probe';
    let pluginReads = 0;
    const openCodeServer = await startUpstream((url, res) => {
      const answer = (data, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data }));
        return true;
      };
      if (url === '/api/plugin') {
        if (!activates) return answer([], 503);
        return answer(++pluginReads === 1 ? [] : [{ source: { type: 'builtin' }, features: {}, state: { status: 'active' } }]);
      }
      if (url === '/api/provider') {
        return answer(pluginReads >= 2 ? [providerInfo('gateway', { baseURL: upstream.baseURL })] : []);
      }
      if (url === '/api/credential') return answer(usesEnvironment ? [] : [storedCredential('gateway', key)]);
      if (url === '/api/integration') {
        return answer(pluginReads >= 2 ? [{ id: 'gateway', connections: [{ type: 'env', name: 'VOICE_FIXTURE_KEY' }] }] : []);
      }
      return answer([], 404);
    });
    configureOpenCodeCredentials(openCodeCredentialSource({
      buildOpenCodeUrl: () => openCodeServer.origin,
      getOpenCodeAuthHeaders: () => ({}),
      getLaunchEnvironment: () => usesEnvironment ? { VOICE_FIXTURE_KEY: key } : null,
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const listed = await keyProviders(upstream.baseURL);
    pluginReads = 0;
    const speech = await speak(upstream.baseURL);
    expect({ catalog: [listed.status, listed.body], speech: [speech.status, lastAuthorization(upstream)] }).toEqual({
      catalog: activates
        ? [200, { providers: [{ id: 'gateway', name: 'gateway', keyId: expect.any(String), matches: true, approved: true }] }]
        : [503, { error: 'The OpenCode providers could not be read' }],
      speech: [200, `Bearer ${activates ? key : 'not-required'}`],
    });
    if (!activates) expect(openCodeServer.seen.map(({ url }) => url)).toEqual(['/api/plugin', '/api/plugin']);
  });

  it('answers 503 and sends no provider key when the stored credentials cannot be read', async () => {
    const upstream = await startUpstream();
    const providers = [
      providerInfo('gateway', { baseURL: upstream.baseURL, apiKey: 'sk-config-madeup' }),
      providerInfo('twin', { baseURL: upstream.baseURL }),
    ];
    openCode({ providers, credentials: [storedCredential('twin', 'sk-twin-madeup')] });
    await allow(upstream.origin, 'gateway');
    const chosen = { keyProvider: 'gateway' };
    expect((await speak(upstream.baseURL)).status).toBe(200);
    expect(lastAuthorization(upstream)).toBe('Bearer not-required');
    expect((await speak(upstream.baseURL, chosen)).status).toBe(200);
    expect(lastAuthorization(upstream)).toBe('Bearer sk-config-madeup');

    configureOpenCodeCredentials({ list: async () => { throw new Error('Stored credentials are unreadable'); }, listProviders: async () => providers });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const listed = await keyProviders(upstream.origin);
    const untouched = await speak(upstream.baseURL);
    const explicit = await speak(upstream.baseURL, chosen);
    expect({ catalog: [listed.status, listed.body], speech: [untouched.status, explicit.status], authorization: upstream.seen.slice(-2).map(({ authorization }) => authorization) }).toEqual({
      catalog: [503, { error: 'The OpenCode providers could not be read' }],
      speech: [200, 200],
      authorization: ['Bearer not-required', 'Bearer not-required'],
    });
  });

  it('answers 503 and sends no provider key when the environment connections cannot be read', async () => {
    const upstream = await startUpstream();
    // Two providers at one server: gateway's key comes from an environment connection, twin's is stored.
    const providers = [providerInfo('gateway', { baseURL: upstream.baseURL }), providerInfo('twin', { baseURL: upstream.baseURL })];
    const source = (listEnvironmentKeys) => configureOpenCodeCredentials({
      list: async () => [storedCredential('twin', 'sk-twin-madeup')],
      listProviders: async () => providers,
      listEnvironmentKeys,
    });
    source(async () => ({ gateway: 'sk-gateway-madeup' }));
    await allow(upstream.origin, 'twin');
    expect((await speak(upstream.baseURL)).status).toBe(200);
    expect(lastAuthorization(upstream)).toBe('Bearer not-required');

    source(async () => { throw new Error('integration list failed'); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const listed = await keyProviders(upstream.origin);
    const untouched = await speak(upstream.baseURL);
    expect({ catalog: [listed.status, listed.body], speech: [untouched.status, lastAuthorization(upstream)] }).toEqual({
      catalog: [503, { error: 'The OpenCode providers could not be read' }],
      speech: [200, 'Bearer not-required'],
    });
  });

  it('never sends a provider key to a server another site names with a form post', async () => {
    const upstream = await startUpstream();
    configureProviders({ gateway: 'sk-gateway-madeup' }, { gateway: upstream.baseURL });
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    registerTtsRoutes(app, { sayTTSCapability: null });

    for (const route of ['/api/tts/speak', '/api/tts/voices', '/api/tts/voices/approval']) {
      const response = await request(app).post(route).set('Origin', 'https://elsewhere.example').type('form').send({ baseURL: upstream.baseURL, text: 'Hello' });
      expect(response.status).toBe(415);
    }
    expect(upstream.seen).toHaveLength(0);
  });

  describe('what a keyed call lets through', () => {
    const KEY = 'sk-gateway-madeup';
    const logged = () => JSON.stringify(['log', 'warn', 'error', 'info'].map((method) => vi.mocked(console[method]).mock.calls), (_name, value) => (value instanceof Error ? `${value.message}\n${value.stack}` : value));
    const silenceConsole = () => ['log', 'warn', 'error', 'info'].forEach((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const echoInError = (url, response, authorization) => {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${authorization.slice(7)}.` } }));
      return true;
    };

    it('answers a fixed message and logs only controlled fields when the server echoes the key in an error', async () => {
      const upstream = await startUpstream(echoInError);
      silenceConsole();
      configureProviders({ gateway: KEY }, { gateway: upstream.baseURL });
      await allow(upstream.baseURL, 'gateway');

      const speech = await speak(upstream.baseURL);
      const transcript = await transcribe(upstream.baseURL);

      expect(speech.status).toBe(500);
      expect(transcript.status).toBe(500);
      expect(speech.body.error).toBe('Speech failed: the server answered 401');
      expect(transcript.body.error).toBe('Transcription failed: the server answered 401');
      expect(`${speech.text}${transcript.text}${logged()}`).not.toContain(KEY);
    });

    it('returns upstream errors for a typed key even when a provider is approved', async () => {
      const message = 'Voice quota exhausted for this account';
      const upstream = await startUpstream((_url, response) => {
        response.writeHead(429, { 'Content-Type': 'application/json', 'x-should-retry': 'false' });
        response.end(JSON.stringify({ error: { message } }));
        return true;
      });
      silenceConsole();
      configureProviders({ gateway: KEY }, { gateway: upstream.baseURL });
      await allow(upstream.baseURL, 'gateway');
      updateVoiceKeys({ openaiCompatible: 'sk-typed-tts', stt: 'sk-typed-stt' });

      const speech = await speak(upstream.baseURL, { keyProvider: 'gateway' });
      const transcript = await transcribe(upstream.baseURL, 'gateway');

      expect(speech.status).toBe(500);
      expect(transcript.status).toBe(500);
      expect(speech.body.error).toContain(message);
      expect(transcript.body.error).toContain(message);
      expect(upstream.seen.map(({ authorization }) => authorization)).toEqual(['Bearer sk-typed-tts', 'Bearer sk-typed-stt']);
    });

    it('accepts speech, voices and transcription with ordinary content that matches a typed key', async () => {
      const audio = Buffer.from('ID3 audio bytes containing sk');
      const upstream = await startUpstream((url, response) => {
        if (url.endsWith('/audio/voices') || url.endsWith('/audio/transcriptions')) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(url.endsWith('/audio/voices') ? { voices: ['sky'] } : { text: 'hello world' }));
        } else {
          response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
          response.end(audio);
        }
        return true;
      });
      silenceConsole();
      updateVoiceKeys({ openaiCompatible: 'sk', stt: 'hello' }, upstream.baseURL);

      const speech = await speak(upstream.baseURL);
      const list = await voices(upstream.baseURL);
      const transcript = await transcribe(upstream.baseURL);

      expect(speech.body).toEqual(audio);
      expect(list.body).toEqual({ voices: ['sky'], keyId: expect.any(String) });
      expect(transcript.body).toEqual({ transcript: 'hello world' });
      expect(upstream.seen.map(({ authorization }) => authorization)).toEqual(['Bearer sk', 'Bearer sk', 'Bearer hello']);
    });

    it.each(['application/octet-stream', 'audio/pcm'])('returns keyless audio with the upstream type %s', async (contentType) => {
      const audio = Buffer.from('ID3audio');
      const upstream = await startUpstream((_url, response) => {
        response.writeHead(200, { 'Content-Type': contentType });
        response.end(audio);
        return true;
      });
      silenceConsole();

      const speech = await speak(upstream.baseURL, { keyProvider: '' }).buffer(true).parse((response, callback) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

      expect(speech.status).toBe(200);
      expect(speech.headers['content-type']).toBe(contentType);
      expect(speech.body).toEqual(audio);
      expect(lastAuthorization(upstream)).toBe('Bearer not-required');
    });

    it('refuses audio that is not audio, and audio that holds the key', async () => {
      silenceConsole();
      const page = await startUpstream((url, response, authorization) => {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(`<p>${authorization}</p>`);
        return true;
      });
      const echo = await startUpstream((url, response, authorization) => {
        response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        response.end(Buffer.concat([Buffer.from('ID3'), Buffer.from(authorization.slice(7))]));
        return true;
      });
      configureProviders({ gateway: KEY }, { gateway: page.baseURL });
      await allow(page.baseURL, 'gateway');
      const refusedPage = await speak(page.baseURL);
      configureProviders({ gateway: KEY }, { gateway: echo.baseURL });
      await allow(echo.baseURL, 'gateway');
      const refusedEcho = await speak(echo.baseURL);

      for (const refused of [refusedPage, refusedEcho]) {
        expect(refused.status).toBe(500);
        expect(refused.body.error).toBe("Speech failed: the server's answer was not accepted");
        expect(refused.headers['content-type']).toMatch(/json/);
        expect(refused.text).not.toContain(KEY);
      }
      expect(logged()).not.toContain(KEY);
    });

    it('refuses a transcript and a voice list that hold the key', async () => {
      silenceConsole();
      const upstream = await startUpstream((url, response, authorization) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(url.endsWith('/audio/voices') ? { voices: [`voice-${authorization.slice(7)}`] } : { text: `my key is ${authorization.slice(7)}` }));
        return true;
      });
      configureProviders({ gateway: KEY }, { gateway: upstream.baseURL });
      await allow(upstream.baseURL, 'gateway');

      const transcript = await transcribe(upstream.baseURL);
      const list = await voices(upstream.baseURL);

      expect(transcript.status).toBe(500);
      expect(transcript.body.error).toBe("Transcription failed: the server's answer was not accepted");
      expect(list.status).toBe(502);
      expect(list.body).toEqual({ code: 'upstream_error' });
      expect(`${transcript.text}${list.text}${logged()}`).not.toContain(KEY);
    });

    it('gives the browser a speech type of its own choosing, whatever header the voice server sends', async () => {
      silenceConsole();
      const typeOf = async (contentType) => {
        const upstream = await startUpstream((url, response, authorization) => {
          response.writeHead(200, { 'Content-Type': contentType(authorization.slice(7)), 'X-Echo': authorization.slice(7) });
          response.end(Buffer.from('ID3audio'));
          return true;
        });
        configureProviders({ gateway: KEY }, { gateway: upstream.baseURL });
        await allow(upstream.baseURL, 'gateway');
        return speak(upstream.baseURL);
      };

      const echoed = await typeOf((key) => `audio/mpeg; charset=${key}`);
      const wav = await typeOf(() => 'Audio/X-WAV; rate=24000');

      expect(echoed.status).toBe(200);
      expect(echoed.headers['content-type']).toBe('audio/mpeg');
      expect(JSON.stringify(echoed.headers)).not.toContain(KEY);
      expect(wav.headers['content-type']).toBe('audio/wav');
      expect(echoed.body).toEqual(Buffer.from('ID3audio'));
    });

    it.each(['audio/evil', 'application/octet-stream', 'text/plain', 'video/mp4', 'audio', ''])('refuses speech the server calls %j', async (contentType) => {
      silenceConsole();
      const upstream = await startUpstream((url, response) => {
        response.writeHead(200, contentType === '' ? {} : { 'Content-Type': contentType });
        response.end(Buffer.from('ID3audio'));
        return true;
      });
      configureProviders({ gateway: KEY }, { gateway: upstream.baseURL });
      await allow(upstream.baseURL, 'gateway');

      const answer = await speak(upstream.baseURL);

      // A server that sends no type gets the mp3 the request asked for.
      expect(answer.status).toBe(contentType === '' ? 200 : 500);
      if (contentType !== '') expect(answer.body.error).toBe("Speech failed: the server's answer was not accepted");
      else expect(answer.headers['content-type']).toBe('audio/mpeg');
    });

    it('checks the voice ids as decoded, so an escaped key is refused too', async () => {
      silenceConsole();
      const escaped = (authorization) => authorization.slice(7).replace('sk', '\\u0073k');
      const upstream = await startUpstream((url, response, authorization) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(url.endsWith('/audio/voices') ? `{"voices":["v-${escaped(authorization)}"]}` : '{}');
        return true;
      });
      configureProviders({ gateway: KEY }, { gateway: upstream.baseURL });
      await allow(upstream.baseURL, 'gateway');

      const list = await voices(upstream.baseURL);

      expect(upstream.seen.at(-1).authorization).toBe(`Bearer ${KEY}`);
      expect(list.status).toBe(502);
      expect(list.body).toEqual({ code: 'upstream_error' });
      expect(`${list.text}${logged()}`).not.toContain(KEY);
    });

    it.each([['an array', (key) => ['hello', { note: key }]], ['an object', (key) => ({ note: key })], ['a number', () => 5]])('refuses a transcript that is %s, not a string', async (_name, value) => {
      silenceConsole();
      const upstream = await startUpstream((url, response, authorization) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ text: value(authorization.slice(7)) }));
        return true;
      });
      configureProviders({ gateway: KEY }, { gateway: upstream.baseURL });
      await allow(upstream.baseURL, 'gateway');

      const transcript = await transcribe(upstream.baseURL);

      expect(transcript.status).toBe(500);
      expect(transcript.body.error).toBe("Transcription failed: the server's answer was not accepted");
      expect(`${transcript.text}${logged()}`).not.toContain(KEY);
    });

    it('keeps the words of a keyed transcript out of the server log, and logs those of a call without a key as before', async () => {
      const reply = (url, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ text: 'quiet words spoken aloud' }));
        return true;
      };
      const keyed = await startUpstream(reply);
      const plain = await startUpstream(reply);
      silenceConsole();
      configureProviders({ gateway: KEY }, { gateway: keyed.baseURL });
      await allow(keyed.baseURL, 'gateway');

      expect((await transcribe(keyed.baseURL)).body).toEqual({ transcript: 'quiet words spoken aloud' });
      expect(lastAuthorization(keyed)).toBe(`Bearer ${KEY}`);
      expect(logged()).not.toContain('quiet words');

      vi.mocked(console.log).mockClear();
      expect((await transcribe(plain.baseURL)).body).toEqual({ transcript: 'quiet words spoken aloud' });
      expect(lastAuthorization(plain)).toBe('Bearer not-required');
      expect(logged()).toContain('quiet words');
    });

    it('lets the same answers through for a call without a key', async () => {
      const upstream = await startUpstream((url, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ text: 'my key is not-required' }));
        return true;
      });

      expect((await transcribe(upstream.baseURL)).body).toEqual({ transcript: 'my key is not-required' });
    });
  });
});

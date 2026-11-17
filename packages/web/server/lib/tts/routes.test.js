import { describe, expect, it, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { buildSayArgs, isSafeSayVoice, parseSayRate, registerTtsRoutes, speechVoiceHeaderValue } from './routes.js';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';

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
});

describe('say speak input validation (#2293)', () => {
  it('rejects a voice carrying shell syntax with a 400, on any platform', async () => {
    const response = await request(createApp())
      .post('/api/tts/say/speak')
      .send({ text: 'hi', voice: 'Samantha" -o /tmp/x #', rate: 200 });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/voice/i);
  });

  it('rejects an injected rate with a 400, on any platform', async () => {
    const response = await request(createApp())
      .post('/api/tts/say/speak')
      .send({ text: 'hi', voice: 'Samantha', rate: '200; echo injected' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/rate/i);
  });

  it('rejects a non-integer rate with a 400', async () => {
    const response = await request(createApp())
      .post('/api/tts/say/speak')
      .send({ text: 'hi', voice: 'Samantha', rate: 200.5 });
    expect(response.status).toBe(400);
  });

  it('coerces only plain integer rates inside the accepted range', () => {
    expect(parseSayRate(200)).toBe(200);
    expect(parseSayRate('180')).toBe(180);
    expect(parseSayRate('200; echo injected')).toBeNull();
    expect(parseSayRate('abc')).toBeNull();
    expect(parseSayRate(200.5)).toBeNull();
    expect(parseSayRate(10)).toBeNull();
    expect(parseSayRate(5000)).toBeNull();
    expect(parseSayRate(undefined)).toBeNull();
  });

  it('accepts real localized voice names and rejects shell metacharacters', () => {
    expect(isSafeSayVoice('Samantha')).toBe(true);
    expect(isSafeSayVoice('Lesya (Enhanced)')).toBe(true);
    expect(isSafeSayVoice('Milena (Русский (Россия))')).toBe(true);
    expect(isSafeSayVoice('Samantha" -o /tmp/x #')).toBe(false);
    expect(isSafeSayVoice('a; rm -rf /')).toBe(false);
    expect(isSafeSayVoice('a`id`')).toBe(false);
    expect(isSafeSayVoice('a$(id)')).toBe(false);
    expect(isSafeSayVoice('-v')).toBe(false);
    expect(isSafeSayVoice('')).toBe(false);
  });

  it('builds the say invocation as argv, never a shell string', () => {
    const args = buildSayArgs({ voice: 'Samantha" -o /tmp/x #', rate: 200, tempFile: '/tmp/say-1.m4a', text: "it's; $(id)" });
    expect(args).toEqual(['-v', 'Samantha" -o /tmp/x #', '-r', '200', '-o', '/tmp/say-1.m4a', '--data-format=aac', '--', "it's; $(id)"]);
    // Dash-prefixed text stays speech content behind the `--` terminator,
    // never a `say` option such as --input-file.
    const injected = buildSayArgs({ voice: 'Samantha', rate: 200, tempFile: '/tmp/say-1.m4a', text: '--input-file=/etc/hosts' });
    expect(injected.at(-2)).toBe('--');
    expect(injected.at(-1)).toBe('--input-file=/etc/hosts');
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

import { describe, expect, it, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';

import { registerTtsRoutes } from './routes.js';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';
import { ttsService } from './service.js';

const createApp = () => {
  const app = express();
  app.use(express.json());
  registerTtsRoutes(app, {
    resolveZenModel: async () => 'gpt-5-nano',
    sayTTSCapability: null,
  });
  return app;
};

describe('tts routes', () => {
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

  it('aborts the upstream stream when the client disconnects', async () => {
    let capturedSignal;
    let streamActive = true;
    
    // Spy on isAvailable to bypass key check
    vi.spyOn(ttsService, 'isAvailable').mockReturnValue(true);
    // Spy on getContentType
    vi.spyOn(ttsService, 'getContentType').mockReturnValue('audio/mpeg');
    // Spy on generateSpeechStreamRaw to capture the signal and simulate a stream
    vi.spyOn(ttsService, 'generateSpeechStreamRaw').mockImplementation(async function* (options) {
      capturedSignal = options.signal;
      capturedSignal.addEventListener('abort', () => {
        streamActive = false;
      });
      yield Buffer.from('chunk1');
      // Wait until aborted to yield chunk2, to simulate an ongoing stream
      while (streamActive) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      yield Buffer.from('chunk2');
    });

    const app = createApp();
    const server = app.listen(0); // Listen on random port
    
    try {
      const port = server.address().port;
      
      await new Promise((resolve, reject) => {
        const clientReq = http.request({
          hostname: 'localhost',
          port: port,
          path: '/api/tts/speak',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          }
        }, (res) => {
          // As soon as we get headers, we destroy the request
          clientReq.destroy();
          resolve();
        });
        
        clientReq.on('error', (err) => {
          if (err.code !== 'ECONNRESET') {
             reject(err);
          }
        });
        
        clientReq.write(JSON.stringify({ text: 'Hello world' }));
        clientReq.end();
      });
      
      // Wait for the abort event to propagate (up to 1s)
      for (let i = 0; i < 20; i++) {
        if (capturedSignal && capturedSignal.aborted) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      
      // The captured signal should have been aborted
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal.aborted).toBe(true);
    } finally {
      server.close();
      vi.restoreAllMocks();
    }
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

  it('denies remote URLs on desktop when env var is explicitly false', () => {
    process.env.OPENCHAMBER_RUNTIME = 'desktop';
    process.env.OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS = 'false';

    const result = normalizeCustomOpenAIBaseURL('https://my-tts-server.example.com/v1');
    expect(result.error).toMatch(/Remote custom server URLs are disabled/);
    expect(result.value).toBeUndefined();
  });
});

import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  checkNgrokAuthtokenConfigured,
  checkNgrokAvailable,
  extractNgrokPublicUrlFromText,
  fetchNgrokPublicUrl,
  pollNgrokPublicUrl,
  startNgrokQuickTunnel,
  summarizeNgrokOutput,
} from './ngrok-tunnel.js';

describe('extractNgrokPublicUrlFromText', () => {
  it('extracts public URL from ngrok JSON logs', () => {
    const url = extractNgrokPublicUrlFromText('{"lvl":"info","msg":"started tunnel","url":"https://demo.ngrok-free.app"}\n');

    expect(url).toBe('https://demo.ngrok-free.app');
  });

  it('extracts public URL from ngrok text output', () => {
    const url = extractNgrokPublicUrlFromText('Forwarding https://demo.ngrok-free.app -> http://127.0.0.1:3000');

    expect(url).toBe('https://demo.ngrok-free.app');
  });

  it('ignores non-ngrok URLs', () => {
    const url = extractNgrokPublicUrlFromText('{"url":"https://example.com"}\n');

    expect(url).toBeNull();
  });
});

describe('summarizeNgrokOutput', () => {
  it('prefers actionable JSON error details over trailing help text', () => {
    const summary = summarizeNgrokOutput([
      '{"err":"authentication failed: Your ngrok-agent version \\"3.3.1\\" is too old. The minimum supported agent version for your account is \\"3.20.0\\".\\r\\n\\r\\nERR_NGROK_121\\r\\n","lvl":"crit","msg":"command failed"}',
      'NAME:',
      '  http - start an HTTP tunnel',
    ]);

    expect(summary).toContain('Your ngrok-agent version "3.3.1" is too old');
    expect(summary).toContain('ERR_NGROK_121');
  });

  it('skips bare ERROR lines and keeps the useful error text', () => {
    const summary = summarizeNgrokOutput([
      'ERROR:',
      'ERROR:  authentication failed',
      'ERROR:',
      'ERROR:  ERR_NGROK_121',
    ]);

    expect(summary).toBe('authentication failed ERR_NGROK_121');
  });
});

describe('ngrok availability checks', () => {
  const originalPath = process.env.PATH;
  const originalAuthtoken = process.env.NGROK_AUTHTOKEN;
  const tempDirs = [];

  const installFakeNgrok = (script) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ngrok-check-'));
    tempDirs.push(dir);
    const binary = path.join(dir, 'ngrok');
    fs.writeFileSync(binary, script, { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ''}`;
    return binary;
  };

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalAuthtoken === undefined) {
      delete process.env.NGROK_AUTHTOKEN;
    } else {
      process.env.NGROK_AUTHTOKEN = originalAuthtoken;
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it('reports a prompt ngrok binary as available', async () => {
    const binary = installFakeNgrok('#!/bin/sh\necho "ngrok version 3.20.0"\n');

    const result = await checkNgrokAvailable();

    expect(result.available).toBe(true);
    expect(result.path).toBe(binary);
    expect(result.version).toContain('3.20.0');
  });

  it('settles a hung ngrok version probe as unavailable instead of blocking', async () => {
    installFakeNgrok('#!/bin/sh\nexec sleep 30\n');

    const startedAt = Date.now();
    const result = await checkNgrokAvailable({ timeoutMs: 200 });

    expect(result).toEqual({ available: false, path: null, version: null });
    expect(Date.now() - startedAt).toBeLessThan(10000);
  });

  it('reports a prompt ngrok config check as configured', async () => {
    delete process.env.NGROK_AUTHTOKEN;
    const binary = installFakeNgrok('#!/bin/sh\necho "Valid configuration"\n');

    const result = await checkNgrokAuthtokenConfigured(binary);

    expect(result.configured).toBe(true);
  });

  it('settles a hung ngrok config check as not configured instead of blocking', async () => {
    delete process.env.NGROK_AUTHTOKEN;
    const binary = installFakeNgrok('#!/bin/sh\nexec sleep 30\n');

    const startedAt = Date.now();
    const result = await checkNgrokAuthtokenConfigured(binary, { timeoutMs: 200 });

    expect(result.configured).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(10000);
  });
});

describe('fetchNgrokPublicUrl', () => {
  const tunnelPayload = (tunnels) => new Response(JSON.stringify({ tunnels }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  it('prefers the https tunnel and falls back to any tunnel', async () => {
    const preferred = await fetchNgrokPublicUrl({
      fetchImpl: async () => tunnelPayload([
        { proto: 'http', public_url: 'https://fallback.ngrok-free.app' },
        { proto: 'https', public_url: 'https://demo.ngrok-free.app' },
      ]),
    });
    expect(preferred).toBe('https://demo.ngrok-free.app');

    const fallback = await fetchNgrokPublicUrl({
      fetchImpl: async () => tunnelPayload([
        { proto: 'http', public_url: 'https://fallback.ngrok-free.app' },
      ]),
    });
    expect(fallback).toBe('https://fallback.ngrok-free.app');
  });

  it('returns null for a non-ok response', async () => {
    const result = await fetchNgrokPublicUrl({
      fetchImpl: async () => new Response('{}', { status: 404 }),
    });
    expect(result).toBeNull();
  });

  it('settles a never-answering fetch as null within the deadline', async () => {
    const neverAnswers = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const startedAt = Date.now();
    const result = await fetchNgrokPublicUrl({ fetchImpl: neverAnswers, timeoutMs: 40 });
    expect(result).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('settles a stalled response body read as null within the deadline', async () => {
    const stalledBody = async (_url, { signal }) => {
      const body = new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
        },
      });
      return new Response(body, { status: 200 });
    };
    const startedAt = Date.now();
    const result = await fetchNgrokPublicUrl({ fetchImpl: stalledBody, timeoutMs: 40 });
    expect(result).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('returns null for a tunnels body over the byte cap', async () => {
    const oversized = {
      tunnels: [{ proto: 'https', public_url: 'https://demo.ngrok-free.app', padding: 'x'.repeat(128 * 1024) }],
    };
    const startedAt = Date.now();
    const result = await fetchNgrokPublicUrl({
      fetchImpl: async () => new Response(JSON.stringify(oversized), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });
    expect(result).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('returns null for an invalid JSON body', async () => {
    const result = await fetchNgrokPublicUrl({
      fetchImpl: async () => new Response('not json', { status: 200 }),
    });
    expect(result).toBeNull();
  });

  it('settles promptly when the caller aborts', async () => {
    const caller = new AbortController();
    const neverAnswers = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const startedAt = Date.now();
    const pending = fetchNgrokPublicUrl({ fetchImpl: neverAnswers, timeoutMs: 10000, signal: caller.signal });
    setTimeout(() => caller.abort(), 20);
    expect(await pending).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});

describe('pollNgrokPublicUrl', () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  it('never accumulates in-flight fetches against a wedged agent', async () => {
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const neverAnswers = (_url, { signal }) => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { inFlight -= 1; reject(new Error('aborted')); }, { once: true });
      });
    };
    const poller = pollNgrokPublicUrl({ fetchImpl: neverAnswers, timeoutMs: 40, intervalMs: 10, onPublicUrl: () => {} });
    await wait(180);
    poller.stop();
    await wait(20);
    expect(maxInFlight).toBe(1);
    expect(calls).toBeGreaterThan(1);
    expect(inFlight).toBe(0);
  });

  it('resolves a child-output URL while a poll fetch is in flight', async () => {
    let captured = null;
    const seen = [];
    const neverAnswers = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const poller = pollNgrokPublicUrl({
      fetchImpl: neverAnswers,
      timeoutMs: 10000,
      intervalMs: 10,
      getPublicUrl: () => captured,
      onPublicUrl: (url) => { seen.push(url); poller.stop(); },
    });
    await wait(50);
    captured = 'https://child.ngrok-free.app';
    await wait(60);
    expect(seen).toEqual(['https://child.ngrok-free.app']);
  });

  it('leaves nothing pending after stop() during an in-flight attempt', async () => {
    let calls = 0;
    let inFlight = 0;
    const neverAnswers = (_url, { signal }) => {
      calls += 1;
      inFlight += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { inFlight -= 1; reject(new Error('aborted')); }, { once: true });
      });
    };
    const poller = pollNgrokPublicUrl({ fetchImpl: neverAnswers, timeoutMs: 10000, intervalMs: 10, onPublicUrl: () => {} });
    await wait(50);
    expect(inFlight).toBe(1);
    poller.stop();
    await wait(30);
    expect(inFlight).toBe(0);
    const callsAfterStop = calls;
    await wait(50);
    expect(calls).toBe(callsAfterStop);
  });
});

describe('startNgrokQuickTunnel chunk-split output', () => {
  const originalPath = process.env.PATH;
  const originalAuthtoken = process.env.NGROK_AUTHTOKEN;
  const tempDirs = [];

  const installFakeNgrok = (tunnelScript) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ngrok-start-'));
    tempDirs.push(dir);
    const script = [
      '#!/bin/sh',
      'if [ "$1" = "version" ]; then echo "ngrok version 3.20.0"; exit 0; fi',
      tunnelScript,
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'ngrok'), script, { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ''}`;
    process.env.NGROK_AUTHTOKEN = 'test-token';
  };

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalAuthtoken === undefined) {
      delete process.env.NGROK_AUTHTOKEN;
    } else {
      process.env.NGROK_AUTHTOKEN = originalAuthtoken;
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it('resolves the full URL when the chunk splits after ngrok', async () => {
    installFakeNgrok("printf %s '{\"lvl\":\"info\",\"msg\":\"started tunnel\",\"url\":\"https://abcd1234.ngrok'\nsleep 0.2\nprintf '%s\\n' '-free.app\"}'\nsleep 0.5");

    const tunnel = await startNgrokQuickTunnel({ port: 3210 });

    expect(tunnel.getPublicUrl()).toBe('https://abcd1234.ngrok-free.app');
    tunnel.stop();
  });

  // The background sleep inherits stdout and holds the pipe open after
  // the shell exits, so 'exit' deterministically fires before stdout
  // 'end' (mirrors PR #1702's stderr case for #1693).
  it('includes a final unterminated stdout line in the startup exit error, exactly once', async () => {
    installFakeNgrok("printf %s 'NGROK_FINAL_STDOUT_UNTERMINATED diagnostic'\nsleep 0.2\nsleep 1 &\nexit 3");

    let error = null;
    try {
      await startNgrokQuickTunnel({ port: 3210 });
    } catch (caught) {
      error = caught;
    }

    expect(error).not.toBeNull();
    expect(error.message).toContain('Ngrok exited while starting (code 3)');
    expect(error.message).toContain('NGROK_FINAL_STDOUT_UNTERMINATED diagnostic');
    expect(error.message.split('NGROK_FINAL_STDOUT_UNTERMINATED diagnostic')).toHaveLength(2);
  });

  it('resolves the full URL when the chunk splits inside the scheme', async () => {
    installFakeNgrok("printf %s '{\"lvl\":\"info\",\"msg\":\"started tunnel\",\"url\":\"https:'\nsleep 0.2\nprintf '%s\\n' '//abcd1234.ngrok-free.app\"}'\nsleep 0.5");

    const tunnel = await startNgrokQuickTunnel({ port: 3210 });

    expect(tunnel.getPublicUrl()).toBe('https://abcd1234.ngrok-free.app');
    tunnel.stop();
  });

  // The background sleep inherits stderr and holds the pipe open after the
  // shell exits, so 'exit' deterministically fires before stderr 'end'.
  it('includes a final unterminated stderr line in the startup exit error', async () => {
    installFakeNgrok("printf %s 'ERR_NGROK_FINAL_UNTERMINATED diagnostic' >&2\nsleep 0.2\nsleep 1 >&2 &\nexit 3");

    let error = null;
    try {
      await startNgrokQuickTunnel({ port: 3210 });
    } catch (caught) {
      error = caught;
    }

    expect(error).not.toBeNull();
    expect(error.message).toContain('Ngrok exited while starting (code 3)');
    expect(error.message).toContain('ERR_NGROK_FINAL_UNTERMINATED diagnostic');
  });

  it('captures the final unterminated stderr line exactly once', async () => {
    installFakeNgrok("printf %s 'ERR_NGROK_FINAL_UNTERMINATED diagnostic' >&2\nsleep 0.2\nsleep 1 >&2 &\nexit 3");

    let error = null;
    try {
      await startNgrokQuickTunnel({ port: 3210 });
    } catch (caught) {
      error = caught;
    }

    expect(error).not.toBeNull();
    expect(error.message.split('ERR_NGROK_FINAL_UNTERMINATED diagnostic')).toHaveLength(2);
  });

  it('resolves the full URL from an unterminated final line when stdout closes', async () => {
    // No trailing newline: the URL line reaches captureLines only through the
    // stdout accumulator's stream-end flush(). The fake process closes stdout
    // but stays alive, so startup can settle only via that flush (the agent-API
    // poll has no ngrok agent to answer it in this environment). Removing the
    // flush() call in startNgrokQuickTunnel makes this test hang and fail.
    installFakeNgrok("printf %s '{\"lvl\":\"info\",\"msg\":\"started tunnel\",\"url\":\"https://abcd1234.ngrok-free.app\"}'\nexec 1>&-\nsleep 5");

    const tunnel = await startNgrokQuickTunnel({ port: 3210 });

    expect(tunnel.getPublicUrl()).toBe('https://abcd1234.ngrok-free.app');
    tunnel.stop();
  });

  it('resolves the full URL from an unterminated final line when stderr closes', async () => {
    // No trailing newline: the URL line reaches captureLines only through the
    // stderr accumulator's stream-end flush(). The fake process closes stderr
    // but stays alive, so startup can settle only via that flush (the agent-API
    // poll has no ngrok agent to answer it in this environment). Removing the
    // stderr flush() call in startNgrokQuickTunnel makes this test hang and fail.
    installFakeNgrok("printf %s '{\"lvl\":\"info\",\"msg\":\"started tunnel\",\"url\":\"https://abcd1234.ngrok-free.app\"}' >&2\nexec 2>&-\nsleep 5");

    const tunnel = await startNgrokQuickTunnel({ port: 3210 });

    expect(tunnel.getPublicUrl()).toBe('https://abcd1234.ngrok-free.app');
    tunnel.stop();
  });

  it('resolves a single-chunk URL unchanged', async () => {
    installFakeNgrok("printf '%s\\n' '{\"lvl\":\"info\",\"msg\":\"started tunnel\",\"url\":\"https://abcd1234.ngrok-free.app\"}'\nsleep 0.5");

    const tunnel = await startNgrokQuickTunnel({ port: 3210 });

    expect(tunnel.getPublicUrl()).toBe('https://abcd1234.ngrok-free.app');
    tunnel.stop();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configureOpenCodeCredentials } from '../opencode/auth.js';
import { createDictationService } from './service.js';
import { resumeOptionsOf, sameResumeOptions } from './stream-resume-options.js';
import { resolveProviderKey } from '../tts/provider-keys.js';
import { approveProviderServer, updateVoiceKeys } from '../tts/voice-keys.js';

const VOICE_SERVER = 'http://127.0.0.1:8317';

const providerInfo = (id, baseURL) => ({ id, name: id, activation: 'enabled', package: '@ai-sdk/openai-compatible', settings: { baseURL } });
const storeCredentials = (values, baseURLs = { gateway: `${VOICE_SERVER}/v1` }) => configureOpenCodeCredentials({
  list: async () => Object.entries(values).map(([integrationID, key]) => ({ id: `credential-${integrationID}`, integrationID, label: '', active: true, value: { type: 'key', key } })),
  listProviders: async () => [...new Set([...Object.keys(baseURLs), ...Object.keys(values)])].map((id) => providerInfo(id, baseURLs[id])),
});

// The user's one tap on Send key for a provider and a server.
const approve = async (id, address) => {
  const resolved = await resolveProviderKey(id, address);
  expect(approveProviderServer(resolved.provider, address, resolved.keyId)).toBe('added');
};

describe('dictation key of a custom transcription server', () => {
  let service;
  const upstreams = [];

  beforeEach(() => {
    service = createDictationService({ modelsDir: path.join(os.tmpdir(), 'oc-dictation-provider-key') });
    storeCredentials({ gateway: 'sk-gateway-madeup' });
  });

  afterEach(() => {
    service.shutdown();
    for (const server of upstreams.splice(0)) {
      server.close();
      server.closeAllConnections();
    }
    fs.rmSync(path.join(process.env.OPENCHAMBER_DATA_DIR, 'voice-keys.json'), { force: true });
    configureOpenCodeCredentials(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const startSession = async (openaiCompatible) => {
    const { session, error } = await service.createSttSession({
      provider: 'openai-compatible',
      openaiCompatible: { baseUrl: `${VOICE_SERVER}/v1`, model: 'whisper-1', ...openaiCompatible },
    });
    expect(error).toBeUndefined();
    return session;
  };
  const keyOf = async (openaiCompatible) => {
    const { apiKey, resolveProviderKey } = (await startSession(openaiCompatible)).config;
    return (await resolveProviderKey?.()) ?? apiKey;
  };

  it('uses the key of the provider with the same origin when the user has not chosen, once the user approved that server', async () => {
    expect(await keyOf({})).toBeUndefined();
    expect(await keyOf({ keyProvider: 'gateway' })).toBeUndefined();

    await approve('gateway', `${VOICE_SERVER}/v1`);

    expect(await keyOf({})).toBe('sk-gateway-madeup');
    expect(await keyOf({ keyProvider: 'gateway' })).toBe('sk-gateway-madeup');
  });

  it('uses a key typed for transcription, or sent by an older client, before the provider key', async () => {
    await approve('gateway', `${VOICE_SERVER}/v1`);
    updateVoiceKeys({ stt: 'sk-typed-stt' });
    expect(await keyOf({ keyProvider: 'gateway' })).toBe('sk-typed-stt');
    expect(await keyOf({ apiKey: 'sk-from-client', keyProvider: 'gateway' })).toBe('sk-from-client');
  });

  it('sends no key when the user chose none, or chose a provider whose origin the user has not approved', async () => {
    storeCredentials({ gateway: 'sk-gateway-madeup', other: 'sk-other-madeup' });
    await approve('gateway', `${VOICE_SERVER}/v1`);

    expect(await keyOf({ keyProvider: '' })).toBeUndefined();
    expect(await keyOf({ keyProvider: 'other' })).toBeUndefined();
    expect(await keyOf({ keyProvider: ['gateway'] })).toBe('sk-gateway-madeup');
    expect(await keyOf({ baseUrl: 'http://127.0.0.1:9/v1', keyProvider: 'gateway' })).toBeUndefined();
  });

  it('offers no provider key whose bytes would change in an HTTP header', async () => {
    storeCredentials({ gateway: 'sk-gateway-madeup ' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await resolveProviderKey('gateway', `${VOICE_SERVER}/v1`)).toBeNull();
    expect(await keyOf({ keyProvider: 'gateway' })).toBeUndefined();
    expect(await keyOf({})).toBeUndefined();
  });

  it('does not resume a stream started for another key choice', () => {
    const options = (keyProvider) => resumeOptionsOf({ provider: 'openai-compatible', openaiCompatible: { baseUrl: `${VOICE_SERVER}/v1`, model: 'whisper-1', keyProvider } });

    expect(sameResumeOptions(options('gateway'), options('gateway'))).toBe(true);
    expect(sameResumeOptions(options('gateway'), options('other'))).toBe(false);
    expect(sameResumeOptions(options(undefined), options(''))).toBe(false);
  });

  describe('each segment of a stream', () => {
    const startUpstream = async (reply) => {
      const seen = [];
      const server = createServer((request, response) => {
        const authorization = request.headers.authorization;
        seen.push(authorization);
        request.resume();
        request.on('end', () => {
          if (reply?.(response, authorization) === true) return;
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ text: 'hello' }));
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      upstreams.push(server);
      return { seen, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
    };
    const segment = (session) => new Promise((resolve) => {
      session.once('transcript', (payload) => resolve({ transcript: payload.transcript }));
      session.once('error', (error) => resolve({ error: error.message }));
      session.appendPcm16(Buffer.alloc(3200));
      session.commit();
    });

    it.each(['None', 'a typed key', 'an untouched choice without a grant'])('does not read OpenCode for a segment with %s', async (choice) => {
      const upstream = await startUpstream();
      const listProviders = vi.fn(async () => []);
      const list = vi.fn(async () => []);
      const listEnvironmentKeys = vi.fn(async () => ({}));
      configureOpenCodeCredentials({ listProviders, list, listEnvironmentKeys });
      if (choice === 'a typed key') updateVoiceKeys({ stt: 'hello' });
      const keyProvider = choice === 'None' ? '' : choice === 'a typed key' ? 'gateway' : undefined;
      const session = await startSession({ baseUrl: upstream.baseUrl, keyProvider });

      const result = await segment(session);

      expect([listProviders.mock.calls.length, list.mock.calls.length, listEnvironmentKeys.mock.calls.length]).toEqual([0, 0, 0]);
      expect(result).toEqual({ transcript: 'hello' });
      expect(upstream.seen).toEqual([choice === 'a typed key' ? 'Bearer hello' : 'Bearer not-required']);
    });

    it.each([null, 'sk-first-madeup'])('keeps the initial typed key (%s) at its original server after settings change', async (initialKey) => {
      const original = await startUpstream();
      const next = await startUpstream();
      updateVoiceKeys({ stt: initialKey });
      const running = await startSession({ baseUrl: original.baseUrl, keyProvider: '' });
      const initialAuthorization = `Bearer ${initialKey ?? 'not-required'}`;

      expect(await segment(running)).toEqual({ transcript: 'hello' });
      updateVoiceKeys({ stt: 'sk-next-madeup' });
      expect(await segment(running)).toEqual({ transcript: 'hello' });
      expect(original.seen).toEqual([initialAuthorization, initialAuthorization]);
      expect(next.seen).toEqual([]);

      const replacement = await startSession({ baseUrl: next.baseUrl, keyProvider: '' });
      expect(await segment(replacement)).toEqual({ transcript: 'hello' });
      expect(next.seen).toEqual(['Bearer sk-next-madeup']);
    });

    it('reads the provider key again, so a key that changed or went mid-stream is the key of the next segment', async () => {
      const upstream = await startUpstream();
      const base = new URL(upstream.baseUrl).origin;
      const withKey = async (key) => {
        storeCredentials(key === null ? {} : { gateway: key }, { gateway: `${base}/v1` });
        if (key !== null) await approve('gateway', upstream.baseUrl);
      };
      await withKey('sk-first-madeup');
      const session = await startSession({ baseUrl: upstream.baseUrl });

      expect(await segment(session)).toEqual({ transcript: 'hello' });
      await withKey('sk-second-madeup');
      await segment(session);
      await withKey(null);
      await segment(session);

      expect(upstream.seen).toEqual(['Bearer sk-first-madeup', 'Bearer sk-second-madeup', 'Bearer not-required']);
    });

    it('fails with a fixed message that holds neither the key nor what the server said', async () => {
      const upstream = await startUpstream((response, authorization) => {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${authorization.slice(7)}.` } }));
        return true;
      });
      const logs = ['log', 'warn', 'error', 'info'].map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
      storeCredentials({ gateway: 'sk-gateway-madeup' }, { gateway: `${new URL(upstream.baseUrl).origin}/v1` });
      await approve('gateway', upstream.baseUrl);
      const session = await startSession({ baseUrl: upstream.baseUrl });

      const outcome = await segment(session);

      expect(outcome).toEqual({ error: 'Transcription failed: the server answered 401' });
      expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toContain('sk-gateway-madeup');
    });

    it('never passes on a transcript that holds the key, so neither the browser nor the correction sees it', async () => {
      const upstream = await startUpstream((response, authorization) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ text: `my key is ${authorization.slice(7)}` }));
        return true;
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      storeCredentials({ gateway: 'sk-gateway-madeup' }, { gateway: `${new URL(upstream.baseUrl).origin}/v1` });
      await approve('gateway', upstream.baseUrl);
      const session = await startSession({ baseUrl: upstream.baseUrl });

      expect(await segment(session)).toEqual({ error: "Transcription failed: the server's answer was not accepted" });
    });
  });
});

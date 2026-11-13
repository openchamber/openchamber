import { describe, expect, it } from 'vitest';
import { createEndpointPathFetch, normalizeEndpointPath } from './endpoint-path.js';

describe('normalizeEndpointPath', () => {
  it('treats an empty value as no override', () => {
    expect(normalizeEndpointPath('')).toEqual({ value: undefined });
    expect(normalizeEndpointPath(undefined)).toEqual({ value: undefined });
    expect(normalizeEndpointPath('   ')).toEqual({ value: undefined });
  });

  it('adds the leading slash a user may leave out', () => {
    expect(normalizeEndpointPath('speech_to_text')).toEqual({ value: '/speech_to_text' });
  });

  it('keeps a nested resource path', () => {
    expect(normalizeEndpointPath('/speech/to_text')).toEqual({ value: '/speech/to_text' });
  });

  it.each([
    ['an absolute URL', 'https://example.com/audio/speech'],
    ['a protocol relative URL', '//example.com/audio/speech'],
    ['a query string', '/audio/speech?trace=1'],
    ['a fragment', '/audio/speech#frag'],
    ['a backslash', '/audio\\speech'],
    ['a parent segment', '/audio/../speech'],
    ['a current segment', '/audio/./speech'],
    ['a control character', '/audio\nspeech'],
    ['a space', '/audio speech'],
    ['a bare root path', '/'],
    ['an encoded parent segment', '/audio/%2e%2e/speech'],
    ['an encoded current segment', '/audio/%2e/speech'],
    ['an encoded slash', '/audio%2Fspeech'],
    ['an encoded backslash', '/audio%5Cspeech'],
    ['a malformed escape', '/audio/%zz'],
    ['more than 1024 characters', `/${'a'.repeat(1024)}`],
  ])('rejects %s', (_label, value) => {
    expect(normalizeEndpointPath(value).error).toBeTruthy();
  });
});

describe('createEndpointPathFetch', () => {
  const recordingFetch = () => {
    const calls = [];
    const baseFetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response('ok');
    };
    return { calls, baseFetch };
  };

  it('replaces the default resource path and keeps the base path and query', async () => {
    const { calls, baseFetch } = recordingFetch();
    const scopedFetch = createEndpointPathFetch({
      endpointPath: '/custom/speech',
      defaultPath: '/audio/speech',
      baseFetch,
    });

    await scopedFetch('http://127.0.0.1:8080/v1/audio/speech?trace=1', { method: 'POST' });

    expect(calls[0].url).toBe('http://127.0.0.1:8080/v1/custom/speech?trace=1');
  });

  it('passes the request options through unchanged', async () => {
    const { calls, baseFetch } = recordingFetch();
    const scopedFetch = createEndpointPathFetch({
      endpointPath: '/speech_to_text',
      defaultPath: '/audio/transcriptions',
      baseFetch,
    });
    const controller = new AbortController();
    const init = {
      method: 'POST',
      headers: { 'x-test': 'yes' },
      body: 'payload',
      signal: controller.signal,
    };

    await scopedFetch('http://127.0.0.1:8080/v1/audio/transcriptions', init);

    expect(calls[0].url).toBe('http://127.0.0.1:8080/v1/speech_to_text');
    expect(calls[0].init).toBe(init);
  });

  it('leaves a request for another resource alone', async () => {
    const { calls, baseFetch } = recordingFetch();
    const scopedFetch = createEndpointPathFetch({
      endpointPath: '/custom/speech',
      defaultPath: '/audio/speech',
      baseFetch,
    });

    await scopedFetch('http://127.0.0.1:8080/v1/models', { method: 'GET' });

    expect(calls[0].url).toBe('http://127.0.0.1:8080/v1/models');
  });
});

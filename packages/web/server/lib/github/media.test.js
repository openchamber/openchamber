import { describe, expect, test } from 'bun:test';

import { decodeGitHubMediaSecret, gitHubMediaRequest, readGitHubMedia, sniffMediaType } from './media.js';

const secretFor = (url) => Buffer.from(url).toString('base64url');
const repository = { owner: 'acme', repo: 'app' };
const requestFor = (url, instance = 'github.com') => gitHubMediaRequest(secretFor(url), instance, repository);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

describe('gitHubMediaRequest', () => {
  test('reads a blob link through the Contents API, trying a ref with slashes', () => {
    expect(requestFor('https://github.com/acme/app/blob/release/1.0/docs/shot.png?raw=true')).toEqual({
      urls: [
        'https://api.github.com/repos/acme/app/contents/1.0/docs/shot.png?ref=release',
        'https://api.github.com/repos/acme/app/contents/docs/shot.png?ref=release%2F1.0',
        'https://api.github.com/repos/acme/app/contents/shot.png?ref=release%2F1.0%2Fdocs',
      ],
      raw: true,
      authorized: true,
    });
  });

  test('keeps a pasted attachment on github.com', () => {
    expect(requestFor('https://github.com/user-attachments/assets/47f9b551-5ecf-4bb0-9122-0c1b8302e1b9')).toEqual({
      urls: ['https://github.com/user-attachments/assets/47f9b551-5ecf-4bb0-9122-0c1b8302e1b9'],
      raw: false,
      authorized: true,
    });
  });

  test('reads a raw link through the Contents API too', () => {
    expect(requestFor('https://raw.githubusercontent.com/acme/app/main/docs/shot.png')).toEqual({
      urls: [
        'https://api.github.com/repos/acme/app/contents/docs/shot.png?ref=main',
        'https://api.github.com/repos/acme/app/contents/shot.png?ref=main%2Fdocs',
      ],
      raw: true,
      authorized: true,
    });
  });

  test('reads an enterprise repository through its own API', () => {
    expect(requestFor('https://github.example.com/acme/app/blob/main/docs/shot.png?raw=true', 'github.example.com')).toEqual({
      urls: [
        'https://github.example.com/api/v3/repos/acme/app/contents/docs/shot.png?ref=main',
        'https://github.example.com/api/v3/repos/acme/app/contents/shot.png?ref=main%2Fdocs',
      ],
      raw: true,
      authorized: true,
    });
    expect(requestFor('https://github.example.com/user-attachments/assets/abc', 'github.example.com')).toEqual({
      urls: ['https://github.example.com/user-attachments/assets/abc'],
      raw: false,
      authorized: true,
    });
  });

  test('refuses hosts, schemes and paths outside the bound instance', () => {
    expect(() => requestFor('https://example.com/acme/app/blob/main/shot.png?raw=true')).toThrow();
    expect(() => requestFor('http://github.com/acme/app/blob/main/shot.png?raw=true')).toThrow();
    expect(() => requestFor('https://github.com/acme/app/blob/main/shot.png')).toThrow();
    expect(() => requestFor('https://github.com/acme/app/blob/main/shot.png?raw=true', 'github.example.com')).toThrow();
    expect(() => requestFor('https://github.example.com/acme/app/blob/main/shot.png?raw=true')).toThrow();
    expect(() => requestFor('https://private-user-images.githubusercontent.com/1/shot.png?jwt=abc')).toThrow();
    expect(() => decodeGitHubMediaSecret('not a secret!')).toThrow();
  });

  test('refuses a file of another repository than the preview has', () => {
    expect(() => requestFor('https://github.com/acme/private-b/blob/main/shot.png?raw=true')).toThrow('another repository');
    expect(() => requestFor('https://raw.githubusercontent.com/other/app/main/shot.png')).toThrow('another repository');
    expect(requestFor('https://github.com/ACME/App/raw/main/shot.png').raw).toBe(true);
  });
});

describe('sniffMediaType', () => {
  test('names raster images and video by their bytes and refuses the rest', () => {
    const bytes = (text) => new Uint8Array([...text].map((char) => char.charCodeAt(0)));
    expect(sniffMediaType(PNG)).toBe('image/png');
    expect(sniffMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMediaType(bytes('GIF89a......'))).toBe('image/gif');
    expect(sniffMediaType(bytes('RIFF....WEBP'))).toBe('image/webp');
    expect(sniffMediaType(bytes('....ftypavif'))).toBe('image/avif');
    expect(sniffMediaType(bytes('....ftypisom'))).toBe('video/mp4');
    expect(sniffMediaType(bytes('....ftypqt  '))).toBe('video/quicktime');
    expect(sniffMediaType(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe('video/webm');
    expect(sniffMediaType(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffMediaType(bytes('PRIVATE KEY'))).toBeNull();
  });
});

describe('readGitHubMedia', () => {
  test('retries a deeper ref after 404 and names the file to the uploads route', async () => {
    const seen = [];
    const response = await readGitHubMedia({
      secret: secretFor('https://github.com/acme/app/blob/release/1.0/docs/shot.png?raw=true'),
      instance: 'github.com',
      repository,
      token: 'secret-token',
      range: 'bytes=0-3',
      signal: new AbortController().signal,
      fetch: async (url, init) => {
        seen.push({ url, init });
        if (seen.length === 1) return new Response('missing', { status: 404 });
        return new Response(PNG, {
          headers: {
            'content-type': 'application/vnd.github.raw; charset=utf-8',
            'content-length': '3',
            etag: '"abc"',
          },
        });
      },
    });

    expect(seen.map(({ url }) => url)).toEqual([
      'https://api.github.com/repos/acme/app/contents/1.0/docs/shot.png?ref=release',
      'https://api.github.com/repos/acme/app/contents/docs/shot.png?ref=release%2F1.0',
    ]);
    expect(seen[1].init.headers).toMatchObject({
      accept: 'application/vnd.github.raw',
      authorization: 'Bearer secret-token',
      'user-agent': 'openchamber',
    });
    // The type comes from the bytes, so the file is read whole.
    expect(seen[1].init.headers.range).toBeUndefined();
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('etag')).toBe('"abc"');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  test('refuses a repository file that is not media whatever its name says', async () => {
    const response = await readGitHubMedia({
      secret: secretFor('https://github.com/acme/app/blob/main/shot.png?raw=true'),
      instance: 'github.com',
      repository,
      token: 'secret-token',
      signal: new AbortController().signal,
      fetch: async () => new Response('-----BEGIN PRIVATE KEY-----', { headers: { 'content-type': 'application/vnd.github.raw' } }),
    });

    expect(response.status).toBe(415);
    expect(await response.text()).toBe('');
  });

  test('follows one redirect without the token and refuses the next hop', async () => {
    const seen = [];
    const response = await readGitHubMedia({
      secret: secretFor('https://github.com/user-attachments/assets/abc'),
      instance: 'github.com',
      repository,
      token: 'secret-token',
      signal: new AbortController().signal,
      fetch: async (url, init) => {
        seen.push({ url, init });
        if (seen.length === 1) {
          return new Response('', {
            status: 302,
            headers: { location: 'https://github-production-user-asset-1.s3.amazonaws.com/shot.png' },
          });
        }
        return new Response('img', { headers: { 'content-type': 'image/png' } });
      },
    });

    expect(seen.map(({ url }) => url)).toEqual([
      'https://github.com/user-attachments/assets/abc',
      'https://github-production-user-asset-1.s3.amazonaws.com/shot.png',
    ]);
    expect(seen[0].init.redirect).toBe('manual');
    expect(seen[0].init.headers.authorization).toBe('Bearer secret-token');
    expect(seen[1].init.redirect).toBe('error');
    expect(seen[1].init.headers.authorization).toBeUndefined();
    expect(response.status).toBe(200);
  });

  test('refuses a redirect that leaves HTTPS', async () => {
    await expect(readGitHubMedia({
      secret: secretFor('https://github.com/user-attachments/assets/abc'),
      instance: 'github.com',
      repository,
      token: 'secret-token',
      signal: new AbortController().signal,
      fetch: async () => new Response('', { status: 302, headers: { location: 'http://example.com/shot.png' } }),
    })).rejects.toThrow('GitHub redirected the file to an address it may not be read from');
  });

  test('sends the token to a pasted attachment and keeps its media type', async () => {
    const seen = [];
    const response = await readGitHubMedia({
      secret: secretFor('https://github.com/user-attachments/assets/abc'),
      instance: 'github.com',
      repository,
      token: 'secret-token',
      signal: new AbortController().signal,
      fetch: async (url, init) => {
        seen.push({ url, init });
        return new Response('img', { headers: { 'content-type': 'image/png', 'content-length': '3' } });
      },
    });

    expect(seen[0].url).toBe('https://github.com/user-attachments/assets/abc');
    expect(seen[0].init.headers.authorization).toBe('Bearer secret-token');
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-length')).toBe('3');
  });
});

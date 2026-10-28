import { beforeEach, describe, expect, mock, test } from 'bun:test';

let requestCount = 0;
let requestPaths: string[] = [];
let requestOptions: Parameters<typeof runtimeFetch>[1][] = [];
let nextStat: (() => Promise<Response>) | undefined;
let fileSize: number;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
const runtimeFetch = mock(async (path: string, init?: RequestInit & { query?: Record<string, unknown> }): Promise<Response> => {
  requestPaths.push(path);
  requestOptions.push(init);
  if (path === '/api/fs/stat') {
    requestCount += 1;
    const pending = nextStat;
    nextStat = undefined;
    if (pending) return pending();
    return new Response(JSON.stringify({ isFile: true, path: init?.query?.path, size: fileSize }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (path === '/api/fs/raw') {
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  }
  throw new Error(`Unexpected route: ${path}`);
});
const resolver = {
  api: () => '',
  authenticatedAsset: (path: string, query: Record<string, string | undefined>) => {
    const params = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1])));
    return `${path}?${params}`;
  },
};
let currentResolver = resolver;

mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch }));
mock.module('@/lib/runtime-url', () => ({ getRuntimeUrlResolver: () => currentResolver, configureRuntimeUrlResolver: () => {} }));

class TestFileReader {
  result: string | ArrayBuffer | null = null;
  error: DOMException | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then((buffer) => {
      this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
      this.onload?.();
    }).catch((error) => {
      this.error = error as DOMException;
      this.onerror?.();
    });
  }
}

globalThis.FileReader = TestFileReader as unknown as typeof FileReader;

const {
  getPreparedMarkdownImageUrl,
  loadMessageImageBlob,
  prepareLocalMarkdownImages,
  resolveWorkspaceMarkdownImageSource,
} = await import('./markdownImageAssets');

beforeEach(() => {
  requestCount = 0;
  requestPaths = [];
  nextStat = undefined;
  fileSize = PNG.byteLength;
  requestOptions = [];
  currentResolver = resolver;
});

describe('Markdown image asset preparation', () => {
  test('loads the original generated image bytes from an outside path containing spaces and unicode', async () => {
    const source = '/tmp/my images/маяк.png';
    const blob = await loadMessageImageBlob({ source, directory: '/repo', sessionId: 'generated', messageId: 'full-size', signal: new AbortController().signal });
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(PNG);
    expect(requestOptions.map((init) => init?.query?.path)).toEqual([source, source]);
    expect(requestOptions.at(-1)?.query?.allowOutsideWorkspace).toBe('true');
  });

  test('does not fetch generated image bytes after switching runtimes during metadata lookup', async () => {
    nextStat = async () => {
      currentResolver = { ...resolver };
      return Response.json({ isFile: true, path: '/tmp/image.png', size: PNG.byteLength });
    };
    await expect(loadMessageImageBlob({ source: '/tmp/image.png', directory: '/repo', sessionId: 'generated', messageId: 'switch', signal: new AbortController().signal })).rejects.toThrow('Runtime changed');
    expect(requestPaths).toEqual(['/api/fs/stat']);
  });
  test('prepares many images through existing file metadata requests', async () => {
    requestCount = 0;
    const sources = Array.from({ length: 12 }, (_, index) => `${index}.png`);

    const result = await prepareLocalMarkdownImages({
      sources,
      directory: '/repo',
      sessionId: 'ses_batch',
      messageId: 'msg_batch',
      signal: new AbortController().signal,
    });

    expect(result.size).toBe(12);
    expect(requestCount).toBe(12);
    expect([...result.values()].every((image) => image.status === 'ready')).toBe(true);
    expect(requestPaths).toEqual(sources.map(() => '/api/fs/stat'));
  });

  test('reuses preparation for one thousand messages after virtualized remounts', async () => {
    requestCount = 0;
    const requests = Array.from({ length: 1000 }, (_, index) => ({
      sources: [`${index}.png`],
      directory: '/repo',
      sessionId: 'ses_long',
      messageId: `msg_${index}`,
      signal: new AbortController().signal,
    }));

    for (const request of requests) await prepareLocalMarkdownImages(request);
    for (const request of requests) await prepareLocalMarkdownImages(request);

    expect(requestCount).toBe(1000);
  });

  test('reuses the existing authenticated raw-file asset URL', () => {
    const url = getPreparedMarkdownImageUrl({
      status: 'ready',
      path: '/tmp/opencode/image.png',
      outsideWorkspace: true,
    }, '/repo');

    expect(url).toContain('/api/fs/raw?');
    expect(url).toContain('path=%2Ftmp%2Fopencode%2Fimage.png');
    expect(url).toContain('allowOutsideWorkspace=true');
  });

  for (const [source, directory] of [
    ['screens/image.png', '/repo'],
    ['file://server/share/repo/image.png', '//server/share/repo'],
  ]) test(`loads a workspace image through the local filesystem bridge: ${source}`, async () => {
    requestPaths = [];

    const url = await resolveWorkspaceMarkdownImageSource(
      source,
      directory,
      new AbortController().signal,
    );

    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    expect(requestPaths).toEqual(['/api/fs/stat', '/api/fs/raw']);
  });

  test('resolves encoded paths and accepts the file route canonical target outside the workspace', async () => {
    const request = { directory: '/repo', sessionId: 'ses_paths', messageId: 'msg_paths', signal: new AbortController().signal };
    await prepareLocalMarkdownImages({ ...request, sources: ['screen%20shot.png?version=1', 'file:///tmp/output%23one.png'] });
    expect(requestOptions.map((init) => init?.query?.path)).toEqual(['/repo/screen shot.png', '/tmp/output#one.png']);
    nextStat = async () => Response.json({ isFile: true, path: '/tmp/output.png', size: PNG.byteLength });
    const source = '/repo/../tmp/output.png';
    const image = (await prepareLocalMarkdownImages({ ...request, sources: [source] })).get(source);
    expect(requestOptions.at(-1)?.query?.allowOutsideWorkspace).toBe('true');
    expect(image).toEqual({ status: 'ready', path: '/tmp/output.png', outsideWorkspace: true });
  });

  test('deduplicates files and keeps missing or invalid metadata separate from successful reads', async () => {
    const sources = ['missing.png', 'invalid.png', 'failed.png', 'good.png', 'good.png'];
    const responses = [Response.json({ exists: false }), Response.json({ isFile: true, path: '/repo/invalid.png', size: -1 }), new Response(null, { status: 503 })];
    nextStat = async function inspect() {
      const response = responses.shift();
      if (responses.length) nextStat = inspect;
      return response!;
    };
    const result = await prepareLocalMarkdownImages({ sources, directory: '/repo', sessionId: 'ses_partial', messageId: 'msg_partial', signal: new AbortController().signal });
    expect([...result.values()].map((image) => image.status)).toEqual(['missing', 'error', 'error', 'ready']);
    expect(requestCount).toBe(4);
  });

  test('retains image and video size limits without reading whole files', async () => {
    const request = { directory: '/repo', sessionId: 'ses_size', messageId: 'msg_size', signal: new AbortController().signal, refresh: true };
    fileSize = 11 * 1024 * 1024;
    const result = await prepareLocalMarkdownImages({ ...request, sources: ['large.png', 'clip.mp4'] });
    expect(result.get('large.png')?.status).toBe('error');
    expect(result.get('clip.mp4')?.status).toBe('ready');
    fileSize = 1024 * 1024 * 1024 + 1;
    expect((await prepareLocalMarkdownImages({ ...request, sources: ['clip.mp4'] })).get('clip.mp4')?.status).toBe('error');
    await expect(resolveWorkspaceMarkdownImageSource('/outside/image.png', '/repo', request.signal)).rejects.toThrow();
    await expect(resolveWorkspaceMarkdownImageSource('large.png', '/repo', request.signal)).rejects.toThrow();
    expect(requestPaths.every((path) => path === '/api/fs/stat')).toBe(true);
  });

  test('new messages inspect reused paths while remounts reuse their own result and refresh replaces it', async () => {
    const request = { sources: ['/tmp/latest.png'], directory: '/repo', sessionId: 'ses_refresh', messageId: 'msg_first', signal: new AbortController().signal };
    nextStat = async () => Response.json({ isFile: true, path: '/tmp/first.png', size: PNG.byteLength });
    await prepareLocalMarkdownImages(request);
    nextStat = async () => Response.json({ isFile: true, path: '/tmp/second.png', size: PNG.byteLength });
    expect((await prepareLocalMarkdownImages({ ...request, messageId: 'msg_second' })).get('/tmp/latest.png')).toMatchObject({ path: '/tmp/second.png' });
    expect((await prepareLocalMarkdownImages(request)).get('/tmp/latest.png')).toMatchObject({ path: '/tmp/first.png' });
    await expect(prepareLocalMarkdownImages({ ...request, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(requestCount).toBe(2);
    expect((await prepareLocalMarkdownImages({ ...request, refresh: true })).get('/tmp/latest.png')).toMatchObject({ path: '/tmp/latest.png' });
    expect(requestCount).toBe(3);
  });

  for (const abort of [false, true]) test(`a late lookup cannot replace refreshed metadata, aborted=${abort}`, async () => {
    let complete = (_response: Response) => {};
    nextStat = () => new Promise<Response>((resolve) => { complete = resolve; });
    const controller = new AbortController();
    const request = { sources: ['image.png'], directory: '/repo', sessionId: 'ses_overlap', messageId: `msg_${abort}`, signal: controller.signal };
    const older = prepareLocalMarkdownImages(request).then(() => null, (error: Error) => error);
    if (abort) controller.abort();
    await prepareLocalMarkdownImages({ ...request, signal: new AbortController().signal, refresh: true });
    complete(Response.json({ exists: false }));
    const error = await older;
    if (abort) expect(error?.name).toBe('AbortError');
    expect((await prepareLocalMarkdownImages({ ...request, signal: new AbortController().signal })).get('image.png')?.status).toBe('ready');
  });
});

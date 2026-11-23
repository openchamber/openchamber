const GITHUB_COM = 'github.com';
const RAW_GITHUB_COM = 'raw.githubusercontent.com';
const MEDIA_SECRET_RE = /^[A-Za-z0-9_-]{16,8192}$/;
const MAX_TARGET_LENGTH = 8192;
const MEDIA_TIMEOUT_MS = 20_000;
const MAX_CONTENTS_ATTEMPTS = 8;

interface RepositoryPath { owner: string; repo: string; rest: string; raw: boolean }
interface MediaRequest { urls: string[]; raw: boolean; authorized: boolean }
interface MediaHeaders { token?: string | undefined; authorized: boolean; range?: string | undefined; raw: boolean }
type MediaRequestHeaders = {
  accept: string;
  'user-agent': string;
  authorization?: string;
  range?: string;
};
interface MediaRead {
  secret: string;
  instance: string;
  repository: { owner: string; repo: string };
  token?: string | undefined;
  range?: string | undefined;
  signal: AbortSignal;
  fetch?: typeof fetch;
}

const invalidTarget = (message = 'GitHub attachment target is invalid') => Object.assign(new Error(message), { status: 400 });

const hostOf = (instance: string) => instance.trim().toLowerCase() || GITHUB_COM;

const decodePathSegment = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

export function decodeGitHubMediaSecret(secret: string) {
  if (!MEDIA_SECRET_RE.test(secret)) throw invalidTarget();
  let target;
  try {
    target = Buffer.from(secret, 'base64url').toString('utf8');
  } catch {
    throw invalidTarget();
  }
  if (!target || target.length > MAX_TARGET_LENGTH) throw invalidTarget();
  let url;
  try {
    url = new URL(target);
  } catch {
    throw invalidTarget();
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw invalidTarget();
  return url;
}

const attachmentPath = (pathname: string) => /^\/user-attachments\/assets\/[\w-]+\/?$/.test(pathname);

const repositoryPath = (pathname: string): RepositoryPath | null => {
  const [, owner, repo, rest] = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(pathname) ?? [];
  return owner && repo && rest ? { owner, repo, rest, raw: pathname.split('/')[3] === 'raw' } : null;
};

const rawRepositoryPath = (pathname: string): RepositoryPath | null => {
  const [, owner, repo, rest] = /^\/([^/]+)\/([^/]+)\/(.+)$/.exec(pathname) ?? [];
  return owner && repo && rest ? { owner, repo, rest, raw: true } : null;
};

const contentsUrls = (apiBase: string, { owner, repo, rest }: RepositoryPath) => {
  const segments = rest.split('/').filter(Boolean).map(decodePathSegment);
  const urls = [];
  for (let index = 1; index < Math.min(segments.length, MAX_CONTENTS_ATTEMPTS + 1); index += 1) {
    const ref = segments.slice(0, index).join('/');
    const path = segments.slice(index).map(encodeURIComponent).join('/');
    urls.push(`${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  }
  return urls;
};

function githubMediaRequest(url: URL): MediaRequest | null {
  if (url.hostname === RAW_GITHUB_COM) {
    const raw = rawRepositoryPath(url.pathname);
    if (!raw) return null;
    return { urls: contentsUrls('https://api.github.com', raw), raw: true, authorized: true };
  }
  if (url.hostname !== GITHUB_COM) return null;
  if (attachmentPath(url.pathname)) return { urls: [url.toString()], raw: false, authorized: true };
  const repository = repositoryPath(url.pathname);
  if (!repository || (!repository.raw && url.searchParams.get('raw') !== 'true')) return null;
  return { urls: contentsUrls('https://api.github.com', repository), raw: true, authorized: true };
}

function enterpriseMediaRequest(url: URL, instance: string): MediaRequest | null {
  if (url.hostname !== instance) return null;
  if (attachmentPath(url.pathname)) return { urls: [url.toString()], raw: false, authorized: true };
  const repository = repositoryPath(url.pathname);
  if (!repository || (!repository.raw && url.searchParams.get('raw') !== 'true')) return null;
  return { urls: contentsUrls(`https://${instance}/api/v3`, repository), raw: true, authorized: true };
}

const sameName = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

export function gitHubMediaRequest(secret: string, instance: string, repository: MediaRead['repository']) {
  const url = decodeGitHubMediaSecret(secret);
  const host = hostOf(instance);
  const request = host === GITHUB_COM ? githubMediaRequest(url) : enterpriseMediaRequest(url, host);
  if (!request || request.urls.length === 0) throw invalidTarget('GitHub attachment host is not supported');
  const file = url.hostname === RAW_GITHUB_COM ? rawRepositoryPath(url.pathname) : request.raw ? repositoryPath(url.pathname) : null;
  if (file && !(sameName(file.owner, repository.owner) && sameName(file.repo, repository.repo))) {
    throw invalidTarget('GitHub attachment belongs to another repository');
  }
  return request;
}

const mediaHeaders = ({ token, authorized, range, raw }: MediaHeaders) => {
  const headers: MediaRequestHeaders = {
    accept: raw ? 'application/vnd.github.raw' : '*/*',
    'user-agent': 'openchamber',
  };
  if (authorized && token) headers.authorization = `Bearer ${token}`;
  if (range) headers.range = range;
  return headers;
};

const followOneRedirect = async ({ fetchImpl, url, headers, signal, raw, range }: {
  fetchImpl: typeof fetch;
  url: string;
  headers: MediaRequestHeaders;
  signal: AbortSignal;
  raw: boolean;
  range?: string | undefined;
}) => {
  const response = await fetchImpl(url, { headers, redirect: 'manual', signal });
  if (response.status < 300 || response.status >= 400) return response;
  await response.body?.cancel().catch(() => undefined);
  const location = response.headers.get('location');
  let next;
  try {
    next = location ? new URL(location, url) : null;
  } catch {
    next = null;
  }
  if (!next || next.protocol !== 'https:') throw invalidTarget('GitHub redirected the file to an address it may not be read from');
  return fetchImpl(next.toString(), {
    headers: mediaHeaders({ token: '', authorized: false, range, raw }),
    redirect: 'error',
    signal,
  });
};

const GENERIC_TYPE_RE = /^(?:application\/(?:octet-stream|vnd\.github\.raw)|binary\/octet-stream)?$/;
const SNIFF_BYTES = 12;

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));

export function sniffMediaType(bytes: Uint8Array) {
  if (bytes.length >= 8 && ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'qt  ') return 'video/quicktime';
    if (/^(?:isom|iso[2-9]|mp4[12v]|M4V |avc1|dash)$/.test(brand)) return 'video/mp4';
  }
  return null;
}

const unsupportedMedia = (response: Response) => {
  void response.body?.cancel().catch(() => undefined);
  return new Response(null, { status: 415 });
};

const typedMediaResponse = async (response: Response) => {
  const [type = ''] = (response.headers.get('content-type') ?? '').split(';');
  if (!GENERIC_TYPE_RE.test(type.trim().toLowerCase())) return response;
  if (!response.body || response.status !== 200) return unsupportedMedia(response);
  const reader = response.body.getReader();
  const head: Uint8Array[] = [];
  let length = 0;
  while (length < SNIFF_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    head.push(value);
    length += value.length;
  }
  const prefix = new Uint8Array(length);
  let offset = 0;
  for (const chunk of head) {
    prefix.set(chunk, offset);
    offset += chunk.length;
  }
  const mediaType = sniffMediaType(prefix);
  if (!mediaType) {
    await reader.cancel().catch(() => undefined);
    return new Response(null, { status: 415 });
  }
  const headers = new Headers(response.headers);
  headers.set('content-type', mediaType);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.delete('content-range');
  headers.delete('accept-ranges');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix.length > 0) controller.enqueue(prefix);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, { status: 200, statusText: response.statusText, headers });
};

export async function readGitHubMedia({ secret, instance, repository, token, range: requestedRange, signal, fetch: fetchImpl = fetch }: MediaRead) {
  const request = gitHubMediaRequest(secret, instance, repository);
  const range = request.raw ? undefined : requestedRange;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), MEDIA_TIMEOUT_MS);
  const fetchSignal = AbortSignal.any([signal, timeout.signal]);
  try {
    for (const [index, url] of request.urls.entries()) {
      const response = await followOneRedirect({
        fetchImpl,
        url,
        headers: mediaHeaders({ token, authorized: request.authorized, range, raw: request.raw }),
        signal: fetchSignal,
        raw: request.raw,
        range,
      });
      if (response.status === 404 && index < request.urls.length - 1) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      return response.ok ? await typedMediaResponse(response) : response;
    }
  } finally {
    clearTimeout(timer);
  }
  throw invalidTarget('GitHub attachment target is invalid');
}

export interface DevServerPage {
  title: string | null;
  icon: string | null;
}

export type DevServerPageProbe = DevServerPage | null;

export interface DevServerPageTarget {
  port: number;
  pid: number | null;
}

export interface DevServerPageProber {
  describe: (targets: DevServerPageTarget[]) => Promise<Map<number, DevServerPageProbe>>;
}

export interface DevServerPageProberOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  firstAnswersDeadline?: () => Promise<void>;
  timeoutMs?: number;
  ttlMs?: number;
  concurrency?: number;
}

const MAX_HTML_BYTES = 256 * 1024;
const MAX_ICON_BYTES = 32 * 1024;
const MAX_ICO_SOURCE_BYTES = 1024 * 1024;
const ICON_FRAME_SIZE = 32;
const ICO_TYPES = new Set(['image/x-icon', 'image/vnd.microsoft.icon']);
const MAX_TITLE_LENGTH = 120;
const MAX_REDIRECTS = 3;
const ICON_TIMEOUT_MS = 2_000;
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const ICON_TYPES = new Set([
  'image/png',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/svg+xml',
  'image/gif',
  'image/jpeg',
  'image/webp',
]);

const mimeOf = (response: Response) => (response.headers.get('content-type') || '').split(';')[0]?.trim().toLowerCase() ?? '';

const readLimited = async (response: Response, limit: number): Promise<Uint8Array | null> => {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const readHtmlHead = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let html = '';
  let size = 0;
  for (;;) {
    const chunk = await reader.read().catch(() => null);
    if (!chunk || chunk.done) break;
    const { value } = chunk;
    size += value.byteLength;
    html += decoder.decode(value, { stream: true });
    if (size >= MAX_HTML_BYTES || /<\/head\s*>/i.test(html)) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return html;
};

const ENTITIES = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' ']]);

const decodeEntities = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
  if (entity[0] === '#') {
    const code = entity[1] === 'x' || entity[1] === 'X'
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  }
  return ENTITIES.get(entity.toLowerCase()) ?? match;
});

const markupOf = (html: string) => html
  .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
  .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');

export const extractPageTitle = (html: string): string | null => {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(markupOf(html));
  if (!match) return null;
  const title = decodeEntities(match[1] ?? '').replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, MAX_TITLE_LENGTH) : null;
};

const attributeOf = (tag: string, name: string): string | null => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  if (!match) return null;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim();
};

export const extractIconHref = (html: string): string | null => {
  for (const [tag] of markupOf(html).matchAll(/<link\b[^>]*>/gi)) {
    const rel = attributeOf(tag, 'rel');
    if (!rel || !rel.toLowerCase().split(/\s+/).includes('icon')) continue;
    const href = attributeOf(tag, 'href');
    if (href) return href;
  }
  return null;
};

const toDataUrl = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

const INLINE_ICON = /^data:(image\/[a-z0-9.+-]+)(;base64)?,/i;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ICO_WRAPPER_BYTES = 22;

const isPng = (bytes: Uint8Array) => PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);

const icoFrame = (ico: Uint8Array): { mime: string; bytes: Uint8Array } | null => {
  if (isPng(ico)) return { mime: 'image/png', bytes: ico };
  if (ico.byteLength < 6) return null;
  const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) return null;
  const count = view.getUint16(4, true);
  const directoryEnd = 6 + count * 16;
  if (directoryEnd > ico.byteLength) return null;

  let best: { width: number; entry: number; image: Uint8Array } | null = null;
  for (let entry = 6; entry < directoryEnd; entry += 16) {
    const width = view.getUint8(entry) || 256;
    const size = view.getUint32(entry + 8, true);
    const offset = view.getUint32(entry + 12, true);
    if (size === 0 || offset < directoryEnd || offset + size > ico.byteLength) continue;
    const image = ico.subarray(offset, offset + size);
    if (size + (isPng(image) ? 0 : ICO_WRAPPER_BYTES) > MAX_ICON_BYTES) continue;
    const distance = Math.abs(width - ICON_FRAME_SIZE);
    const bestDistance = best ? Math.abs(best.width - ICON_FRAME_SIZE) : Infinity;
    if (distance < bestDistance || (distance === bestDistance && best && width > best.width)) best = { width, entry, image };
  }
  if (!best) return null;
  if (isPng(best.image)) return { mime: 'image/png', bytes: best.image };

  const single = new Uint8Array(ICO_WRAPPER_BYTES + best.image.byteLength);
  const header = new DataView(single.buffer);
  header.setUint16(2, 1, true);
  header.setUint16(4, 1, true);
  single.set(ico.subarray(best.entry, best.entry + 8), 6);
  header.setUint32(14, best.image.byteLength, true);
  header.setUint32(18, ICO_WRAPPER_BYTES, true);
  single.set(best.image, ICO_WRAPPER_BYTES);
  return { mime: 'image/x-icon', bytes: single };
};

const readIcon = async (fetchImpl: typeof globalThis.fetch, target: URL, pageUrl: URL): Promise<string | null> => {
  if (target.protocol === 'data:') {
    const inline = INLINE_ICON.exec(target.href);
    const mime = inline?.[1]?.toLowerCase();
    if (!mime || !ICON_TYPES.has(mime) || target.href.length > MAX_ICON_BYTES * 2) return null;
    return target.href;
  }
  if (target.origin !== pageUrl.origin) return null;

  try {
    const response = await fetchImpl(target.href, { redirect: 'manual', signal: AbortSignal.timeout(ICON_TIMEOUT_MS) });
    const mime = mimeOf(response);
    if (!response.ok || !ICON_TYPES.has(mime)) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const isIco = ICO_TYPES.has(mime);
    const bytes = await readLimited(response, isIco ? MAX_ICO_SOURCE_BYTES : MAX_ICON_BYTES);
    if (!bytes || bytes.byteLength === 0) return null;
    const icon = isIco ? icoFrame(bytes) : { mime, bytes };
    return icon && icon.bytes.byteLength <= MAX_ICON_BYTES ? toDataUrl(icon.mime, icon.bytes) : null;
  } catch {
    return null;
  }
};

const fetchIcon = async (fetchImpl: typeof globalThis.fetch, href: string | null, pageUrl: URL): Promise<string | null> => {
  const targets = [href, '/favicon.ico'].flatMap((candidate) => {
    if (candidate === null) return [];
    try {
      return [new URL(candidate, pageUrl)];
    } catch {
      return [];
    }
  });
  const tried = new Set<string>();
  for (const target of targets) {
    if (tried.has(target.href)) continue;
    tried.add(target.href);
    const icon = await readIcon(fetchImpl, target, pageUrl);
    if (icon) return icon;
  }
  return null;
};

export const probeDevServerPage = async (
  fetchImpl: typeof globalThis.fetch,
  port: number,
  timeoutMs: number,
): Promise<DevServerPageProbe> => {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = new URL(`http://localhost:${port}/`);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await fetchImpl(url.href, {
        redirect: 'manual',
        signal,
        headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
      });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => {});
        const next = new URL(location, url);
        if (next.origin !== url.origin) return { title: null, icon: null };
        url = next;
        continue;
      }

      const isPage = (response.ok || response.status >= 500) && HTML_TYPES.has(mimeOf(response));
      if (!isPage) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      const html = await readHtmlHead(response);
      return {
        title: extractPageTitle(html),
        icon: await fetchIcon(fetchImpl, extractIconHref(html), url),
      };
    }
    return null;
  } catch {
    return null;
  }
};

const limiter = (concurrency: number) => {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < concurrency) active += 1;
    else await new Promise<void>((resolve) => { waiting.push(resolve); });
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
};

export const createDevServerPageProber = ({
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  firstAnswersDeadline = () => new Promise((resolve) => { setTimeout(resolve, 800); }),
  timeoutMs = 10_000,
  ttlMs = 20_000,
  concurrency = 6,
}: DevServerPageProberOptions = {}): DevServerPageProber => {
  const answers = new Map<string, { at: number; value: DevServerPageProbe }>();
  let listedKeys = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  const limit = limiter(concurrency);
  const keyOf = ({ port, pid }: DevServerPageTarget) => `${port}:${pid ?? ''}`;

  const refresh = (target: DevServerPageTarget, key: string) => {
    const running = inFlight.get(key);
    if (running) return running;
    const task = limit(() => probeDevServerPage(fetchImpl, target.port, timeoutMs)).then((value) => {
      if (listedKeys.has(key)) answers.set(key, { at: now(), value });
    }).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, task);
    return task;
  };

  return {
    async describe(targets) {
      listedKeys = new Set(targets.map(keyOf));
      for (const key of answers.keys()) {
        if (!listedKeys.has(key)) answers.delete(key);
      }

      const pending = targets.flatMap((target) => {
        const key = keyOf(target);
        const known = answers.get(key);
        return known && now() - known.at < ttlMs ? [] : [refresh(target, key)];
      });
      if (pending.length > 0) await Promise.race([Promise.all(pending), firstAnswersDeadline()]);

      const pages = new Map<number, DevServerPageProbe>();
      for (const target of targets) {
        const known = answers.get(keyOf(target));
        if (known) pages.set(target.port, known.value);
      }
      return pages;
    },
  };
};

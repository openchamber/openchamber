const MAX_FILES = 500;
const MAX_BYTES = 40 * 1024 * 1024;
const MAX_DOCUMENT_CHARS = 64 * 1024 * 1024;

export type LoadInlineAsset = (path: string) => Promise<Response>;

type InlineHtmlDocumentOptions = {
  origin: string;
  prefix: string;
  entry: string;
  load: LoadInlineAsset;
  csp?: string;
  headScript?: string;
  strictSubresources: boolean;
  signal?: AbortSignal;
};

export const toDataUrl = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
};

const decodeCssUrl = (value: string): string => value.replace(/\\(?:([0-9a-f]{1,6})\s?|([\s\S]))/gi, (_match, hex: string | undefined, escaped: string | undefined) => {
  if (hex) {
    const point = Number.parseInt(hex, 16);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '\uFFFD';
  }
  return escaped === '\n' || escaped === '\r' ? '' : escaped ?? '';
});

const CSS_REFERENCES = /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\burl\(\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|((?:\\[\s\S]|[^)\\])*?))\s*\)|@import\s+(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)')/gi;

const resolveUrl = (value: string, base: URL, strict: boolean): URL | null => {
  try {
    return new URL(value, base);
  } catch (error) {
    if (strict) throw error;
    return null;
  }
};

export const inlineRelayHtmlDocument = async ({
  origin,
  prefix,
  entry,
  load,
  csp,
  headScript,
  strictSubresources,
  signal,
}: InlineHtmlDocumentOptions): Promise<string> => {
  const root = new URL(entry, `${origin}${prefix}`);
  const files = new Map<string, Promise<string>>();
  let totalBytes = 0;
  let embeddedChars = 0;

  const read = async (url: URL): Promise<Blob> => {
    signal?.throwIfAborted();
    if (url.origin !== origin || !url.pathname.startsWith(prefix)) {
      throw new Error('Resource is outside its allowed root');
    }
    const response = await load(`${url.pathname}${url.search}`);
    signal?.throwIfAborted();
    if (!response.ok) throw new Error(`Could not load resource (HTTP ${response.status})`);
    const contentType = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
    const reader = response.body?.getReader();
    if (!reader) return new Blob([], { type: contentType });
    const chunks: BlobPart[] = [];
    const onAbort = () => { void reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        signal?.throwIfAborted();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_BYTES) throw new Error('Document exceeds the resource size limit');
        chunks.push(new Uint8Array(value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
    signal?.throwIfAborted();
    return new Blob(chunks, { type: contentType });
  };

  const resource = async (reference: string, base: URL, ancestors: string[]): Promise<string> => {
    const value = reference.trim();
    if (!value || value.startsWith('#')) return reference;
    const url = resolveUrl(value, base, strictSubresources);
    if (!url) return reference;
    if (url.origin !== origin) return url.href;
    const hash = url.hash;
    url.hash = '';
    const key = url.href;
    const fallbackUrl = `${key}${hash}`;
    if (!url.pathname.startsWith(prefix)) {
      if (strictSubresources) throw new Error('Resource is outside its allowed root');
      return fallbackUrl;
    }
    if (ancestors.includes(key)) {
      if (strictSubresources) throw new Error('Circular resource reference');
      return fallbackUrl;
    }
    let pending = files.get(key);
    if (!pending) {
      if (files.size >= MAX_FILES) {
        if (strictSubresources) throw new Error('Document has too many resources');
        return fallbackUrl;
      }
      const chain = [...ancestors, key];
      pending = read(url).then(async (blob) => {
        const mime = blob.type.split(';')[0];
        if (mime === 'text/css' || url.pathname.endsWith('.css')) {
          return toDataUrl(new Blob([await rewriteCss(await blob.text(), url, chain)], { type: 'text/css' }));
        }
        if (mime === 'text/html') {
          return toDataUrl(new Blob([await rewriteHtml(await blob.text(), url, chain)], { type: 'text/html' }));
        }
        return toDataUrl(blob);
      });
      files.set(key, pending);
    }
    let resolved: string;
    try {
      resolved = await pending;
    } catch (error) {
      if (strictSubresources || signal?.aborted) throw error;
      return fallbackUrl;
    }
    const result = `${resolved}${hash}`;
    if (embeddedChars + result.length > MAX_DOCUMENT_CHARS) {
      if (strictSubresources) throw new Error('Document exceeds the embedded size limit');
      return fallbackUrl;
    }
    embeddedChars += result.length;
    return result;
  };

  const rewriteCss = async (css: string, base: URL, ancestors: string[]): Promise<string> => {
    let result = '';
    let offset = 0;
    for (const match of css.matchAll(CSS_REFERENCES)) {
      const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
      if (value === undefined) continue;
      result += css.slice(offset, match.index);
      const url = await resource(decodeCssUrl(value.trim()), base, ancestors);
      const quoted = JSON.stringify(url);
      result += match[4] !== undefined || match[5] !== undefined ? `@import url(${quoted})` : `url(${quoted})`;
      offset = match.index + match[0].length;
    }
    return result + css.slice(offset);
  };

  const rewriteSrcset = async (srcset: string, base: URL, ancestors: string[]): Promise<string> => {
    const candidates: string[] = [];
    let rest = srcset;
    while (rest.trim()) {
      rest = rest.replace(/^[\s,]+/, '');
      const match = /^\S+/.exec(rest);
      if (!match) break;
      const raw = match[0];
      rest = rest.slice(raw.length);
      let descriptor = '';
      if (!raw.endsWith(',')) {
        const comma = rest.indexOf(',');
        descriptor = (comma < 0 ? rest : rest.slice(0, comma)).trim();
        rest = comma < 0 ? '' : rest.slice(comma + 1);
      }
      const url = await resource(raw.replace(/,+$/, ''), base, ancestors);
      candidates.push(descriptor ? `${url} ${descriptor}` : url);
    }
    return candidates.join(', ');
  };

  const rewriteHtml = async (html: string, base: URL, ancestors: string[]): Promise<string> => {
    const document = new DOMParser().parseFromString(html, 'text/html');
    const declaredBase = document.querySelector('base[href]')?.getAttribute('href');
    const declaredTarget = document.querySelector('base[target]')?.getAttribute('target');
    const effectiveBase = (declaredBase ? resolveUrl(declaredBase, base, strictSubresources) : null) ?? base;
    for (const node of document.querySelectorAll('base')) node.remove();
    if (headScript) {
      const script = document.createElement('script');
      script.setAttribute('data-openchamber-inline-nav', '');
      script.textContent = headScript;
      document.head.prepend(script);
    }
    const baseElement = document.createElement('base');
    baseElement.href = effectiveBase.href;
    if (declaredTarget) baseElement.target = declaredTarget;
    document.head.prepend(baseElement);
    if (csp) {
      const policy = document.createElement('meta');
      policy.httpEquiv = 'Content-Security-Policy';
      policy.content = csp;
      document.head.prepend(policy);
    }
    for (const node of document.querySelectorAll('script[src], link[href], img[src], source[src], video[src], audio[src], iframe[src], embed[src], object[data], image[href], image[xlink\\:href], use[href], use[xlink\\:href]')) {
      for (const attribute of ['src', 'href', 'data', 'xlink:href']) {
        const value = node.getAttribute(attribute);
        if (value !== null) node.setAttribute(attribute, await resource(value, effectiveBase, ancestors));
      }
    }
    for (const node of document.querySelectorAll('[poster]')) {
      node.setAttribute('poster', await resource(node.getAttribute('poster') ?? '', effectiveBase, ancestors));
    }
    for (const node of document.querySelectorAll('img[srcset], source[srcset]')) {
      node.setAttribute('srcset', await rewriteSrcset(node.getAttribute('srcset') ?? '', effectiveBase, ancestors));
    }
    for (const node of document.querySelectorAll('style')) {
      node.textContent = await rewriteCss(node.textContent ?? '', effectiveBase, ancestors);
    }
    for (const node of document.querySelectorAll('[style]')) {
      node.setAttribute('style', await rewriteCss(node.getAttribute('style') ?? '', effectiveBase, ancestors));
    }
    signal?.throwIfAborted();
    const result = `<!doctype html>\n${document.documentElement.outerHTML}`;
    if (result.length > MAX_DOCUMENT_CHARS) throw new Error('Document exceeds the size limit');
    return result;
  };

  const html = await read(root);
  if (html.type.split(';')[0] !== 'text/html') throw new Error('Document entry is not HTML');
  return rewriteHtml(await html.text(), root, [root.href]);
};

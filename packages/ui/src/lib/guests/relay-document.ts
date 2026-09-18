const DOCUMENT_ORIGIN = 'https://extension.invalid';
const MAX_FILES = 500;
const MAX_BYTES = 40 * 1024 * 1024;
const MAX_DOCUMENT_CHARS = 64 * 1024 * 1024;

type LoadAsset = (path: string) => Promise<Response>;

const toDataUrl = async (blob: Blob): Promise<string> => {
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

// Comments and standalone strings are consumed too, so URL-like text inside
// them is never fetched. Both @import "file" and @import url(file) are covered.
const CSS_REFERENCES = /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\burl\(\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|((?:\\[\s\S]|[^)\\])*?))\s*\)|@import\s+(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)')/gi;

/** Prepare package-owned static resources for an iframe that has no HTTP origin. */
export const loadRelayGuestDocument = async (guestId: string, entry: string, load: LoadAsset): Promise<string> => {
  const prefix = `/api/guests/${guestId}/`;
  const root = new URL(entry, `${DOCUMENT_ORIGIN}${prefix}`);
  const files = new Map<string, Promise<string>>();
  let totalBytes = 0;
  let embeddedChars = 0;

  const read = async (url: URL): Promise<Blob> => {
    if (url.origin !== DOCUMENT_ORIGIN || !url.pathname.startsWith(prefix)) {
      throw new Error('Extension resource is outside its package');
    }
    const response = await load(`${url.pathname}${url.search}`);
    if (!response.ok) throw new Error(`Could not load extension resource (HTTP ${response.status})`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Extension resource has no response body');
    const chunks: BlobPart[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_BYTES) throw new Error('Extension document exceeds the resource size limit');
        chunks.push(new Uint8Array(value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    return new Blob(chunks, { type: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream' });
  };

  const resource = async (reference: string, base: URL, ancestors: string[]): Promise<string> => {
    const value = reference.trim();
    if (!value || value.startsWith('#')) return reference;
    const url = new URL(value, base);
    if (url.origin !== DOCUMENT_ORIGIN) return url.href;
    const hash = url.hash;
    url.hash = '';
    const key = url.href;
    if (ancestors.includes(key)) throw new Error('Circular extension resource reference');
    let pending = files.get(key);
    if (!pending) {
      if (files.size >= MAX_FILES) throw new Error('Extension document has too many resources');
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
    const result = `${await pending}${hash}`;
    embeddedChars += result.length;
    if (embeddedChars > MAX_DOCUMENT_CHARS) throw new Error('Extension document exceeds the embedded size limit');
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
    const effectiveBase = declaredBase ? new URL(declaredBase, base) : base;
    for (const node of document.querySelectorAll('base')) node.remove();
    // Unresolved relative navigations must not accidentally load the host UI.
    const baseElement = document.createElement('base');
    baseElement.href = effectiveBase.href;
    if (declaredTarget) baseElement.target = declaredTarget;
    document.head.prepend(baseElement);
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
    const result = `<!doctype html>\n${document.documentElement.outerHTML}`;
    if (result.length > MAX_DOCUMENT_CHARS) throw new Error('Extension document exceeds the size limit');
    return result;
  };

  const html = await read(root);
  if (html.type.split(';')[0] !== 'text/html') throw new Error('Extension entry is not HTML');
  return rewriteHtml(await html.text(), root, [root.href]);
};

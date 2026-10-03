import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'jsonc-parser';
import { z } from 'zod';
import { openThemeArchive } from './theme-archive.js';

const identifier = z.string().min(1).max(160).regex(/^[\w-]+$/);
const version = z.string().min(1).max(80).regex(/^[\w.+-]+$/);
const settings = z.object({ foreground: z.string().optional() });
const tokenRules = z.array(z.object({ scope: z.union([z.string(), z.array(z.string())]).optional(), settings }));
const sourceSchema = z.object({
  name: z.string().optional(), type: z.string().optional(), include: z.string().optional(),
  colors: z.record(z.string(), z.string().nullable()).default({}),
  tokenColors: z.union([z.string(), tokenRules]).optional(),
  semanticHighlighting: z.boolean().optional(),
  semanticTokenColors: z.record(z.string(), z.union([z.string(), settings])).optional(),
});
const extensionSchema = z.object({
  namespace: identifier, name: identifier, version,
  displayName: z.string().optional(), files: z.object({ icon: z.string().optional() }),
});
const detailSchema = extensionSchema.extend({ files: z.object({ download: z.string(), sha256: z.string() }) });
const manifestSchema = z.object({
  publisher: identifier, name: identifier, version,
  contributes: z.object({ themes: z.array(z.object({
    label: z.string().min(1).max(160), path: z.string().min(1).max(1024),
    uiTheme: z.enum(['vs', 'vs-dark', 'hc-black', 'hc-light']).optional(),
  })).min(1).max(40) }),
});
const querySchema = z.object({ query: z.string().trim().min(1).max(160) });
const packageSchema = z.object({ namespace: identifier, name: identifier, version });
const hosts = new Set(['open-vsx.org', 'openvsx.eclipsecontent.org']);

function trustedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password) throw new Error('Unexpected catalog host');
  return url;
}

async function download(url, maxBytes, signal, fetchImpl) {
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await fetchImpl(trustedUrl(url), { signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = new URL(response.headers.get('location') ?? '', url).href;
      continue;
    }
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new Error('Catalog request failed');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) throw new Error('Catalog response too large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return Buffer.concat(chunks, length);
  }
  throw new Error('Too many catalog redirects');
}

function parseJsonc(text, schema) {
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error('Invalid theme JSON');
  return schema.parse(value);
}

function themePath(from, reference) {
  if (/[\\\0:]/.test(reference) || reference.startsWith('/')) throw new Error('Invalid theme reference');
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), reference));
  if (!resolved.startsWith('extension/')) throw new Error('Theme reference escapes package');
  return resolved;
}

export function createThemeCatalog({ fetchImpl = fetch } = {}) {
  const search = async (input, signal = AbortSignal.timeout(15000)) => {
    const { query } = querySchema.parse(input);
    const url = new URL('https://open-vsx.org/api/-/search');
    url.search = new URLSearchParams({ query, category: 'Themes', size: '24', sortBy: 'relevance' }).toString();
    const bytes = await download(url.href, 1024 * 1024, signal, fetchImpl);
    const result = z.object({ extensions: z.array(extensionSchema).max(24) }).parse(JSON.parse(bytes.toString('utf8')));
    return result.extensions.map((extension) => ({
      namespace: extension.namespace, name: extension.name, version: extension.version,
      label: extension.displayName || extension.name,
      icon: extension.files.icon && URL.canParse(extension.files.icon) && hosts.has(new URL(extension.files.icon).hostname)
        ? trustedUrl(extension.files.icon).href : null,
    }));
  };

  const readPackage = async (input, signal = AbortSignal.timeout(45000)) => {
    const requested = packageSchema.parse(input);
    const url = `https://open-vsx.org/api/${requested.namespace}/${requested.name}/${requested.version}`;
    const detail = detailSchema.parse(JSON.parse((await download(url, 512 * 1024, signal, fetchImpl)).toString('utf8')));
    const bytes = await download(detail.files.download, 20 * 1024 * 1024, signal, fetchImpl);
    const checksum = (await download(detail.files.sha256, 256, signal, fetchImpl)).toString('utf8').trim().split(/\s+/)[0];
    if (createHash('sha256').update(bytes).digest('hex') !== checksum?.toLowerCase()) throw new Error('VSIX checksum mismatch');
    const read = openThemeArchive(bytes);
    const manifest = parseJsonc(await read('extension/package.json'), manifestSchema);
    if (manifest.publisher.toLowerCase() !== requested.namespace.toLowerCase() || manifest.name !== requested.name || manifest.version !== requested.version) throw new Error('VSIX identity mismatch');
    let reads = 0;
    const load = async (file, ancestors = []) => {
      signal.throwIfAborted();
      if (ancestors.includes(file) || ancestors.length >= 8 || ++reads > 320) throw new Error('Too many theme references');
      const source = parseJsonc(await read(file), sourceSchema);
      const parent = source.include ? await load(themePath(file, source.include), [...ancestors, file]) : null;
      const reference = z.string().safeParse(source.tokenColors);
      const rules = reference.success
        ? parseJsonc(await read(themePath(file, reference.data)), tokenRules) : tokenRules.parse(source.tokenColors ?? []);
      const { include: _include, ...own } = source;
      return {
        ...parent, ...own,
        colors: { ...parent?.colors, ...source.colors },
        tokenColors: [...(parent?.tokenColors ?? []), ...(rules ?? [])],
        semanticTokenColors: { ...parent?.semanticTokenColors, ...source.semanticTokenColors },
      };
    };
    const themes = [];
    let totalBytes = 0;
    for (const contribution of manifest.contributes.themes) {
      try {
        const file = themePath('extension/package.json', contribution.path);
        const source = await load(file);
        source.name = contribution.label;
        if (contribution.uiTheme) source.type = contribution.uiTheme === 'vs' ? 'light' : contribution.uiTheme === 'vs-dark' ? 'dark' : contribution.uiTheme;
        const text = JSON.stringify(source);
        totalBytes += Buffer.byteLength(text);
        if (Buffer.byteLength(text) > 512 * 1024 || totalBytes > 10 * 1024 * 1024) throw new Error('Resolved themes too large');
        themes.push({ path: contribution.path, name: contribution.label, text, error: false });
      } catch {
        signal.throwIfAborted();
        themes.push({ path: contribution.path, name: contribution.label, text: '', error: true });
      }
    }
    return themes;
  };
  return { search, readPackage };
}

export function registerThemeCatalogRoutes(app, catalog = createThemeCatalog()) {
  for (const [route, operation, schema] of [
    ['/api/config/themes/catalog/search', catalog.search, querySchema],
    ['/api/config/themes/catalog/package', catalog.readPackage, packageSchema],
  ]) {
    app.post(route, async (req, res) => {
      const input = schema.safeParse(req.body);
      if (!input.success) return res.status(400).json({ error: 'invalid' });
      const controller = new AbortController();
      const cancel = () => controller.abort();
      res.on('close', cancel);
      try {
        const items = await operation(input.data, AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]));
        res.json({ items });
      } catch {
        if (!res.destroyed) res.status(502).json({ error: 'catalog' });
      } finally {
        res.off('close', cancel);
      }
    });
  }
}

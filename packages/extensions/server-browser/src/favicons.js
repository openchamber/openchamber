// Page icons for the Browser panel's tabs, kept per origin as data URLs and
// reported on `tabs[].favicon`. Headless Chrome never loads a page's icon, so
// it is fetched here once per origin, through Chrome's own network stack
// (`Network.loadNetworkResource`): the same egress policy proxy as the page,
// never a request from this process.

const MAX_ORIGINS = 60;
const MAX_ICON_BYTES = 32 * 1024;
const ICON_MIMES = new Set([
  'image/png',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/svg+xml',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

// The page's declared icon, else the site's /favicon.ico.
const ICON_HREF_EXPRESSION = `(() => {
  const link = [...document.querySelectorAll('link[rel~="icon" i]')].find((candidate) => candidate.href);
  return link ? String(link.href) : new URL('/favicon.ico', location.href).href;
})()`;

const originOf = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
};

const mimeOf = (headers, iconUrl) => {
  const declared = Object.entries(headers ?? {})
    .find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  const mime = String(declared ?? '').split(';')[0].trim().toLowerCase();
  if (ICON_MIMES.has(mime)) return mime;
  // Servers often send /favicon.ico as octet-stream.
  return /\.ico(?:$|[?#])/i.test(iconUrl) ? 'image/x-icon' : null;
};

const readStream = async (send, handle) => {
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await send('IO.read', { handle, size: MAX_ICON_BYTES });
      const bytes = Buffer.from(String(chunk.data ?? ''), chunk.base64Encoded ? 'base64' : 'utf8');
      size += bytes.length;
      if (size > MAX_ICON_BYTES) return null;
      chunks.push(bytes);
      if (chunk.eof) return Buffer.concat(chunks);
    }
  } finally {
    await send('IO.close', { handle }).catch(() => {});
  }
};

export const createFavicons = () => {
  const byOrigin = new Map();
  const pending = new Set();

  const remember = (origin, dataUrl) => {
    byOrigin.delete(origin);
    byOrigin.set(origin, dataUrl);
    if (byOrigin.size > MAX_ORIGINS) byOrigin.delete(byOrigin.keys().next().value);
  };

  return {
    of(pageUrl) {
      const origin = originOf(pageUrl);
      return origin ? byOrigin.get(origin) ?? null : null;
    },
    // After a page finished loading; `send` runs a CDP command on its session.
    // The dock's state hash picks up a new icon. Failure keeps the placeholder.
    async load({ pageUrl, frameId, send }) {
      const origin = originOf(pageUrl);
      if (!origin || byOrigin.has(origin) || pending.has(origin)) return;
      pending.add(origin);
      try {
        const evaluated = await send('Runtime.evaluate', { expression: ICON_HREF_EXPRESSION, returnByValue: true });
        const iconUrl = String(evaluated.result?.value ?? '');
        if (!originOf(iconUrl)) return;
        const { resource } = await send('Network.loadNetworkResource', {
          frameId,
          url: iconUrl,
          options: { disableCache: false, includeCredentials: false },
        });
        if (!resource?.success || !resource.stream) return;
        const bytes = await readStream(send, resource.stream);
        const mime = mimeOf(resource.headers, iconUrl);
        if (!bytes || bytes.length === 0 || !mime) return;
        remember(origin, `data:${mime};base64,${bytes.toString('base64')}`);
      } catch {
        // No icon, an unreachable one, or the tab closed meanwhile.
      } finally {
        pending.delete(origin);
      }
    },
  };
};

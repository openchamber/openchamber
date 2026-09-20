// A browser provider with no browser: one in-memory "page" that answers every
// `browser.*` action the host can send. It exists to show the contract and to
// test the host's routing (Settings → OpenChamber Tools → Browser provider)
// without Chrome. A real provider replaces `page` with a driven browser.
import http from 'node:http';
import { deflateSync } from 'node:zlib';

import {
  BROWSER_PROVIDER_PATH,
  SURFACE_AGENT_ACTIVE_HEADER,
  SURFACE_CLIPBOARD_PATH,
  SURFACE_CONTROL_PATH,
  SURFACE_FRAME_PATH,
  SURFACE_HEIGHT_HEADER,
  SURFACE_INPUT_PATH,
  SURFACE_RESIZE_PATH,
  SURFACE_SEQ_HEADER,
  SURFACE_TITLE_HEADER,
  SURFACE_WIDTH_HEADER,
  readBrowserProviderRequest,
  readSurfaceControlNotice,
  readSurfaceInputBatch,
  readSurfaceResizeRequest,
  type BrowserProviderRequest,
  type BrowserProviderResult,
  type BrowserScrollData,
  type BrowserSnapshotElement,
  type BrowserViewportSummary,
  type SurfaceController,
  type SurfaceInputEvent,
} from '@openchamber/sdk';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1280, height: 800 },
  fill: { width: null, height: null },
} as const;

// A 1×1 transparent PNG, so `browser.capture` still writes a real image file.
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

type Page = {
  url: string;
  title: string;
  history: string[];
  forward: string[];
  viewport: keyof typeof VIEWPORTS;
  scrollY: number;
  fields: Map<string, string>;
};

const page: Page = {
  url: 'about:blank',
  title: '',
  history: [],
  forward: [],
  viewport: 'fill',
  scrollY: 0,
  fields: new Map(),
};

const viewport = (): BrowserViewportSummary => ({ mode: page.viewport, ...VIEWPORTS[page.viewport] });

const elements = (): BrowserSnapshotElement[] => [
  { selector: '#name', tag: 'input', type: 'text', label: 'Name', bounds: { x: 16, y: 40, width: 240, height: 32 }, inViewport: true },
  { selector: '#save', tag: 'button', label: 'Save', bounds: { x: 16, y: 88, width: 80, height: 32 }, inViewport: true },
  { selector: 'a[href="/about"]', tag: 'a', label: 'About', bounds: { x: 16, y: 140, width: 60, height: 20 }, inViewport: true },
];

const navigate = (url: string): void => {
  if (page.url !== 'about:blank') page.history.push(page.url);
  page.forward = [];
  page.url = url;
  page.title = `Stub page for ${new URL(url).host}`;
  page.scrollY = 0;
};

const handle = (request: BrowserProviderRequest): BrowserProviderResult => {
  markAgentActive();
  switch (request.action) {
    case 'browser.open':
      navigate(request.parameters.url);
      if (request.parameters.viewport) page.viewport = request.parameters.viewport;
      return { ok: true, data: { url: page.url, title: page.title, opened: true, settled: true, viewport: viewport() } };
    case 'browser.snapshot':
      return {
        ok: true,
        data: {
          url: page.url,
          title: page.title,
          scope: request.parameters.selector ?? 'document',
          scrollY: page.scrollY,
          maxScrollY: 600,
          text: `This page is served by the browser provider stub, not a browser.\nName: ${page.fields.get('#name') ?? ''}`,
          elements: elements(),
          viewport: viewport(),
        },
      };
    case 'browser.click': {
      const target = elements().find((element) => (
        element.selector === request.parameters.selector
        || (request.parameters.text && element.label?.toLowerCase() === request.parameters.text.toLowerCase())
      ));
      if (!target) return { ok: false, error: `No element matches ${request.parameters.selector ?? request.parameters.text}` };
      if (target.tag === 'a') navigate(new URL('/about', page.url).toString());
      return { ok: true, data: { clicked: target.selector, label: target.label ?? '', url: page.url } };
    }
    case 'browser.type': {
      if (request.parameters.selector !== '#name') return { ok: false, error: `${request.parameters.selector} is not a text field` };
      page.fields.set('#name', request.parameters.value);
      return { ok: true, data: { selector: '#name', url: page.url } };
    }
    case 'browser.scroll': {
      const { direction } = request.parameters;
      if (direction === 'top') page.scrollY = 0;
      else if (direction === 'bottom') page.scrollY = 600;
      else if (direction === 'up') page.scrollY = Math.max(0, page.scrollY - 300);
      else if (direction === 'down') page.scrollY = Math.min(600, page.scrollY + 300);
      const data: BrowserScrollData = { scrollY: page.scrollY, maxScrollY: 600, atTop: page.scrollY === 0, atBottom: page.scrollY === 600 };
      if (direction) data.direction = direction;
      return { ok: true, data };
    }
    case 'browser.back': {
      const previous = page.history.pop();
      if (!previous) return { ok: false, error: 'There is nothing to go back to in this tab' };
      page.forward.push(page.url);
      page.url = previous;
      return { ok: true, data: { url: page.url, title: page.title } };
    }
    case 'browser.forward': {
      const next = page.forward.pop();
      if (!next) return { ok: false, error: 'There is nothing to go forward to in this tab' };
      page.history.push(page.url);
      page.url = next;
      return { ok: true, data: { url: page.url, title: page.title } };
    }
    case 'browser.inspect': {
      const target = elements().find((element) => element.selector === request.parameters.selector);
      if (!target) return { ok: false, error: `No element matches ${request.parameters.selector}` };
      return { ok: true, data: { selector: target.selector, tag: target.tag, label: target.label ?? '', bounds: target.bounds, inViewport: true, styles: { color: 'rgb(0, 0, 0)', 'font-size': '14px' } } };
    }
    case 'browser.capture':
      return { ok: true, data: { base64: PIXEL_PNG, mime: 'image/png', width: 1, height: 1, url: page.url, title: page.title, viewport: viewport() } };
    case 'browser.resize':
      page.viewport = request.parameters.viewport;
      return { ok: true, data: { viewport: viewport() } };
  }
};

// ---- Shared surface: the same page, drawn as a picture ----------------------
//
// A real provider would screencast its browser. This one paints the fake page
// with rectangles so the host's viewer, control hand-off, and input path can
// be seen working without any browser at all.

type Surface = {
  width: number;
  height: number;
  seq: number;
  cursor: { x: number; y: number } | null;
  pressed: boolean;
  hue: number;
  controller: SurfaceController;
  lastKey: string;
  clipboard: string;
  agentActiveUntil: number;
  waiters: Array<() => void>;
};

const surface: Surface = {
  width: 640,
  height: 400,
  // Starts above zero so a viewer's first request (`after=0`) gets a picture
  // right away instead of waiting for something to change.
  seq: 1,
  cursor: null,
  pressed: false,
  hue: 210,
  controller: 'none',
  lastKey: '',
  clipboard: '',
  agentActiveUntil: 0,
  waiters: [],
};

const touch = (): void => {
  surface.seq += 1;
  for (const wake of surface.waiters.splice(0)) wake();
};

const markAgentActive = (): void => {
  surface.agentActiveUntil = Date.now() + 3_000;
  touch();
};

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
};

/** Encodes an RGB raster as a PNG with Node's zlib; enough for a demo. */
const encodePng = (width: number, height: number, rgb: Uint8Array): Buffer => {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
};

const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
};

const renderFrame = (): Buffer => {
  const { width, height } = surface;
  const rgb = new Uint8Array(width * height * 3);
  const fill = (x0: number, y0: number, w: number, h: number, color: [number, number, number]) => {
    const x1 = Math.min(width, x0 + w);
    const y1 = Math.min(height, y0 + h);
    for (let y = Math.max(0, y0); y < y1; y += 1) {
      for (let x = Math.max(0, x0); x < x1; x += 1) {
        const i = (y * width + x) * 3;
        rgb[i] = color[0];
        rgb[i + 1] = color[1];
        rgb[i + 2] = color[2];
      }
    }
  };
  fill(0, 0, width, height, hslToRgb(surface.hue, 0.25, 0.94));
  // The page's elements, at the positions the snapshot reports.
  for (const element of elements()) {
    const { x, y, width: w, height: h } = element.bounds;
    fill(x, y, w, h, element.tag === 'button' ? hslToRgb(surface.hue, 0.6, 0.45) : [255, 255, 255]);
    fill(x, y + h - 2, w, 2, hslToRgb(surface.hue, 0.5, 0.35));
  }
  // Who is in control, as a stripe along the top: blue for the agent, green for the user.
  const stripe: [number, number, number] = surface.controller === 'user' ? [46, 160, 67] : surface.controller === 'agent' ? [31, 111, 235] : [180, 180, 180];
  fill(0, 0, width, 4, stripe);
  if (surface.cursor) {
    const size = surface.pressed ? 14 : 10;
    fill(surface.cursor.x - size / 2, surface.cursor.y - size / 2, size, size, [220, 40, 40]);
  }
  return encodePng(width, height, rgb);
};

const applyInput = (events: SurfaceInputEvent[]): void => {
  for (const event of events) {
    if (event.type === 'pointer') {
      surface.cursor = { x: event.x, y: event.y };
      if (event.action === 'down') surface.pressed = true;
      if (event.action === 'up') surface.pressed = false;
    } else if (event.type === 'key' && event.action === 'down') {
      surface.lastKey = event.key;
      // Any key shifts the hue, so a keystroke is visibly received.
      surface.hue = (surface.hue + 23) % 360;
      if ((event.modifiers.meta || event.modifiers.ctrl) && event.key.toLowerCase() === 'c') {
        surface.clipboard = `Copied from the stub at ${new Date().toISOString()}`;
      }
    } else if (event.type === 'text') {
      page.fields.set('#name', `${page.fields.get('#name') ?? ''}${event.text}`);
    } else if (event.type === 'wheel') {
      page.scrollY = Math.max(0, Math.min(600, page.scrollY + Math.round(event.deltaY)));
    }
  }
  touch();
};

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => resolve(body));
});

const handleSurface = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
  if (url.pathname === SURFACE_FRAME_PATH && req.method === 'GET') {
    const after = Number(url.searchParams.get('after') ?? '0');
    const wait = Math.min(Number(url.searchParams.get('wait') ?? '0'), 25_000);
    if (surface.seq <= after) {
      await new Promise<void>((resolve) => {
        surface.waiters.push(resolve);
        setTimeout(resolve, wait);
      });
    }
    if (surface.seq <= after) {
      res.writeHead(204);
      res.end();
      return true;
    }
    const png = renderFrame();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', png.length);
    res.setHeader(SURFACE_SEQ_HEADER, String(surface.seq));
    res.setHeader(SURFACE_WIDTH_HEADER, String(surface.width));
    res.setHeader(SURFACE_HEIGHT_HEADER, String(surface.height));
    res.setHeader(SURFACE_TITLE_HEADER, page.title || 'Stub surface');
    if (Date.now() < surface.agentActiveUntil) res.setHeader(SURFACE_AGENT_ACTIVE_HEADER, '1');
    res.writeHead(200);
    res.end(png);
    return true;
  }
  if (url.pathname === SURFACE_INPUT_PATH && req.method === 'POST') {
    const batch = readSurfaceInputBatch(await readBody(req));
    if (!batch) {
      res.writeHead(400);
      res.end();
      return true;
    }
    applyInput(batch.events);
    res.writeHead(204);
    res.end();
    return true;
  }
  if (url.pathname === SURFACE_CONTROL_PATH && req.method === 'POST') {
    const notice = readSurfaceControlNotice(await readBody(req));
    if (!notice) {
      res.writeHead(400);
      res.end();
      return true;
    }
    surface.controller = notice.controller;
    touch();
    res.writeHead(204);
    res.end();
    return true;
  }
  if (url.pathname === SURFACE_RESIZE_PATH && req.method === 'POST') {
    const request = readSurfaceResizeRequest(await readBody(req));
    if (!request) {
      res.writeHead(400);
      res.end();
      return true;
    }
    // Follow the panel, within reason: a demo does not need 4K rasters.
    surface.width = Math.max(200, Math.min(1600, request.width));
    surface.height = Math.max(150, Math.min(1200, request.height));
    touch();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ width: surface.width, height: surface.height }));
    return true;
  }
  if (url.pathname === SURFACE_CLIPBOARD_PATH && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: surface.clipboard }));
    return true;
  }
  return false;
};

const json = (res: http.ServerResponse, status: number, body: BrowserProviderResult | { ok: true }): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/health') {
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname.startsWith('/surface/')) {
    void handleSurface(req, res, url).then((handled) => {
      if (!handled) json(res, 404, { ok: false, error: 'not-found' });
    });
    return;
  }
  if (url.pathname === BROWSER_PROVIDER_PATH && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const request = readBrowserProviderRequest(body);
      if (!request) {
        json(res, 400, { ok: false, error: 'Not a browser action' });
        return;
      }
      json(res, 200, handle(request));
    });
    return;
  }
  json(res, 404, { ok: false, error: 'not-found' });
}).listen(port, '127.0.0.1');

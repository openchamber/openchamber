import { createReadStream, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };

export const createFixtureDir = (name, parent = 'tmp') => {
  mkdirSync(path.join(repo, parent), { recursive: true });
  return mkdtempSync(path.join(repo, parent, `${name}-`));
};

const ALIASES = [
  { find: '@openchamber/sdk/schemas', replacement: path.join(repo, 'packages/sdk/src/schemas.ts') },
  { find: '@openchamber/sdk/ui', replacement: path.join(repo, 'packages/sdk/src/ui/index.ts') },
  { find: '@openchamber/sdk', replacement: path.join(repo, 'packages/sdk/src/index.ts') },
  { find: '@openchamber/ui', replacement: path.join(repo, 'packages/ui/src') },
  { find: '@', replacement: path.join(repo, 'packages/ui/src') },
];

/**
 * Builds the page in `root` and serves the finished files. A Vite dev server
 * compiles inside the page's own wait, reloads it when it finds another
 * dependency, and a wait that fails leaves its process running.
 */
export const serveFixture = async ({ root, aliases = [] }) => {
  const { build } = await import('vite');
  const dist = path.join(root, 'dist');
  const built = build({
    configFile: false, root, logLevel: 'error', css: { postcss: repo },
    cacheDir: path.join(root, '.vite'),
    resolve: { alias: [...aliases, ...ALIASES] },
    worker: { format: 'es' },
    build: { outDir: dist, minify: false, target: 'esnext', reportCompressedSize: false, chunkSizeWarningLimit: Infinity },
  });
  await built.catch((error) => {
    rmSync(root, { recursive: true, force: true });
    throw error;
  });
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://fixture');
    const file = path.join(dist, decodeURIComponent(pathname.endsWith('/') ? `${pathname}index.html` : pathname));
    if (!file.startsWith(dist + path.sep) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    pipeline(createReadStream(file), response).catch(() => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => { server.close(resolve); });
      // Chrome's helpers can still be writing into a profile inside the fixture as the main process exits.
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
};

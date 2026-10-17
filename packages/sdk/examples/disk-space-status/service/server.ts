import { timingSafeEqual } from 'node:crypto';
import { stat, statfs } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';

type CapacityStats = { blocks: number; bsize: number; bavail: number };
type Answer = { totalBytes: number; availableBytes: number } | { ok: true } | { error: string };

const json = (response: ServerResponse, status: number, body: Answer): void => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
};

export const createDiskSpaceServer = (token: string, readCapacity: (directory: string) => Promise<CapacityStats> = statfs) => {
  if (!token) throw new Error('A service token is required');
  const authorization = Buffer.from(`Bearer ${token}`);
  let reading = false;
  return createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      json(response, 401, { error: 'unauthorized' });
      return;
    }
    if (request.method !== 'GET') {
      json(response, 405, { error: 'method-not-allowed' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health') {
      json(response, 200, { ok: true });
      return;
    }
    if (url.pathname !== '/disk-space') {
      json(response, 404, { error: 'not-found' });
      return;
    }
    const directories = url.searchParams.getAll('directory');
    const directory = directories.length === 1 ? directories[0] : '';
    if (!isAbsolute(directory) || directory.includes('\0')) {
      json(response, 400, { error: 'invalid-directory' });
      return;
    }
    // A timed-out client cannot cancel a filesystem syscall. Do not pile up
    // more reads behind a slow mount, even when several frames are open.
    if (reading) { json(response, 503, { error: 'busy' }); return; }
    reading = true;
    try {
      if (!(await stat(directory)).isDirectory()) {
        json(response, 400, { error: 'invalid-directory' });
        return;
      }
      const stats = await readCapacity(directory);
      const totalBytes = stats.blocks * stats.bsize;
      const availableBytes = Math.max(0, stats.bavail * stats.bsize);
      if (!Number.isFinite(totalBytes) || totalBytes <= 0
        || !Number.isFinite(availableBytes) || availableBytes > totalBytes) {
        json(response, 503, { error: 'unavailable' });
        return;
      }
      json(response, 200, { totalBytes, availableBytes });
    } catch {
      // Never disclose host paths or raw filesystem diagnostics to the page.
      json(response, 503, { error: 'unavailable' });
    } finally {
      reading = false;
    }
  });
};

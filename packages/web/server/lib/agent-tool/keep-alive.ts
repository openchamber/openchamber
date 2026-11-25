import type { ResultFields } from './runtime.js';
import type { Response } from '../shared/http-contracts.js';

const KEEP_ALIVE_MS = 60_000;

export const keepResponseAlive = (res: Response, intervalMs = KEEP_ALIVE_MS) => {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-transform' });
    res.write(' ');
  }, intervalMs);
  return {
    send: (result: ResultFields) => (res.headersSent ? res.end(JSON.stringify(result)) : res.json(result)),
    stop: () => clearInterval(timer),
  };
};

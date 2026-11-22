import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readBoundedFileSync } from '../shared/bounded-file-read.js';
import { readBoundedResponseText } from '../shared/response-body.js';

export const MCPX_DAEMON_TIMEOUT_MS = 10_000;
export const MCPX_DAEMON_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

// A discovery record is a single socket path in JSON — a few KiB is
// generous. The state dir is user-writable, so the record's size and
// type are not under this process's control: the read is bounded and
// handle-judged (#1773), so a FIFO or an oversize daemon-*.json is
// skipped promptly instead of freezing the server on every mcpx call.
export const MCPX_DAEMON_DISCOVERY_MAX_BYTES = 4 * 1024;

const timeoutError = (timeoutMs) => new Error(`mcpx daemon timed out after ${timeoutMs}ms`);
const tooLargeError = (maxBytes) => new Error(`mcpx daemon response exceeded ${maxBytes} bytes`);

const defaultSocketPath = () => {
  if (process.env.MCPX_SOCKET) return process.env.MCPX_SOCKET;
  const stateDir = process.env.MCPX_STATE_DIR ||
    (process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, 'mcpx') :
    path.join(os.homedir(), '.local', 'state', 'mcpx'));
  return path.join(stateDir, 'daemon.sock');
};

const findDaemonSocket = () => {
  const direct = defaultSocketPath();
  if (fs.existsSync(direct)) return direct;

  const stateDir = process.env.MCPX_STATE_DIR ||
    (process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, 'mcpx') :
    path.join(os.homedir(), '.local', 'state', 'mcpx'));
  if (fs.existsSync(stateDir)) {
    try {
      const files = fs.readdirSync(stateDir).filter((f) => f.startsWith('daemon-') && f.endsWith('.json'));
      for (const file of files) {
        try {
          // Bounded, handle-judged read (#1773): missing, non-regular
          // (a FIFO at a daemon-*.json path) and over-cap entries are
          // skipped exactly as unreadable/unparsable entries always
          // were; the reader opens with O_NONBLOCK and enforces the
          // cap during the read, so none of them can block or buffer
          // whole.
          const result = readBoundedFileSync(path.join(stateDir, file), MCPX_DAEMON_DISCOVERY_MAX_BYTES);
          if (!result.ok) continue;
          const info = JSON.parse(result.buffer.toString('utf-8'));
          if (info.socket && fs.existsSync(info.socket)) return info.socket;
        } catch {}
      }
    } catch {}
  }
  return undefined;
};

export const callDaemon = async (reqPath, method = 'GET', body = null, headers = {}, options = {}) => {
  const timeoutMs = options.timeoutMs ?? MCPX_DAEMON_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MCPX_DAEMON_MAX_RESPONSE_BYTES;
  const endpoint = process.env.MCPX_DAEMON_ENDPOINT || process.env.MCPX_ENDPOINT;
  const socket = findDaemonSocket();

  if (endpoint && endpoint.startsWith('http')) {
    let res;
    try {
      res = await fetch(`${endpoint.replace(/\/+$/, '')}${reqPath}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw timeoutError(timeoutMs);
      throw err;
    }
    let bounded;
    try {
      bounded = await readBoundedResponseText(res, maxResponseBytes);
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw timeoutError(timeoutMs);
      throw err;
    }
    if (bounded.tooLarge) throw tooLargeError(maxResponseBytes);
    if (!res.ok) throw new Error(`mcpx daemon HTTP ${res.status}: ${bounded.text}`);
    return JSON.parse(bounded.text);
  }

  if (socket) {
    return new Promise((resolve, reject) => {
      let settled = false;
      // Absolute deadline, armed below once the request exists:
      // req.setTimeout is only an idle timer (it resets on every
      // chunk), so a trickling response would otherwise hold the
      // request open far beyond timeoutMs. Cleared on settle.
      let deadlineTimer = null;
      const clearDeadline = () => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        deadlineTimer = null;
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearDeadline();
        reject(err);
      };
      const opt = {
        socketPath: socket,
        path: reqPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      };

      const req = http.request(opt, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxResponseBytes) {
            fail(tooLargeError(maxResponseBytes));
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearDeadline();
          const data = Buffer.concat(chunks, size).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`mcpx daemon HTTP ${res.statusCode}: ${data}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
        res.on('error', fail);
      });

      deadlineTimer = setTimeout(() => {
        fail(timeoutError(timeoutMs));
        req.destroy();
      }, timeoutMs);
      deadlineTimer.unref?.();
      req.setTimeout(timeoutMs, () => {
        fail(timeoutError(timeoutMs));
        req.destroy();
      });
      req.on('error', fail);
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  throw new Error('No mcpx daemon reachable');
};

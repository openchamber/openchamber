import fs from 'node:fs/promises';
import net from 'node:net';
import { z } from 'zod';

const DEFAULT_CLIENT_CONFIG = '/etc/openchamber/protected-mcp/client.json';
const STATUS_TIMEOUT_MS = 2000;
const MAX_ANSWER_BYTES = 1024 * 1024;

/** Where the installer put the client configuration; the variable exists for development hosts. */
export const resolveClientConfigPath = (env = process.env) => env.OPENCHAMBER_PROTECTED_MCP_CLIENT_CONFIG?.trim() || DEFAULT_CLIENT_CONFIG;

const clientConfigSchema = z.object({
  version: z.literal(1),
  socket: z.string().startsWith('/'),
  relay: z.array(z.string().min(1)).min(1),
  adminSocket: z.string().startsWith('/'),
});

const statusSchema = z.object({
  protocol: z.literal(1),
  service: z.object({ version: z.string() }),
  enforcement: z.object({
    status: z.enum(['protected', 'unverified', 'unprotected']),
    checkedAt: z.number(),
    findings: z.array(z.object({ code: z.string(), level: z.enum(['error', 'unknown', 'warning']), subject: z.string().optional() })),
  }),
  administration: z.enum(['shared', 'separate']),
  connections: z.array(z.object({
    id: z.string().regex(/^pmcp_[0-9a-f]{16}$/),
    name: z.string(),
    revision: z.number(),
    enabled: z.boolean(),
    transport: z.enum(['stdio', 'http']),
    target: z.object({ kind: z.enum(['command', 'package', 'url']), label: z.string() }),
    credential: z.enum(['none', 'stored', 'missing', 'authorized', 'authorization_required']),
  })),
});

const isPermissionError = (error) => error.code === 'EACCES' || error.code === 'EPERM';

const askStatus = (socketPath, timeoutMs) => new Promise((resolve) => {
  const socket = net.createConnection(socketPath);
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => {
    socket.destroy();
    resolve({ state: 'unreachable' });
  }, timeoutMs);
  socket.once('connect', () => socket.write('{"type":"status"}\n'));
  socket.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_ANSWER_BYTES) socket.destroy();
    else chunks.push(chunk);
  });
  socket.once('error', (error) => {
    clearTimeout(timer);
    resolve({ state: isPermissionError(error) ? 'permission_denied' : 'unreachable' });
  });
  socket.once('close', () => {
    clearTimeout(timer);
    let value;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return resolve({ state: 'invalid_response' });
    }
    const parsed = statusSchema.safeParse(value);
    return resolve(parsed.success ? { state: 'available', status: parsed.data } : { state: 'invalid_response' });
  });
});

/**
 * The protected service as this host sees it, with each way it can be missing
 * kept distinct: a failed read is never reported as "no connections".
 */
export async function readServiceState({ clientConfigPath, platform = process.platform, timeoutMs = STATUS_TIMEOUT_MS }) {
  if (platform !== 'linux') return { state: 'unsupported_platform' };
  let text;
  try {
    text = await fs.readFile(clientConfigPath, 'utf8');
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'not_installed' : 'invalid_client_config' };
  }
  let config;
  try {
    config = clientConfigSchema.parse(JSON.parse(text));
  } catch {
    return { state: 'invalid_client_config' };
  }
  return askStatus(config.socket, timeoutMs);
}

const adminConnectionSchema = z.object({
  id: z.string().regex(/^pmcp_[0-9a-f]{16}$/), name: z.string(), revision: z.number().int(),
}).passthrough();
const outcomeSchema = z.enum(['authorized', 'oauth_denied', 'oauth_state_invalid', 'oauth_connection_changed', 'oauth_exchange_failed']);
const subjectSchema = z.string().regex(/^(?:agent|space-[0-9a-f]{12})$/);
const subjectViewSchema = z.object({ subject: subjectSchema, connections: z.array(z.string().regex(/^pmcp_[0-9a-f]{16}$/)) });
const adminAnswerSchema = z.discriminatedUnion('type', [
  subjectViewSchema.extend({ type: z.literal('subject') }),
  z.object({ type: z.literal('subjects'), subjects: z.array(subjectViewSchema) }),
  z.object({ type: z.literal('subject-removed'), subject: subjectSchema }),
  z.object({ type: z.literal('error'), status: z.number().int().min(400).max(599), code: z.string(), message: z.string() }),
  z.object({ type: z.literal('connections'), status: statusSchema, connections: z.array(adminConnectionSchema) }),
  z.object({ type: z.literal('connection'), connection: adminConnectionSchema }),
  z.object({ type: z.literal('applied'), connection: adminConnectionSchema.nullable() }),
  z.object({ type: z.literal('oauth-started'), attempt: z.string(), authorizationUrl: z.string() }),
  z.object({ type: z.literal('oauth-completed'), outcome: outcomeSchema, name: z.string().nullable() }),
  z.object({ type: z.literal('oauth-attempt'), status: z.enum(['pending', 'done', 'unknown']), outcome: outcomeSchema.optional() }),
]);
const adminFailure = (status, code) => ({ ok: false, status, code, message: code });
const socketFailure = (error) => adminFailure(503, isPermissionError(error) ? 'service_permission_denied' : 'service_unavailable');

/** One bounded administration exchange. Config and endpoint are resolved on every call. */
export async function requestAdmin({ clientConfigPath, frame, timeoutMs = 10000 }) {
  let config;
  try {
    config = clientConfigSchema.parse(JSON.parse(await fs.readFile(clientConfigPath, 'utf8')));
  } catch (error) {
    return socketFailure(error);
  }
  return new Promise((resolve) => {
    const socket = net.createConnection(config.adminSocket);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(adminFailure(504, 'service_timeout')), timeoutMs);
    socket.once('connect', () => socket.write(`${JSON.stringify(frame)}\n`));
    socket.once('error', (error) => finish(socketFailure(error)));
    socket.once('close', () => finish(adminFailure(502, 'invalid_response')));
    socket.on('data', (chunk) => {
      const newline = chunk.indexOf(0x0a);
      const part = newline === -1 ? chunk : chunk.subarray(0, newline);
      if (buffer.length + part.length > MAX_ANSWER_BYTES) return finish(adminFailure(502, 'invalid_response'));
      buffer = Buffer.concat([buffer, part]);
      if (newline === -1) return;
      let parsed;
      try { parsed = adminAnswerSchema.safeParse(JSON.parse(buffer.toString('utf8'))); }
      catch { return finish(adminFailure(502, 'invalid_response')); }
      if (!parsed.success) return finish(adminFailure(502, 'invalid_response'));
      const answer = parsed.data;
      if (answer.type === 'error') return finish({ ok: false, status: answer.status, code: answer.code, message: answer.message });
      return finish({ ok: true, answer });
    });
  });
}

export const listSubjects = (options = {}) => requestAdmin({ clientConfigPath: resolveClientConfigPath(), ...options, frame: { type: 'subjects' } });
export const setSubject = (subject, connections, options = {}) => requestAdmin({ clientConfigPath: resolveClientConfigPath(), ...options, frame: { type: 'subject-set', subject, connections } });
export const removeSubject = (subject, options = {}) => requestAdmin({ clientConfigPath: resolveClientConfigPath(), ...options, frame: { type: 'subject-remove', subject } });

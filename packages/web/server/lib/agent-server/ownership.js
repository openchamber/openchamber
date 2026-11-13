import path from 'node:path';
import { spaceRouteOf } from '../spaces/dispatcher.js';

// Ordered method + normalized path rules. A family matches complete segments only.
export const OWNERSHIP = Object.freeze([
  { methods: ['*'], path: '/auth', family: true, owner: 'local' },
  { methods: ['*'], path: '/connect', owner: 'local' },
  { methods: ['GET', 'HEAD'], path: '/health', owner: 'local' },
  ...[
    '/api/auth', '/api/passkeys', '/api/client-auth', '/api/openchamber/relay',
    '/api/openchamber/tunnel', '/api/openchamber/update', '/api/push', '/api/notifications',
    '/api/notification-center', '/api/protected-mcp', '/api/openchamber/spaces',
    '/api/dictation', '/api/tts', '/api/voice', '/api/config/themes', '/api/themes',
    '/api/source-control/github/pr/fix-loops',
  ].map((value) => ({ methods: ['*'], path: value, family: true, owner: 'local' })),
  { methods: ['GET', 'HEAD'], path: '/api/version', owner: 'local' },
  { methods: ['GET', 'HEAD'], path: '/api/openchamber/enterprise-policy', owner: 'local' },
  { methods: ['GET', 'HEAD'], path: '/api/openchamber/update-check', owner: 'local' },
  { methods: ['POST'], path: '/api/openchamber/update-install', owner: 'local' },
  { methods: ['GET', 'HEAD'], path: '/api/openchamber/events', owner: 'local' },
  { methods: ['POST'], path: '/api/tracked-items/interest', owner: 'local' },
  { methods: ['POST'], path: '/api/tracked-items/presence', owner: 'local' },
  { methods: ['GET', 'HEAD'], path: '/api/global/event', owner: 'local' },
  { methods: ['GET', 'HEAD'], path: '/api/event', owner: 'local' },
  { methods: ['GET', 'HEAD', 'PUT'], path: '/api/config/settings', owner: 'local' },
  { methods: ['POST'], path: '/api/openchamber/directory', owner: 'local' },
  { methods: ['GET', 'HEAD'], path: '/api/system/info', owner: 'local' },
  { methods: ['GET', 'HEAD'], path: '/api/system/stats', owner: 'local' },
  { methods: ['POST'], path: '/api/system/shutdown', owner: 'refused' },
  { methods: ['POST'], path: '/api/system/dev-shutdown', owner: 'refused' },
  { methods: ['GET', 'HEAD'], path: '/api/system/free-port', owner: 'refused' },
  { methods: ['POST'], path: '/api/system/probe-url', owner: 'refused' },
  { methods: ['*'], path: '/api/system', family: true, owner: 'refused' },
  { methods: ['GET'], path: '/api/global/event/ws', upgrade: true, owner: 'local' },
  { methods: ['GET'], path: '/api/event/ws', upgrade: true, owner: 'local' },
  { methods: ['GET'], path: '/api/terminal/ws', upgrade: true, owner: 'agent' },
  { methods: ['GET'], path: '/api/dev-tunnel', upgrade: true, owner: 'agent' },
  { methods: ['GET'], path: '/api/spaces', family: true, upgrade: true, owner: 'space' },
  { methods: ['*'], path: '/api', family: true, upgrade: true, owner: 'refused' },
  { methods: ['*'], path: '/api/spaces', family: true, owner: 'space' },
  { methods: ['*'], path: '/api', family: true, owner: 'agent' },
].map((rule) => Object.freeze({ ...rule, methods: Object.freeze(rule.methods) })));

export function normalizedRequestUrl(req) {
  const raw = req.originalUrl ?? req.url ?? '/';
  const rawPath = raw.split('?')[0];
  if (!rawPath.startsWith('/') || /[\\#\u0000-\u0020]/.test(rawPath) || /\/\//.test(rawPath)) return null;
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { return null; }
  // Encoded delimiters must never select a different owner at the upstream router.
  if (/[\\#?%\u0000-\u0020]/.test(decoded) || /%2f/i.test(rawPath) || /\/\//.test(decoded)) return null;
  const url = new URL(raw, 'http://localhost');
  url.pathname = path.posix.normalize(decoded).replace(/\/$/, '') || '/';
  return url;
}

export function classify(req) {
  const url = normalizedRequestUrl(req);
  if (!url) return 'refused';
  const upgrade = String(req.headers?.upgrade ?? '').toLowerCase() === 'websocket';
  const method = String(req.method ?? 'GET').toUpperCase();
  const pathname = url.pathname.toLowerCase();
  for (const rule of OWNERSHIP) {
    if (Boolean(rule.upgrade) !== upgrade) continue;
    if (!rule.methods.includes('*') && !rule.methods.includes(method)) continue;
    if (pathname !== rule.path && !(rule.family && pathname.startsWith(`${rule.path}/`))) continue;
    // Owner services keep their authority even when an SDK carries a space
    // directory header. Otherwise their JSON parser would skip a local body.
    if (rule.owner !== 'agent') return rule.owner;
    if (spaceRouteOf({ ...req, headers: req.headers ?? {} }, url)) return 'space';
    return rule.owner;
  }
  return upgrade ? 'refused' : 'local';
}

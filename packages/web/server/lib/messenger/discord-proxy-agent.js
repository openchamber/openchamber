import net from 'node:net';
import tls from 'node:tls';
import { Agent as HttpsAgent } from 'node:https';

function parseProxyUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function splitHostPort(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return { host: '', port: null };
  const bracket = text.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracket) return { host: bracket[1], port: bracket[2] ? Number(bracket[2]) : null };
  const idx = text.lastIndexOf(':');
  if (idx > -1 && /^\d+$/.test(text.slice(idx + 1)) && text.indexOf(':') === idx) {
    return { host: text.slice(0, idx), port: Number(text.slice(idx + 1)) };
  }
  return { host: text, port: null };
}

export function shouldBypassProxy({ hostname, port, noProxy }) {
  const host = String(hostname ?? '').toLowerCase();
  if (!host) return false;
  const targetPort = Number(port) || null;
  for (const raw of String(noProxy ?? '').split(',')) {
    const rule = raw.trim().toLowerCase();
    if (!rule) continue;
    if (rule === '*') return true;
    const { host: ruleHost, port: rulePort } = splitHostPort(rule);
    if (rulePort && targetPort && rulePort !== targetPort) continue;
    if (ruleHost.startsWith('.')) {
      if (host === ruleHost.slice(1) || host.endsWith(ruleHost)) return true;
      continue;
    }
    if (ruleHost.startsWith('*')) {
      const suffix = ruleHost.slice(1);
      if (suffix && host.endsWith(suffix)) return true;
      continue;
    }
    if (host === ruleHost || host.endsWith(`.${ruleHost}`)) return true;
  }
  return false;
}

export function resolveDiscordGatewayProxy({ env = process.env, targetUrl } = {}) {
  const target = new URL(targetUrl);
  if (shouldBypassProxy({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'wss:' ? 443 : 80),
    noProxy: env.NO_PROXY ?? env.no_proxy,
  })) {
    return null;
  }
  const raw =
    (target.protocol === 'wss:' ? env.HTTPS_PROXY ?? env.https_proxy : env.HTTP_PROXY ?? env.http_proxy) ??
    env.ALL_PROXY ??
    env.all_proxy ??
    null;
  return parseProxyUrl(raw);
}

function connectProxySocket(proxyUrl, callback) {
  const port = Number(proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80));
  const options = { host: proxyUrl.hostname, port };
  const socket = proxyUrl.protocol === 'https:' ? tls.connect(options) : net.connect(options);
  let settled = false;
  const done = (err) => {
    if (settled) return;
    settled = true;
    callback(err, socket);
  };
  if (proxyUrl.protocol === 'https:') {
    socket.once('secureConnect', () => done(null));
  } else {
    socket.once('connect', () => done(null));
  }
  socket.once('error', (err) => done(err));
}

function writeConnectRequest(socket, proxyUrl, target, callback) {
  const auth = proxyUrl.username || proxyUrl.password
    ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64')}\r\n`
    : '';
  const request =
    `CONNECT ${target.host}:${target.port} HTTP/1.1\r\n` +
    `Host: ${target.host}:${target.port}\r\n` +
    auth +
    'Connection: close\r\n\r\n';
  let buffered = Buffer.alloc(0);
  const onData = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const marker = buffered.indexOf('\r\n\r\n');
    if (marker === -1) return;
    socket.off('data', onData);
    const head = buffered.slice(0, marker).toString('utf8');
    if (!/^HTTP\/1\.[01] 2\d\d\b/.test(head)) {
      socket.destroy();
      callback(new Error(`proxy CONNECT failed: ${head.split('\r\n')[0] || 'unknown response'}`));
      return;
    }
    const rest = buffered.slice(marker + 4);
    if (rest.length > 0) socket.unshift(rest);
    callback(null, socket);
  };
  socket.on('data', onData);
  socket.write(request);
}

class DiscordGatewayProxyAgent extends HttpsAgent {
  constructor(proxyUrl) {
    super({ keepAlive: false });
    this.proxyUrl = proxyUrl;
  }

  createConnection(options, callback) {
    const target = {
      host: options.host || options.hostname,
      port: Number(options.port || 443),
      servername: options.servername || options.host || options.hostname,
    };
    connectProxySocket(this.proxyUrl, (connectErr, proxySocket) => {
      if (connectErr) {
        callback(connectErr);
        return;
      }
      writeConnectRequest(proxySocket, this.proxyUrl, target, (tunnelErr, tunnelSocket) => {
        if (tunnelErr) {
          callback(tunnelErr);
          return;
        }
        const secureSocket = tls.connect({
          socket: tunnelSocket,
          servername: target.servername,
        });
        secureSocket.once('secureConnect', () => callback(null, secureSocket));
        secureSocket.once('error', (err) => callback(err));
      });
    });
  }
}

export function createDiscordGatewayProxyAgent(options = {}) {
  const proxyUrl = resolveDiscordGatewayProxy(options);
  return proxyUrl ? new DiscordGatewayProxyAgent(proxyUrl) : undefined;
}

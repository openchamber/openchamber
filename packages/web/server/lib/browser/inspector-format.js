import { createScanner, SyntaxKind } from 'jsonc-parser';

const REDACTED = '[REDACTED]';
const BODY_LIMIT = 8000;
const sensitiveName = (name) => /auth|cookie|password|passwd|secret|token|credential|apikey|accesskey|privatekey|sessionid|signature|csrf|xsrf|^key$|^code$/i.test(name.replace(/[^a-z0-9]/gi, ''));

export function boundedString(value, maxChars, fallback = '') {
  try {
    return String.prototype.valueOf.call(value).slice(0, maxChars);
  } catch {
    return fallback;
  }
}

export function redactUrl(value, maxChars = 2048) {
  const source = boundedString(value, Infinity).trim().replace(/[\t\n\r]/g, '');
  if (!source) return '';
  try {
    const absolute = URL.canParse(source);
    const url = new URL(source, 'https://inspector.invalid');
    if (!url.host && !['file:', 'about:'].includes(url.protocol)) return `${url.protocol}[redacted]`.slice(0, maxChars);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveName(key)) url.searchParams.set(key, REDACTED);
    }
    if (url.hash.includes('=')) {
      const hash = url.hash.slice(1);
      const queryStart = hash.indexOf('?') + 1;
      const params = new URLSearchParams(hash.slice(queryStart));
      for (const key of [...params.keys()]) if (sensitiveName(key)) params.set(key, REDACTED);
      url.hash = hash.slice(0, queryStart) + params.toString();
    }
    const result = absolute ? url.href : /^[/\\]{2}/.test(source)
      ? url.href.slice(url.protocol.length) : source.split(/[?#]/, 1)[0] + url.search + url.hash;
    return result.slice(0, maxChars);
  } catch {
    return '[Invalid URL]'.slice(0, maxChars);
  }
}

const redactTextUrls = (text) => text.replace(/\b(?:https?|wss?|file):\/\/[^\s<>"']+/gi, (url) => redactUrl(url));

export function formatHeaders(headers) {
  const output = [];
  let truncated = false;
  if (headers == null || Object.getPrototypeOf(headers) !== Object.prototype) return { headers: output, truncated };
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (output.length === 64) { truncated = true; break; }
    const name = boundedString(rawName, 256);
    const rawText = boundedString(rawValue, Infinity);
    const value = sensitiveName(rawName) ? REDACTED
      : ['location', 'referer', 'content-location'].includes(rawName.toLowerCase()) ? redactUrl(rawText, Infinity) : redactTextUrls(rawText);
    truncated ||= name.length !== rawName.length || value.length > 1024;
    output.push({ name, value: value.slice(0, 1024) });
  }
  return { headers: output, truncated };
}

export function formatRemoteObject(remoteObject, maxChars = 4000) {
  const remote = remoteObject ?? {};
  let text = boundedString(remote.description, maxChars + 1, 'undefined');
  let truncated = false;
  if (remote.type === 'string') text = boundedString(remote.value, maxChars + 1, text);
  else if (remote.type === 'undefined') text = 'undefined';
  else if (remote.type === 'boolean') text = remote.value === true ? 'true' : 'false';
  else if (remote.type === 'number' || remote.type === 'bigint') {
    text = boundedString(remote.unserializableValue, maxChars + 1, Number.isFinite(remote.value) ? String(remote.value) : text);
  } else if (remote.subtype === 'null') text = 'null';
  else if (Array.isArray(remote.preview?.properties)) {
    const properties = remote.preview.properties.slice(0, 10).map((property) => {
      const name = boundedString(property?.name, 128);
      const value = sensitiveName(boundedString(property?.name, Infinity)) ? REDACTED : boundedString(property?.value, maxChars + 1, boundedString(property?.type, 64, 'object'));
      return `${name}: ${property?.type === 'string' && value !== REDACTED ? JSON.stringify(value) : value}`;
    });
    truncated = remote.preview.overflow === true || remote.preview.properties.length > 10;
    text = `${remote.subtype === 'array' ? '[' : '{'}${properties.join(', ')}${remote.subtype === 'array' ? ']' : '}'}`;
  }
  truncated ||= text.length > maxChars;
  text = redactTextUrls(text);
  return { text: text.slice(0, maxChars), truncated: truncated || text.length > maxChars };
}

export function formatConsoleEvent(method, params, id) {
  if (!['Runtime.consoleAPICalled', 'Runtime.exceptionThrown'].includes(method)) return null;
  const event = params ?? {};
  const exception = method === 'Runtime.exceptionThrown';
  const details = event.exceptionDetails ?? {};
  const frames = exception ? details.stackTrace?.callFrames : event.stackTrace?.callFrames;
  const frame = Array.isArray(frames) ? frames[0] : null;
  const args = Array.isArray(event.args) ? event.args : [];
  const parts = exception
    ? [formatRemoteObject(details.exception ?? { type: 'string', value: details.text })]
    : args.slice(0, 32).map((value) => formatRemoteObject(value));
  const text = parts.map((part) => part.text).join(' ');
  const levels = { debug: 'debug', info: 'info', warning: 'warning', warn: 'warning', error: 'error', assert: 'error' };
  const consoleType = boundedString(event.type, 64);
  const line = exception ? details.lineNumber ?? frame?.lineNumber : frame?.lineNumber;
  return {
    id: boundedString(id, 128), timestamp: Number.isFinite(event.timestamp) && event.timestamp >= 0 && event.timestamp <= 8.64e15 ? event.timestamp : Date.now(),
    level: exception ? 'error' : Object.hasOwn(levels, consoleType) ? levels[consoleType] : 'log',
    text: text.slice(0, 4000), source: redactUrl(exception ? details.url || frame?.url : frame?.url),
    line: Number.isInteger(line) && line >= 0 ? line : null,
    truncated: text.length > 4000 || parts.some((part) => part.truncated) || args.length > 32,
  };
}

function redactJsonBody(text) {
  const scanner = createScanner(text, true);
  let token = scanner.scan();
  let cursor = 0;
  let output = '';
  while (token !== SyntaxKind.EOF) {
    const sensitive = token === SyntaxKind.StringLiteral && sensitiveName(scanner.getTokenValue());
    token = scanner.scan();
    if (!sensitive || token !== SyntaxKind.ColonToken) continue;
    token = scanner.scan();
    const start = scanner.getTokenOffset();
    let depth = token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken ? 1 : 0;
    while (depth > 0 && token !== SyntaxKind.EOF) {
      token = scanner.scan();
      if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken) depth++;
      if (token === SyntaxKind.CloseBraceToken || token === SyntaxKind.CloseBracketToken) depth--;
    }
    output += text.slice(cursor, start) + JSON.stringify(REDACTED);
    cursor = scanner.getPosition();
    token = scanner.scan();
  }
  return output + text.slice(cursor);
}

export function normalizeBody(body, base64Encoded, mimeType) {
  const mime = boundedString(mimeType, 256).toLowerCase();
  const type = mime.split(';', 1)[0].trim();
  const unsupported = { text: null, truncated: false, supported: false };
  if (!/^text\/|^(?:application\/(?:json|javascript|x-javascript|xml|x-www-form-urlencoded)|[^/]+\/[^;]+\+(?:json|xml))$/.test(type)) return unsupported;
  if (/charset\s*=/.test(mime) && !/charset\s*=\s*["']?(?:utf-?8|us-ascii)(?:["';\s]|$)/.test(mime)) return unsupported;
  let text = boundedString(body, Infinity, null);
  if (text === null) return unsupported;
  let truncated = false;
  if (base64Encoded === true) {
    const prefix = text.slice(0, 42672);
    if (text.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(prefix)) return unsupported;
    try {
      truncated = text.length > prefix.length;
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(prefix, 'base64'), { stream: truncated });
    } catch {
      return unsupported;
    }
  }
  truncated ||= text.length > BODY_LIMIT;
  text = text.slice(0, BODY_LIMIT + 1);
  if (type.endsWith('json')) text = redactJsonBody(text);
  if (type === 'application/x-www-form-urlencoded') {
    text = text.split('&').map((part) => {
      const equals = part.indexOf('=');
      if (equals < 0) return part;
      const key = new URLSearchParams(part).keys().next().value;
      return sensitiveName(key) ? `${part.slice(0, equals + 1)}${encodeURIComponent(REDACTED)}` : part;
    }).join('&');
  }
  return { text: text.slice(0, BODY_LIMIT), truncated: truncated || text.length > BODY_LIMIT, supported: true };
}

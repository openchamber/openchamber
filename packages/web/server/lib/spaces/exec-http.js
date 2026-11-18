
import { SpaceError } from './errors.js';
import { IMAGE_CURL } from './layout.js';

const ERROR_TAIL_CHARACTERS = 2_000;

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_HEADER_LINES = 200;

export const EXEC_FAILED_CODES = [1, 125, 126, 127];
export const isFromCurl = (stderr) => String(stderr ?? '').trimStart().startsWith('curl:');

export const EXEC_INTERRUPTED_CODES = ['command_timeout', 'command_killed'];

export const tail = (text) => String(text ?? '').trim().slice(-ERROR_TAIL_CHARACTERS);

// external: https://curl.se/docs/manpage.html --disable must be first to skip curlrc; --noproxy disables environment proxies.
export const buildCurlArgs = (timeoutSeconds) => [
  IMAGE_CURL, '--disable', '--noproxy', '*', '--silent', '--show-error', '--include',
  '--max-time', String(timeoutSeconds), '--config', '-',
];

const quoteConfigValue = (value) => {
  const text = String(value);
  if (text.includes('\0')) {
    throw new SpaceError('invalid_request', 'A request to a container cannot hold a NUL character');
  }
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
};

export const buildCurlConfig = ({ url, method, headers = {}, body = null }) => [
  `url = ${quoteConfigValue(url)}`,
  `request = ${quoteConfigValue(method)}`,
  // external: https://curl.se/docs/manpage.html An empty Expect header suppresses the intermediate 100-continue response.
  'header = "Expect:"',
  ...Object.entries(headers).map(([name, value]) => `header = ${quoteConfigValue(`${name}: ${value}`)}`),
  // external: https://curl.se/docs/manpage.html --data-raw keeps a leading @ literal; --data-binary treats it as a file name.
  ...(body === null ? [] : [`data-raw = ${quoteConfigValue(body)}`]),
].join('\n');

export function parseResponse(output, unreadable) {
  const headerEnd = output.indexOf('\r\n\r\n');
  if (headerEnd > MAX_HEADER_BYTES) {
    throw unreadable(`answered with more than ${MAX_HEADER_BYTES} bytes of headers`);
  }
  const [statusLine, ...headerLines] = output.slice(0, Math.max(headerEnd, 0)).split('\r\n');
  const status = Number.parseInt(/^HTTP\/[\d.]+ (\d{3})/.exec(statusLine)?.[1] ?? '', 10);
  if (headerEnd < 0 || Number.isNaN(status)) {
    throw unreadable('answered with something that is not HTTP');
  }
  if (headerLines.length > MAX_HEADER_LINES) {
    throw unreadable(`answered with more than ${MAX_HEADER_LINES} header lines`);
  }
  const headers = Object.create(null);
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      const name = line.slice(0, colon).trim().toLowerCase();
      headers[name] ??= [];
      headers[name].push(line.slice(colon + 1).trim());
    }
  }
  return { status, headers, body: output.slice(headerEnd + 4) };
}

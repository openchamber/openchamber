
import { SpaceError } from './errors.js';
import { IMAGE_CURL } from './layout.js';

const ERROR_TAIL_CHARACTERS = 2_000;

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_HEADER_LINES = 200;

export const EXEC_FAILED_CODES = [1, 125, 126, 127];
export const isFromCurl = (stderr: string | null | undefined) => String(stderr ?? '').trimStart().startsWith('curl:');

export const EXEC_INTERRUPTED_CODES = ['command_timeout', 'command_killed'];

export const tail = (text: string | null | undefined) => String(text ?? '').trim().slice(-ERROR_TAIL_CHARACTERS);

export const buildCurlArgs = (timeoutSeconds: number) => [
  IMAGE_CURL, '--disable', '--noproxy', '*', '--silent', '--show-error', '--include',
  '--max-time', String(timeoutSeconds), '--config', '-',
];

const quoteConfigValue = (value: string) => {
  const text = String(value);
  if (text.includes('\0')) {
    throw new SpaceError('invalid_request', 'A request to a container cannot hold a NUL character');
  }
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
};

export interface CurlRequest {
  url: string;
  method: string;
  headers?: Readonly<Record<string, string>>;
  body?: string | null;
}

export interface ExecHttpResponse {
  status: number;
  headers: Record<string, string[]>;
  body: string;
}

export const buildCurlConfig = ({ url, method, headers = {}, body = null }: CurlRequest) => [
  `url = ${quoteConfigValue(url)}`,
  `request = ${quoteConfigValue(method)}`,
  'header = "Expect:"',
  ...Object.entries(headers).map(([name, value]) => `header = ${quoteConfigValue(`${name}: ${value}`)}`),
  ...(body === null ? [] : [`data-raw = ${quoteConfigValue(body)}`]),
].join('\n');

export function parseResponse(output: string, unreadable: (why: string) => Error): ExecHttpResponse {
  const headerEnd = output.indexOf('\r\n\r\n');
  if (headerEnd > MAX_HEADER_BYTES) {
    throw unreadable(`answered with more than ${MAX_HEADER_BYTES} bytes of headers`);
  }
  const [statusLine = '', ...headerLines] = output.slice(0, Math.max(headerEnd, 0)).split('\r\n');
  const status = Number.parseInt(/^HTTP\/[\d.]+ (\d{3})/.exec(statusLine)?.[1] ?? '', 10);
  if (headerEnd < 0 || Number.isNaN(status)) {
    throw unreadable('answered with something that is not HTTP');
  }
  if (headerLines.length > MAX_HEADER_LINES) {
    throw unreadable(`answered with more than ${MAX_HEADER_LINES} header lines`);
  }
  const headers: Record<string, string[]> = Object.create(null);
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

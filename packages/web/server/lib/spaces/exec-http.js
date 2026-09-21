// One HTTP request inside a container, over `exec` and nothing else, so that it works for every
// place. The two channels written on top of this, `space-server.js` and `gatekeeper-channel.js`,
// share these pieces: the curl argv, the request as a curl config, and the answer parser.
//
// Everything that comes back is untrusted. What listens on the port inside can be agent code.

import { SpaceError } from './errors.js';
import { IMAGE_CURL } from './layout.js';

// How much text from inside a container an error message may carry.
const ERROR_TAIL_CHARACTERS = 2_000;

// How much of an answer's header block the host is willing to parse. A real answer is about 1 KB.
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_HEADER_LINES = 200;

// Exit codes of a `docker exec` that failed by itself: no such container, container not running,
// curl missing. curl uses 1 too. Measured with curl 7.88.1: a listener that answers `hello` gives
// exit code 1 and `curl: (1) Received HTTP/0.9 when not allowed`. curl starts every error line
// with `curl:`, so one of these codes means "exec failed" only when stderr does not start like that.
export const EXEC_FAILED_CODES = [1, 125, 126, 127];
export const isFromCurl = (stderr) => String(stderr ?? '').trimStart().startsWith('curl:');

// The CLI of an exec was killed. For a request that says something about the inside, not about a Docker step.
export const EXEC_INTERRUPTED_CODES = ['command_timeout', 'command_killed'];

export const tail = (text) => String(text ?? '').trim().slice(-ERROR_TAIL_CHARACTERS);

/**
 * The curl arguments. `--disable` must stay first: it is what keeps curl away from the
 * `~/.curlrc` of the user inside, which the agent can write. `--noproxy '*'` must stay too:
 * a space has proxy variables in its environment, and measured with curl 7.88.1, curl sends
 * even a request to 127.0.0.1 to that proxy without it.
 */
export const buildCurlArgs = (timeoutSeconds) => [
  IMAGE_CURL, '--disable', '--noproxy', '*', '--silent', '--show-error', '--include',
  '--max-time', String(timeoutSeconds), '--config', '-',
];

// A quoted value in a curl config file. Backslash escapes are the only special syntax inside the quotes.
const quoteConfigValue = (value) => {
  const text = String(value);
  if (text.includes('\0')) {
    throw new SpaceError('invalid_request', 'A request to a container cannot hold a NUL character');
  }
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
};

/**
 * The whole request as a curl config for stdin. A cookie, a token or a grant's secret in it
 * therefore shows up in no argument list, on the host or inside the container.
 */
export const buildCurlConfig = ({ url, method, headers = {}, body = null }) => [
  `url = ${quoteConfigValue(url)}`,
  `request = ${quoteConfigValue(method)}`,
  // Without this curl asks "Expect: 100-continue" for a large body and the answer gets two header blocks.
  'header = "Expect:"',
  ...Object.entries(headers).map(([name, value]) => `header = ${quoteConfigValue(`${name}: ${value}`)}`),
  // `data-raw`, because `data-binary` reads a body that starts with `@` as a file name.
  ...(body === null ? [] : [`data-raw = ${quoteConfigValue(body)}`]),
].join('\n');

/**
 * The answer of whatever listens on the port. `unreadable(why)` makes the error of the calling
 * channel, so each one keeps its own code and its own words.
 *
 * Header names go into an object without a prototype, so `__proto__` or `constructor` is one more name.
 */
export function parseResponse(output, unreadable) {
  const headerEnd = output.indexOf('\r\n\r\n');
  // The cap comes before any work on the header block, so a huge block costs the host nothing.
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
      // Pushed, not copied: a copy per line is quadratic in the lines that the inside chooses to send.
      headers[name] ??= [];
      headers[name].push(line.slice(colon + 1).trim());
    }
  }
  return { status, headers, body: output.slice(headerEnd + 4) };
}

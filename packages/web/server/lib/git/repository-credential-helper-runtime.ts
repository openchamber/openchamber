import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import type { JsonValue } from '../shared/json-values.js';

const MAX_BYTES = 64 * 1024;

function parseUrl<Value extends JsonValue | undefined>(value: Value): URL;
function parseUrl(value: string) { return new URL(value); }

function requestEndpoint<Value extends JsonValue | undefined>(value: Value, options: http.RequestOptions): http.ClientRequest;
function requestEndpoint(value: string, options: http.RequestOptions) {
  return http.request(value, options);
}

const delegate = (query: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_CONFIG_') || name === 'GIT_DIR' || name === 'GIT_WORK_TREE') delete env[name];
  }
  const child = spawn('git', ['credential', 'fill'], {
    cwd: os.tmpdir(), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  child.once('error', () => process.exit(0));
  child.stdout.pipe(process.stdout);
  child.stdin.end(query);
  child.once('close', () => process.exit(0));
};

const readQuery = async () => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BYTES) process.exit(0);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const [endpointFile, operation] = process.argv.slice(2);
if (!endpointFile || operation !== 'get') process.exit(0);
const query = await readQuery();

interface EndpointFields {
  url?: JsonValue;
  version?: JsonValue;
  secret?: JsonValue;
}
let endpoint: EndpointFields;
try {
  const candidate: EndpointFields = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
  const url = parseUrl(candidate.url);
  if (candidate.version !== 1 || url.protocol !== 'http:' || !String(candidate.secret ?? '')) throw new Error('invalid');
  endpoint = candidate;
} catch {
  delegate(query);
  endpoint = await new Promise<never>(() => {});
}

const request = requestEndpoint(endpoint.url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.secret}` },
  timeout: 10_000,
});
request.on('timeout', () => request.destroy(new Error('timeout')));
request.on('response', (response) => {
  if (response.statusCode !== 200 || response.headers.location) { delegate(query); return; }
  const chunks: Buffer[] = [];
  let size = 0;
  response.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BYTES) request.destroy();
    else chunks.push(chunk);
  });
  response.on('end', () => {
    let answer: { mode?: JsonValue; username?: JsonValue; password?: JsonValue } | null;
    try { answer = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { delegate(query); return; }
    if (answer?.mode === 'managed' && answer.username && answer.password) {
      process.stdout.write(`username=${answer.username}\npassword=${answer.password}\n\n`);
    } else if (answer?.mode === 'system') {
      delegate(query);
    } else {
      process.exit(0);
    }
  });
});
request.on('error', () => delegate(query));
request.end(JSON.stringify({ query, cwd: process.cwd() }));

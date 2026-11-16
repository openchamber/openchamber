import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';

const MAX_BYTES = 64 * 1024;


const delegate = (query) => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
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
  const chunks = [];
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

let endpoint;
try {
  endpoint = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
  const url = new URL(endpoint.url);
  if (endpoint.version !== 1 || url.protocol !== 'http:' || !String(endpoint.secret ?? '')) throw new Error('invalid');
} catch {
  delegate(query);
  await new Promise(() => {});
}

const request = http.request(endpoint.url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.secret}` },
  timeout: 10_000,
});
request.on('timeout', () => request.destroy(new Error('timeout')));
request.on('response', (response) => {
  if (response.statusCode !== 200 || response.headers.location) { delegate(query); return; }
  const chunks = [];
  let size = 0;
  response.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BYTES) request.destroy();
    else chunks.push(chunk);
  });
  response.on('end', () => {
    let answer;
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

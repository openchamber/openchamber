import http from 'node:http';
import { spawn } from 'node:child_process';

const MAX_BYTES = 64 * 1024;

/**
 * Answering nothing is how this helper stays out of the way. Git then falls
 * through to whatever else is configured, so a repository OpenChamber knows
 * nothing about behaves exactly as it did before.
 */
const silence = () => process.exit(0);

if (process.argv[2] !== 'get') silence();

const url = process.env.OPENCHAMBER_GIT_CREDENTIAL_URL;
const token = process.env.OPENCHAMBER_GIT_CREDENTIAL_TOKEN;
if (!url || !token) silence();

let target;
try {
  target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') silence();
} catch {
  silence();
}

const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > MAX_BYTES) silence();
  chunks.push(chunk);
}
const query = Buffer.concat(chunks).toString('utf8');

/**
 * The person's own credential chain, asked without this helper in it.
 *
 * A repository bound to System Git is one they decided may use whatever the
 * machine holds, so that decision has to keep working inside the agent's shell.
 * Dropping OPENCHAMBER_GIT_CREDENTIAL_* and the GIT_CONFIG_* entries that name
 * this helper is what keeps the child from calling back into here.
 */
const delegate = () => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const name of Object.keys(env)) {
    if (name.startsWith('OPENCHAMBER_GIT_CREDENTIAL_') || name.startsWith('GIT_CONFIG_')) delete env[name];
  }
  const child = spawn('git', ['credential', 'fill'], {
    env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  child.once('error', () => process.exit(0));
  child.stdout.pipe(process.stdout);
  child.stdin.end(query);
  child.once('close', (code) => process.exit(Number.isInteger(code) ? code : 0));
};

const request = http.request(target, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  },
});
request.on('response', (response) => {
  if (response.statusCode !== 200 || response.headers.location) silence();
  const responseChunks = [];
  let responseSize = 0;
  response.on('data', (chunk) => {
    responseSize += chunk.length;
    if (responseSize > MAX_BYTES) request.destroy();
    else responseChunks.push(chunk);
  });
  response.on('end', () => {
    let answer;
    try { answer = JSON.parse(Buffer.concat(responseChunks).toString('utf8')); }
    catch { silence(); }
    if (answer?.mode === 'system') delegate();
    else if (answer?.mode === 'managed' && answer.username && answer.password) {
      process.stdout.write(`username=${answer.username}\npassword=${answer.password}\n\n`);
    } else silence();
  });
});
request.on('error', () => silence());
request.end(JSON.stringify({ query, cwd: process.cwd() }));

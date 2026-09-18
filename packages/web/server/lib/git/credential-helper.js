import http from 'node:http';

const MAX_INPUT_BYTES = 64 * 1024;

const [brokerUrl, nonce, operation] = process.argv.slice(2);
if (!brokerUrl || !nonce || operation !== 'get') process.exit(0);

const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > MAX_INPUT_BYTES) process.exit(1);
  chunks.push(chunk);
}

let target;
try {
  target = new URL(brokerUrl);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') process.exit(1);
} catch {
  process.exit(1);
}

const request = http.request(target, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-git-credential',
    'content-length': size,
    'x-openchamber-git-nonce': nonce,
    'x-openchamber-git-operation': operation,
  },
});
request.on('response', (response) => {
  const responseChunks = [];
  let responseSize = 0;
  if (response.statusCode !== 200 || response.headers.location) process.exit(1);
  response.on('data', (chunk) => {
    responseSize += chunk.length;
    if (responseSize > MAX_INPUT_BYTES) request.destroy();
    else responseChunks.push(chunk);
  });
  response.on('end', () => {
    process.stdout.write(Buffer.concat(responseChunks));
  });
});
request.on('error', () => process.exit(1));
request.end(Buffer.concat(chunks));

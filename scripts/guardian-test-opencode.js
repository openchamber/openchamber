#!/usr/bin/env node

import http from 'node:http';

import {
  createManagedOpenCodeHealthProof,
  MANAGED_OPENCODE_HEALTH_CHALLENGE_HEADER,
  MANAGED_OPENCODE_HEALTH_INCARNATION_HEADER,
  MANAGED_OPENCODE_HEALTH_LAUNCH_FINGERPRINT_HEADER,
  MANAGED_OPENCODE_HEALTH_OWNER_HEADER,
  MANAGED_OPENCODE_HEALTH_PORT_HEADER,
  MANAGED_OPENCODE_HEALTH_PROOF_HEADER,
  MANAGED_OPENCODE_HEALTH_RUNTIME_HEADER,
  verifyManagedOpenCodeHealthProof,
} from '../packages/web/server/lib/guardian/health-proof.js';

const readFlag = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const hostname = readFlag('--hostname') || '127.0.0.1';
const port = Number.parseInt(readFlag('--port') || '', 10);
const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || 'opencode';
const password = process.env.OPENCODE_SERVER_PASSWORD?.trim() || '';
const pendingHealthProofs = new WeakMap();

if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
  process.stderr.write('guardian test OpenCode requires a valid --port\n');
  process.exit(2);
}

const server = http.createServer((request, response) => {
  if (request.url === '/global/health') {
    const challenge = request.headers[MANAGED_OPENCODE_HEALTH_CHALLENGE_HEADER.toLowerCase()];
    if (challenge && !request.headers.authorization) {
      let proof;
      try {
        const proofInput = {
          password,
          challenge,
          incarnation: request.headers[MANAGED_OPENCODE_HEALTH_INCARNATION_HEADER.toLowerCase()],
          ownerInstanceId: request.headers[MANAGED_OPENCODE_HEALTH_OWNER_HEADER.toLowerCase()],
          runtimeIdentity: request.headers[MANAGED_OPENCODE_HEALTH_RUNTIME_HEADER.toLowerCase()],
          launchFingerprint: request.headers[MANAGED_OPENCODE_HEALTH_LAUNCH_FINGERPRINT_HEADER.toLowerCase()],
          port: Number.parseInt(request.headers[MANAGED_OPENCODE_HEALTH_PORT_HEADER.toLowerCase()] || '', 10),
        };
        proof = createManagedOpenCodeHealthProof(proofInput);
        pendingHealthProofs.set(request.socket, { proofInput, proof });
      } catch {
        response.writeHead(401);
        response.end();
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        [MANAGED_OPENCODE_HEALTH_PROOF_HEADER]: proof,
      });
      response.end(JSON.stringify({ healthy: true }));
      return;
    }

    if (password) {
      const pending = pendingHealthProofs.get(request.socket);
      const proof = request.headers[MANAGED_OPENCODE_HEALTH_PROOF_HEADER.toLowerCase()];
      const sameTuple = pending
        && request.headers[MANAGED_OPENCODE_HEALTH_CHALLENGE_HEADER.toLowerCase()] === pending.proofInput.challenge
        && request.headers[MANAGED_OPENCODE_HEALTH_INCARNATION_HEADER.toLowerCase()] === pending.proofInput.incarnation
        && request.headers[MANAGED_OPENCODE_HEALTH_OWNER_HEADER.toLowerCase()] === pending.proofInput.ownerInstanceId
        && request.headers[MANAGED_OPENCODE_HEALTH_RUNTIME_HEADER.toLowerCase()] === pending.proofInput.runtimeIdentity
        && request.headers[MANAGED_OPENCODE_HEALTH_LAUNCH_FINGERPRINT_HEADER.toLowerCase()] === pending.proofInput.launchFingerprint
        && Number.parseInt(request.headers[MANAGED_OPENCODE_HEALTH_PORT_HEADER.toLowerCase()] || '', 10) === pending.proofInput.port;
      if (!pending
        || !sameTuple
        || proof !== pending.proof
        || !verifyManagedOpenCodeHealthProof(pending.proofInput, proof)) {
        response.writeHead(401);
        response.end();
        return;
      }
      const encoded = Buffer.from(`${username}:${password}`, 'utf8');
      const expectedAuthorization = `Basic ${encoded.toString('base64')}`;
      encoded.fill(0);
      if (request.headers.authorization !== expectedAuthorization) {
        response.writeHead(401);
        response.end();
        return;
      }
      pendingHealthProofs.delete(request.socket);
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ healthy: true }));
    return;
  }
  response.writeHead(404);
  response.end();
});

const close = () => {
  server.close(() => process.exit(0));
};

process.once('SIGTERM', close);
process.once('SIGINT', close);

server.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});

server.listen(port, hostname, () => {
  process.stdout.write(`opencode server listening on http://${hostname}:${port}\n`);
});

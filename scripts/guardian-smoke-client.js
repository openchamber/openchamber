#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const protocol = 'openchamber-guardian-ipc-v1';

const readFlag = (name, fallback = undefined) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const socketPath = readFlag('--socket-path');
const portPath = readFlag('--port-path');
const secretPath = readFlag('--secret-path');
const fixturePath = path.resolve(readFlag('--fixture'));
const cwd = path.resolve(readFlag('--cwd', process.cwd()));

if ((!socketPath && !portPath) || !secretPath || !fixturePath) {
  throw new Error('guardian smoke client requires --socket-path or --port-path, --secret-path, and --fixture');
}

const encode = (value) => Buffer.from(value).toString('base64url');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();

const readWindowsPort = () => {
  const value = fs.readFileSync(portPath, 'utf8').trim();
  const match = value.match(/^127\.0\.0\.1:(\d+)$/);
  if (!match) throw new Error(`invalid guardian discovery file: ${value}`);
  return Number.parseInt(match[1], 10);
};

const createConnection = async () => {
  const socket = portPath
    ? net.createConnection({ host: '127.0.0.1', port: readWindowsPort() })
    : net.createConnection(socketPath);

  await new Promise((resolve, reject) => {
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });

  let buffer = '';
  const lines = [];
  const waiters = [];
  let closedError = null;
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        closedError = new Error(`invalid guardian response: ${error.message}`);
        continue;
      }
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(parsed);
      else lines.push(parsed);
    }
  });
  socket.on('close', () => {
    closedError ||= new Error('guardian connection closed');
    while (waiters.length > 0) waiters.shift().reject(closedError);
  });
  socket.on('error', (error) => {
    closedError ||= error;
    while (waiters.length > 0) waiters.shift().reject(closedError);
  });

  const next = () => {
    if (lines.length > 0) return Promise.resolve(lines.shift());
    if (closedError) return Promise.reject(closedError);
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };

  return {
    socket,
    next,
    send(value) {
      socket.write(`${JSON.stringify(value)}\n`);
    },
    close() {
      socket.destroy();
    },
  };
};

const expectError = async (connection, expectedCode) => {
  const response = await connection.next();
  if (response?.error?.code !== expectedCode) {
    throw new Error(`expected guardian error ${expectedCode}, got ${JSON.stringify(response)}`);
  }
};

const assertUnauthenticatedDispatch = async () => {
  for (const method of ['list', 'spawn', 'stop', 'shutdown']) {
    const connection = await createConnection();
    try {
      const challenge = await connection.next();
      if (challenge?.type !== 'challenge') throw new Error('guardian did not send a challenge');
      connection.send({ id: `smoke-unauth-${method}`, method, params: {} });
      await expectError(connection, 'authentication_required');
    } finally {
      connection.close();
    }
  }
};

const connectAuthenticated = async (secret) => {
  const connection = await createConnection();
  const challenge = await connection.next();
  if (challenge?.type !== 'challenge') throw new Error('guardian did not send a challenge');
  const clientNonce = encode(crypto.randomBytes(32));
  const proof = encode(hmac(secret, `${protocol}\0handshake\0${challenge.challenge}\0${clientNonce}`));
  connection.send({
    id: 'smoke-handshake',
    method: 'handshake',
    params: { clientNonce, proof },
  });
  const handshake = await connection.next();
  if (handshake?.result?.authenticated !== true) {
    throw new Error(`guardian authentication failed: ${JSON.stringify(handshake)}`);
  }
  return {
    ...connection,
    sessionKey: hmac(secret, `${protocol}\0session\0${challenge.challenge}\0${clientNonce}`),
    sequence: 0,
  };
};

const main = async () => {
  const secret = fs.readFileSync(secretPath);
  const owner = {
    ownerInstanceId: 'guardian-smoke-owner',
    runtimeIdentity: 'guardian-smoke-runtime',
  };
  let connection;
  try {
    await assertUnauthenticatedDispatch();
    connection = await connectAuthenticated(secret);

    const request = (id, method, params = {}, { increment = true, mac = undefined, sequence = connection.sequence } = {}) => {
      const auth = {
        sequence,
        mac: mac || encode(hmac(
          connection.sessionKey,
          JSON.stringify([protocol, sequence, id, method, params]),
        )),
      };
      connection.send({ id, method, params, auth });
      return connection.next().then((response) => {
        if (increment) connection.sequence += 1;
        return response;
      });
    };

    const badMac = encode(crypto.randomBytes(32));
    const badMacResponse = await request('smoke-bad-mac', 'list', {}, { increment: false, mac: badMac });
    if (badMacResponse?.error?.code !== 'authentication_failed') {
      throw new Error(`expected bad-MAC rejection, got ${JSON.stringify(badMacResponse)}`);
    }

    const listRequest = {
      id: 'smoke-list',
      method: 'list',
      params: {},
      auth: {
        sequence: connection.sequence,
        mac: encode(hmac(connection.sessionKey, JSON.stringify([
          protocol,
          connection.sequence,
          'smoke-list',
          'list',
          {},
        ]))),
      },
    };
    connection.send(listRequest);
    const initialList = await connection.next();
    if (!Array.isArray(initialList?.result) || initialList.result.length !== 0) {
      throw new Error(`expected empty guardian list, got ${JSON.stringify(initialList)}`);
    }
    connection.sequence += 1;
    connection.send(listRequest);
    await expectError(connection, 'replay_detected');

    const childPort = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const selected = address && typeof address === 'object' ? address.port : 0;
        server.close(() => resolve(selected));
      });
    });
    const launchSpec = {
      binary: process.execPath,
      args: [fixturePath],
      hostname: '127.0.0.1',
      port: childPort,
      cwd,
    };
    const launchFingerprint = crypto.createHash('sha256')
      .update(JSON.stringify([
        launchSpec.binary,
        launchSpec.args,
        launchSpec.hostname,
        launchSpec.port,
        launchSpec.cwd,
      ]))
      .digest('base64url');
    const spawnResponse = await request('smoke-spawn', 'spawn', {
      ...launchSpec,
      env: {
        OPENCODE_SERVER_USERNAME: 'smoke-user',
        OPENCODE_SERVER_PASSWORD: 'smoke-password',
      },
      owner: { ...owner, launchFingerprint },
      launchSpec,
    });
    if (spawnResponse?.error || !spawnResponse?.result?.incarnation) {
      throw new Error(`guardian child spawn failed: ${JSON.stringify(spawnResponse)}`);
    }
    const child = spawnResponse.result;

    const health = await request('smoke-health', 'health', {
      incarnation: child.incarnation,
      owner: { ...owner, launchFingerprint },
    });
    if (health?.error || health?.result?.healthy !== true) {
      throw new Error(`managed child health failed: ${JSON.stringify(health)}`);
    }
    const activeList = await request('smoke-active-list', 'list');
    if (
      activeList?.error
      || !Array.isArray(activeList.result)
      || activeList.result.length !== 1
      || activeList.result[0].ownerInstanceId !== owner.ownerInstanceId
      || activeList.result[0].runtimeIdentity !== owner.runtimeIdentity
    ) {
      throw new Error(`expected one owner-scoped active child, got ${JSON.stringify(activeList)}`);
    }

    const wrongOwnerStop = await request('smoke-wrong-owner-stop', 'stop', {
      incarnation: child.incarnation,
      owner: { ownerInstanceId: 'wrong-owner', runtimeIdentity: owner.runtimeIdentity, launchFingerprint },
    });
    if (!/ownership identity does not match/.test(wrongOwnerStop?.error?.message || '')) {
      throw new Error(`expected wrong-owner stop rejection, got ${JSON.stringify(wrongOwnerStop)}`);
    }

    const stopResponse = await request('smoke-stop', 'stop', {
      incarnation: child.incarnation,
      owner: { ...owner, launchFingerprint },
    });
    if (stopResponse?.error) throw new Error(`managed child stop failed: ${JSON.stringify(stopResponse)}`);
    const emptyList = await request('smoke-empty-list', 'list');
    if (emptyList?.error || !Array.isArray(emptyList.result) || emptyList.result.length !== 0) {
      throw new Error(`expected empty list after child stop, got ${JSON.stringify(emptyList)}`);
    }

    const shutdown = await request('smoke-shutdown', 'shutdown');
    if (shutdown?.error || shutdown?.result?.acknowledged !== true) {
      throw new Error(`guardian shutdown was not acknowledged: ${JSON.stringify(shutdown)}`);
    }
  } finally {
    secret.fill(0);
    connection?.sessionKey?.fill(0);
    connection?.close();
  }
};

main().catch((error) => {
  process.stderr.write(`fail: ${error?.message || String(error)}\n`);
  process.exitCode = 1;
});

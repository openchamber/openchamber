import net from 'node:net';

/** One request, one answer, bounded even if a broken listener never closes. */
export function adminRequest(socketPath, frame) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('admin socket request timed out'));
    }, 20_000);
    socket.once('connect', () => socket.write(`${JSON.stringify(frame)}\n`));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('close', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
    });
  });
}

export function createAdminSocketClient(socketPath) {
  const request = (frame) => adminRequest(socketPath, frame);
  return {
    list: () => request({ type: 'list' }),
    get: (id) => request({ type: 'get', id }),
    apply: (operation) => request({ type: 'apply', operation }),
    create: (definition, secrets) => request({ type: 'apply', operation: { kind: 'create', definition, secrets } }),
    update: (id, expectedRevision, definition, secrets) => request({ type: 'apply', operation: { kind: 'update', id, expectedRevision, definition, secrets } }),
    oauthStart: (id, expectedRevision, redirectUri) => request({ type: 'oauth-start', id, expectedRevision, redirectUri }),
    oauthComplete: (fields) => request({ type: 'oauth-complete', ...fields }),
    oauthAttempt: (attempt) => request({ type: 'oauth-attempt', attempt }),
  };
}

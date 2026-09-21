import net from 'node:net';
import { randomUUID } from 'node:crypto';

const CONNECTION_READY_TIMEOUT_MS = 15_000;

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject);
    const address = server.address();
    const port = Number(address?.port);
    if (!Number.isInteger(port) || port <= 0) {
      reject(new Error('Failed to bind a local relay tunnel port'));
      return;
    }
    resolve(port);
  });
});

const messageData = (event) => {
  if (event?.type === 'ready' || event?.type === 'data' || event?.type === 'close') return event;
  return event?.data ?? null;
};

export const createRelayDevTunnelBridge = ({ createMessageChannel, logger = console } = {}) => {
  const tunnels = new Map();

  const closeTunnel = (key) => {
    const tunnel = tunnels.get(key);
    if (!tunnel) return false;
    tunnels.delete(key);
    for (const connection of tunnel.connections.values()) connection.close();
    try { tunnel.server.close(); } catch { /* already closing */ }
    return true;
  };

  return {
    async open({ targetKey, remotePort, webContents }) {
      const port = Number.parseInt(String(remotePort), 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('A valid remote port is required');
      if (!targetKey) throw new Error('A relay target key is required');
      if (!webContents || webContents.isDestroyed?.()) throw new Error('The desktop window is unavailable');

      const key = `${webContents.id}|${targetKey}|${port}`;
      const existing = tunnels.get(key);
      if (existing) return { localPort: existing.localPort, reused: true };

      const connections = new Map();
      const server = net.createServer((socket) => {
        socket.setNoDelay(true);
        socket.pause();
        const connectionId = randomUUID();
        const { port1, port2 } = createMessageChannel();
        let closed = false;
        const readyTimer = setTimeout(() => close(), CONNECTION_READY_TIMEOUT_MS);

        const close = () => {
          if (closed) return;
          closed = true;
          clearTimeout(readyTimer);
          connections.delete(connectionId);
          try { port1.postMessage({ type: 'close' }); } catch { /* already closed */ }
          try { socket.destroy(); } catch { /* already closed */ }
          try { port1.close(); } catch { /* already closed */ }
        };
        connections.set(connectionId, { close });

        port1.on('message', (event) => {
          const message = messageData(event);
          if (!message) return;
          if (message.type === 'ready') {
            clearTimeout(readyTimer);
            socket.resume();
            return;
          }
          if (message.type === 'data' && message.data) {
            socket.write(Buffer.from(message.data));
            return;
          }
          if (message.type === 'close') close();
        });
        port1.on('close', close);
        port1.start?.();

        socket.on('data', (chunk) => {
          if (closed) return;
          port1.postMessage({ type: 'data', data: Uint8Array.from(chunk) });
        });
        socket.on('error', close);
        socket.on('close', close);

        try {
          webContents.postMessage('openchamber:relay-dev-tunnel-connect', { connectionId, remotePort: port }, [port2]);
        } catch (error) {
          logger.warn?.(`[dev-tunnel] failed to hand relay connection to renderer: ${error?.message || error}`);
          close();
        }
      });

      const localPort = await listen(server);
      server.on('error', (error) => logger.warn?.(`[dev-tunnel] relay listener failed: ${error?.message || error}`));
      tunnels.set(key, { server, connections, localPort });
      webContents.once?.('destroyed', () => closeTunnel(key));
      return { localPort, reused: false };
    },

    closeAll() {
      for (const key of [...tunnels.keys()]) closeTunnel(key);
    },

    closeForWebContents(webContentsId) {
      let closed = 0;
      const prefix = `${webContentsId}|`;
      for (const key of [...tunnels.keys()]) {
        if (!key.startsWith(prefix)) continue;
        if (closeTunnel(key)) closed += 1;
      }
      return closed;
    },
  };
};

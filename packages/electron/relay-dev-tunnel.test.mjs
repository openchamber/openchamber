import { afterEach, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { MessageChannel } from 'node:worker_threads';
import { createRelayDevTunnelBridge } from './relay-dev-tunnel.mjs';

const bridges = [];

afterEach(() => {
  while (bridges.length) bridges.pop().closeAll();
});

describe('relay dev tunnel bridge', () => {
  test('pipes a local browser connection through a renderer-owned message port', async () => {
    let nextPort;
    const webContents = {
      id: 7,
      isDestroyed: () => false,
      once: () => {},
      postMessage: (_channel, payload, ports) => {
        nextPort = ports[0];
        nextPort.on('message', (message) => {
          if (message.type !== 'data') return;
          expect(Buffer.from(message.data).toString()).toContain('GET /docs HTTP/1.1');
          nextPort.postMessage({ type: 'data', data: Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok') });
          nextPort.postMessage({ type: 'close' });
        });
        nextPort.start();
        expect(payload.remotePort).toBe(4322);
        nextPort.postMessage({ type: 'ready' });
      },
    };
    const bridge = createRelayDevTunnelBridge({ createMessageChannel: () => new MessageChannel(), logger: { warn: () => {} } });
    bridges.push(bridge);
    const { localPort } = await bridge.open({ targetKey: 'host:exe', remotePort: 4322, webContents });

    const response = await new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: localPort }, () => socket.write('GET /docs HTTP/1.1\r\nHost: localhost\r\n\r\n'));
      let data = '';
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('close', () => resolve(data));
      socket.on('error', reject);
    });
    expect(response).toContain('\r\n\r\nok');
  });

  test('reuses one local listener for the same window, runtime, and port', async () => {
    const webContents = { id: 9, isDestroyed: () => false, once: () => {}, postMessage: () => {} };
    const bridge = createRelayDevTunnelBridge({ createMessageChannel: () => new MessageChannel() });
    bridges.push(bridge);
    const first = await bridge.open({ targetKey: 'host:exe', remotePort: 4322, webContents });
    const second = await bridge.open({ targetKey: 'host:exe', remotePort: 4322, webContents });
    expect(second).toEqual({ localPort: first.localPort, reused: true });
  });

  test('tells the renderer when the local browser connection closes', async () => {
    const rendererClosed = new Promise((resolve) => {
      const webContents = {
        id: 11,
        isDestroyed: () => false,
        once: () => {},
        postMessage: (_channel, _payload, ports) => {
          const rendererPort = ports[0];
          rendererPort.on('message', (message) => {
            if (message.type === 'close') resolve();
          });
          rendererPort.start();
          rendererPort.postMessage({ type: 'ready' });
        },
      };
      const bridge = createRelayDevTunnelBridge({ createMessageChannel: () => new MessageChannel() });
      bridges.push(bridge);
      void bridge.open({ targetKey: 'host:exe', remotePort: 4322, webContents }).then(({ localPort }) => {
        const socket = net.connect({ host: '127.0.0.1', port: localPort }, () => socket.destroy());
      });
    });

    await rendererClosed;
  });

  test('closes only listeners owned by the requested desktop window', async () => {
    const bridge = createRelayDevTunnelBridge({ createMessageChannel: () => new MessageChannel() });
    bridges.push(bridge);
    const windowOne = { id: 21, isDestroyed: () => false, once: () => {}, postMessage: () => {} };
    const windowTwo = { id: 22, isDestroyed: () => false, once: () => {}, postMessage: () => {} };
    const first = await bridge.open({ targetKey: 'host:one', remotePort: 4322, webContents: windowOne });
    const second = await bridge.open({ targetKey: 'host:two', remotePort: 4322, webContents: windowTwo });

    expect(bridge.closeForWebContents(windowOne.id)).toBe(1);
    await expect(new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: first.localPort }, resolve);
      socket.on('error', reject);
    })).rejects.toThrow();
    const remaining = await bridge.open({ targetKey: 'host:two', remotePort: 4322, webContents: windowTwo });
    expect(remaining).toEqual({ localPort: second.localPort, reused: true });
  });
});

import { describe, expect, test } from 'bun:test';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { startRelayHost } from './host-client.js';
import { generateEcdhKeyPair, exportPublicKeyJwk } from './e2ee.js';
import { createRelayTunnelClient } from '../../../../ui/src/lib/relay/tunnel-client.ts';

const waitFor = async predicate => {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('test condition timed out');
};

async function exercise({ clientFlow = true, hostFlow = true, batch = true, cancel = false, websocket = false } = {}) {
  const total = 512 * 1024;
  const content = Buffer.alloc(total, 'a');
  content.fill('b', total / 2);
  const upstream = http.createServer((req, res) => {
    // HTTP bearer ownership is unchanged by flow control.
    if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401); res.end(); return; }
    res.end(req.url === '/health' ? 'ok' : content);
  });
  const upstreamWs = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (req, socket, head) => {
    // Mirror the real URL-token and loopback-origin gates for tunneled WS.
    const query = new URL(req.url, 'http://localhost');
    if (query.searchParams.get('oc_url_token') !== 'fixture-url-token' || req.headers.origin !== `http://127.0.0.1:${upstream.address().port}`) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    upstreamWs.handleUpgrade(req, socket, head, ws => {
      ws.send(content.subarray(0, total / 2));
      ws.send(content.subarray(total / 2));
      // Let Bun finish the local write turn, then close while the throttled
      // tunnel still has most of the two messages queued.
      setTimeout(() => ws.close(1000, 'complete'), 20);
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => relay.on('listening', resolve));
  let control;
  let clientSocket;
  let hostData;
  const waiting = [];
  const down = [];
  // This fixture brokers an isolated room only; it does not replace production
  // relay authentication. Neither WebSocket leg fails or drops a frame.
  relay.on('connection', (socket, req) => {
    const role = new URL(req.url, 'http://localhost').searchParams.get('role');
    if (role === 'host-control') {
      control = socket;
      socket.send(JSON.stringify({ type: 'sync', connectionIds: clientSocket ? ['fixture'] : [] }));
    } else if (role === 'client') {
      clientSocket = socket;
      control?.send(JSON.stringify({ type: 'connected', connectionId: 'fixture' }));
      socket.on('message', (data, binary) => {
        if (hostData) hostData.send(data, { binary });
        else waiting.push({ data, binary });
      });
    } else {
      hostData = socket;
      for (const frame of waiting.splice(0)) socket.send(frame.data, { binary: frame.binary });
      socket.on('message', (data, binary) => {
        down.push({ data, binary });
      });
    }
  });
  // Drain at a byte budget, not a frame count: frame-size changes cannot make
  // the test's effective bandwidth change. Preserve whole WS messages in order.
  let credit = 0;
  const drain = setInterval(() => {
    credit = Math.min(128 * 1024, credit + 4096);
    while (down.length && down[0].data.length <= credit) {
      const frame = down.shift();
      credit -= frame.data.length;
      clientSocket.send(frame.data, { binary: frame.binary });
    }
  }, 5);
  const keys = await generateEcdhKeyPair();
  const relayUrl = `ws://127.0.0.1:${relay.address().port}/ws`;
  const host = startRelayHost({
    relayUrl, localPort: upstream.address().port, batch, flowControl: hostFlow,
    identity: { serverId: 'fixture', hostEncPrivateKey: keys.privateKey, signRelayAuth: () => ({ ts: 0, sig: '', pk: '' }) },
  });
  const client = createRelayTunnelClient({ relayUrl, serverId: 'fixture', hostEncPubJwk: await exportPublicKeyJwk(keys.publicKey), batch, flowControl: clientFlow });
  const states = [];
  client.subscribeStatus(status => states.push(status.state));
  const headers = { authorization: 'Bearer fixture-token' };
  let received = 0;
  let finished = false;
  let wsMessages = 0;
  let streamFailure;
  const chunks = [];
  const abort = new AbortController();
  try {
    await waitFor(() => client.getStatus().state === 'connected');
    let stream;
    if (websocket) {
      const socket = client.openWebSocket('/api/terminal/ws?oc_url_token=fixture-url-token');
      stream = new Promise((resolve, reject) => {
        socket.onmessage = event => {
          const bytes = new Uint8Array(event.data);
          chunks.push(bytes);
          received += bytes.length;
          wsMessages++;
        };
        socket.onclose = event => {
          finished = true;
          if (event.code !== 1000) reject(new Error(event.reason));
          else resolve();
        };
      });
    } else {
      const response = await client.fetch('/api/global/event', { headers, signal: abort.signal });
      stream = (async () => {
        try {
          for await (const chunk of response.body) { chunks.push(chunk); received += chunk.length; }
        } catch (error) {
          if (!cancel || error.name !== 'AbortError') throw error;
        } finally { finished = true; }
      })();
    }
    stream = stream.catch(error => { streamFailure = error; });
    await waitFor(() => received > 0 || streamFailure);
    if (streamFailure) throw streamFailure;
    if (cancel) abort.abort();
    const response = await client.fetch('/health', { headers, signal: AbortSignal.timeout(5000) });
    expect(await response.text()).toBe('ok');
    const bytesAtProbe = received;
    await stream;
    expect(streamFailure).toBeUndefined();
    expect(finished).toBe(true);
    if (!cancel) expect(Buffer.concat(chunks).equals(content)).toBe(true);
    if (websocket) expect(wsMessages).toBe(2);
    expect(states).toEqual(['connected']);
    return { bytesAtProbe, total };
  } finally {
    client.close();
    host.stop();
    clearInterval(drain);
    for (const ws of relay.clients) ws.terminate();
    relay.close();
    for (const ws of upstreamWs.clients) ws.terminate();
    upstreamWs.close();
    upstream.closeAllConnections();
    upstream.close();
  }
}

describe('end-to-end downstream credit', () => {
  test('small HTTP response overtakes bulk output without losing bytes or reconnecting', async () => {
    const result = await exercise();
    expect(result.bytesAtProbe).toBeLessThan(result.total / 2);
    // Queue peaks depend on real ACK timing and include encryption overhead.
    // downstream-scheduler.test.js checks credit bounds with a controlled clock.
  });
  test('works without batching', async () => {
    const result = await exercise({ batch: false });
    expect(result.bytesAtProbe).toBeLessThan(result.total / 2);
  });
  test('cancelling a blocked stream leaves unrelated requests usable', async () => {
    const result = await exercise({ cancel: true });
    expect(result.bytesAtProbe).toBeLessThan(result.total);
  });
  test('fragmented WS messages remain complete and precede the close', async () => {
    await exercise({ websocket: true });
  });
  for (const legacy of [{ clientFlow: false }, { hostFlow: false }]) {
    test(`legacy fallback ${JSON.stringify(legacy)} preserves delivery`, async () => {
      const result = await exercise(legacy);
      expect(result.bytesAtProbe).toBe(result.total);
    });
  }
});

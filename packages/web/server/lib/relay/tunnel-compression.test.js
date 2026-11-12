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

const PAGE = JSON.stringify({ data: Array.from({ length: 2000 }, (_, i) => ({ id: `part_${i}`, output: 'src/components/chat/message.tsx:12: const value = 1\n'.repeat(3) })) });

// Real TS client and JS host over an in-process relay broker that forwards
// frames verbatim, counting the bytes that cross it toward the client.
async function fetchPage(clientOptions = {}) {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/api/session/s/message') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(PAGE);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"ping"}\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => relay.on('listening', resolve));
  let control;
  let clientSocket;
  let hostData;
  const waiting = [];
  let downstreamBytes = 0;
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
        downstreamBytes += data.length;
        clientSocket.send(data, { binary });
      });
    }
  });
  const keys = await generateEcdhKeyPair();
  const relayUrl = `ws://127.0.0.1:${relay.address().port}/ws`;
  const host = startRelayHost({
    relayUrl, localPort: upstream.address().port,
    identity: { serverId: 'fixture', hostEncPrivateKey: keys.privateKey, signRelayAuth: () => ({ ts: 0, sig: '', pk: '' }) },
  });
  const client = createRelayTunnelClient({ relayUrl, serverId: 'fixture', hostEncPubJwk: await exportPublicKeyJwk(keys.publicKey), ...clientOptions });
  try {
    await waitFor(() => client.getStatus().state === 'connected');
    const before = downstreamBytes;
    const response = await client.fetch('/api/session/s/message');
    const text = await response.text();
    const pageBytes = downstreamBytes - before;
    const events = await (await client.fetch('/api/event')).text();
    return { text, pageBytes, events, headers: Object.fromEntries(response.headers.entries()) };
  } finally {
    client.close();
    host.stop();
    for (const ws of relay.clients) ws.terminate();
    relay.close();
    upstream.closeAllConnections();
    upstream.close();
  }
}

describe('tunnel body compression end to end', () => {
  test('a client that can gunzip gets the same body for a fraction of the bytes', async () => {
    const result = await fetchPage();
    expect(result.text).toBe(PAGE);
    expect(result.headers['x-openchamber-tunnel-content-encoding']).toBeUndefined();
    expect(result.pageBytes).toBeLessThan(PAGE.length / 5);
    // Event streams cross uncompressed and unmarked, the path every response
    // from an older host takes.
    expect(result.events).toBe('data: {"type":"ping"}\n\n');
  });
});

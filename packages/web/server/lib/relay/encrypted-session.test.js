import { describe, expect, it } from 'bun:test';

import { createClientHandshake } from '../../../../ui/src/lib/relay/handshake.ts';
import { createEncryptedSession } from './encrypted-session.js';
import { exportPublicKeyJwk, generateEcdhKeyPair, RelayCloseCode } from './e2ee.js';

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('observable encrypted session outcome not reached');
};

const createSocket = () => ({
  readyState: 1,
  bufferedAmount: 0,
  sent: [],
  send(data) { this.sent.push(data); },
});

describe('encrypted session', () => {
  const establishedFixture = async (batch) => {
    const hostKeys = await generateEcdhKeyPair();
    const client = await createClientHandshake(await exportPublicKeyJwk(hostKeys.publicKey), { batch });
    const socket = createSocket();
    const failures = [];
    const session = createEncryptedSession({
      socket, connectionId: 'malformed', hostEncPrivateKey: hostKeys.privateKey, batch,
      getLocalPort: () => 1, batchWindowMs: 0, onFailure: (code, reason) => failures.push({ code, reason }),
      logger: { warn() {} },
    });
    session.receive(client.helloText, false);
    await waitFor(() => socket.sent.length > 0);
    const action = await client.handleText(socket.sent[0]);
    return { session, channel: action.channel, failures };
  };

  it('closes exactly once for a malformed negotiated batch', async () => {
    const { session, channel, failures } = await establishedFixture(true);
    const malformed = await channel.encryptor.encrypt(new Uint8Array([1]));
    session.receive(malformed, true);
    session.receive(malformed, true);
    await waitFor(() => failures.length > 0);
    expect(failures).toEqual([{ code: RelayCloseCode.ChannelFailure, reason: 'protocol failure' }]);
  });

  it('closes exactly once for a malformed tunnel frame', async () => {
    const { session, channel, failures } = await establishedFixture(false);
    const malformed = await channel.encryptor.encrypt(new Uint8Array([1]));
    session.receive(malformed, true);
    await waitFor(() => failures.length > 0);
    expect(failures).toEqual([{ code: RelayCloseCode.ChannelFailure, reason: 'protocol failure' }]);
  });

  it('fails closed on binary before handshake', async () => {
    const hostKeys = await generateEcdhKeyPair();
    const failures = [];
    const session = createEncryptedSession({
      socket: createSocket(), connectionId: 'binary-first', hostEncPrivateKey: hostKeys.privateKey,
      getLocalPort: () => 1, batchWindowMs: 0, onFailure: (code, reason) => failures.push({ code, reason }),
      logger: { warn() {} },
    });
    session.receive(new Uint8Array([1]), true);
    await waitFor(() => failures.length > 0);
    expect(failures).toEqual([{ code: RelayCloseCode.ChannelFailure, reason: 'binary frame before handshake' }]);
    session.close();
  });

  it('uses the existing handshake and fails closed on post-establishment plaintext', async () => {
    const hostKeys = await generateEcdhKeyPair();
    const client = await createClientHandshake(await exportPublicKeyJwk(hostKeys.publicKey));
    const socket = createSocket();
    const failures = [];
    const session = createEncryptedSession({
      socket, connectionId: 'plaintext-after', hostEncPrivateKey: hostKeys.privateKey,
      getLocalPort: () => 1, batchWindowMs: 0, onFailure: (code, reason) => failures.push({ code, reason }),
      logger: { warn() {} },
    });
    session.receive(client.helloText, false);
    await waitFor(() => socket.sent.length > 0);
    expect(typeof socket.sent[0]).toBe('string');
    expect((await client.handleText(socket.sent[0])).type).toBe('established');
    session.receive('{"t":"unexpected"}', false);
    await waitFor(() => failures.length > 0);
    expect(failures[0]?.code).toBe(RelayCloseCode.ChannelFailure);
    session.close();
  });
});

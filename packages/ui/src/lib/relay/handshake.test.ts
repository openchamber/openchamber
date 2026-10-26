import { describe, expect, test } from 'bun:test';

import { exportPublicKeyJwk, generateEcdhKeyPair } from './crypto';
import {
  createClientHandshake,
  createHostHandshake,
  type EstablishedChannelCrypto,
  type HandshakeAction,
} from './handshake';
import { RelayCloseCode } from './protocol';

const createHostIdentity = async () => {
  const keyPair = await generateEcdhKeyPair();
  return {
    privateKey: keyPair.privateKey,
    publicJwk: await exportPublicKeyJwk(keyPair.publicKey),
  };
};

const expectEstablished = (
  action: HandshakeAction,
): { channel: EstablishedChannelCrypto; replyText?: string } => {
  if (action.type !== 'established') {
    throw new Error(`expected established, got ${action.type}`);
  }
  return action;
};

const runFullHandshake = async () => {
  const host = await createHostIdentity();
  const client = await createClientHandshake(host.publicJwk);
  const hostMachine = createHostHandshake(host.privateKey);

  const hostResult = expectEstablished(await hostMachine.handleText(client.helloText));
  expect(hostResult.replyText).toBeDefined();
  const clientResult = expectEstablished(await client.handleText(hostResult.replyText as string));
  return { client, hostMachine, clientChannel: clientResult.channel, hostChannel: hostResult.channel };
};

describe('relay E2EE handshake', () => {
  test('full handshake establishes a working bidirectional channel', async () => {
    const { clientChannel, hostChannel } = await runFullHandshake();

    const toHost = await clientChannel.encryptor.encrypt(new TextEncoder().encode('ping'));
    expect(new TextDecoder().decode(await hostChannel.decryptor.decrypt(toHost))).toBe('ping');

    const toClient = await hostChannel.encryptor.encrypt(new TextEncoder().encode('pong'));
    expect(new TextDecoder().decode(await clientChannel.decryptor.decrypt(toClient))).toBe('pong');
  });

  test('negotiates batching only when both peers advertise it', async () => {
    const assertNegotiated = async (
      clientBatch: boolean | undefined,
      hostBatch: boolean | undefined,
      expected: boolean,
    ) => {
      const host = await createHostIdentity();
      const client = await createClientHandshake(host.publicJwk, { batch: clientBatch });
      const hostMachine = createHostHandshake(host.privateKey, { batch: hostBatch });
      const hostResult = await hostMachine.handleText(client.helloText);
      if (hostResult.type !== 'established') throw new Error('host did not establish');
      const clientResult = await client.handleText(hostResult.replyText as string);
      if (clientResult.type !== 'established') throw new Error('client did not establish');
      // Symmetric: both sides agree on the same negotiated value.
      expect(hostResult.batch).toBe(expected);
      expect(clientResult.batch).toBe(expected);
    };

    await assertNegotiated(true, true, true);
    await assertNegotiated(undefined, undefined, true); // default is batch-on
    await assertNegotiated(false, true, false); // legacy client
    await assertNegotiated(true, false, false); // legacy host
    await assertNegotiated(false, false, false); // both legacy
  });

  test('host re-sends ready for an identical retried hello', async () => {
    const host = await createHostIdentity();
    const client = await createClientHandshake(host.publicJwk);
    const hostMachine = createHostHandshake(host.privateKey);

    const first = expectEstablished(await hostMachine.handleText(client.helloText));
    const retry = await hostMachine.handleText(client.helloText);
    expect(retry).toEqual({ type: 'send-text', text: first.replyText as string });
  });

  test('client ignores a duplicate ready after establishment (host re-answers retried hellos)', async () => {
    const { client } = await runFullHandshake();
    const action = await client.handleText(JSON.stringify({ t: 'ready', v: 1 }));
    expect(action.type).toBe('ignore');
  });

  test('hello with a different key after establishment fails with rekey mismatch (1008)', async () => {
    const host = await createHostIdentity();
    const firstClient = await createClientHandshake(host.publicJwk);
    const hostMachine = createHostHandshake(host.privateKey);
    expectEstablished(await hostMachine.handleText(firstClient.helloText));

    const attacker = await createClientHandshake(host.publicJwk);
    const action = await hostMachine.handleText(attacker.helloText);
    expect(action.type).toBe('fail');
    if (action.type === 'fail') {
      expect(action.closeCode).toBe(RelayCloseCode.RekeyMismatch);
    }
  });

  test('plaintext after establishment fails closed (1011) on both sides', async () => {
    const { client, hostMachine } = await runFullHandshake();

    const hostAction = await hostMachine.handleText('{"anything":"plaintext"}');
    expect(hostAction.type).toBe('fail');
    if (hostAction.type === 'fail') {
      expect(hostAction.closeCode).toBe(RelayCloseCode.ChannelFailure);
    }

    const clientAction = await client.handleText('{"anything":"plaintext"}');
    expect(clientAction.type).toBe('fail');
    if (clientAction.type === 'fail') {
      expect(clientAction.closeCode).toBe(RelayCloseCode.ChannelFailure);
    }
  });

  test('pre-establishment noise is ignored, not fatal', async () => {
    const host = await createHostIdentity();
    const client = await createClientHandshake(host.publicJwk);
    const hostMachine = createHostHandshake(host.privateKey);

    expect((await client.handleText('not json')).type).toBe('ignore');
    expect((await client.handleText('{"type":"sync","connectionIds":[]}')).type).toBe('ignore');
    expect((await hostMachine.handleText('not json')).type).toBe('ignore');
    expect((await hostMachine.handleText(JSON.stringify({ t: 'ready', v: 1 }))).type).toBe('ignore');
  });

  test('malformed hello fails closed without corrupting host state', async () => {
    const host = await createHostIdentity();
    const hostMachine = createHostHandshake(host.privateKey);
    const badHello = JSON.stringify({
      t: 'hello',
      v: 1,
      clientPubJwk: { kty: 'EC', crv: 'P-256', x: '!!', y: '!!' },
      nonce: 'AAAA',
    });
    const action = await hostMachine.handleText(badHello);
    expect(action.type).toBe('fail');
    expect(hostMachine.established).toBe(false);

    // A valid client can still complete against a fresh machine after garbage.
    const client = await createClientHandshake(host.publicJwk);
    expectEstablished(await hostMachine.handleText(client.helloText));
  });

  test('wrong protocol version hello is ignored', async () => {
    const host = await createHostIdentity();
    const client = await createClientHandshake(host.publicJwk);
    const hostMachine = createHostHandshake(host.privateKey);
    const tampered = JSON.stringify({ ...JSON.parse(client.helloText), v: 99 });
    expect((await hostMachine.handleText(tampered)).type).toBe('ignore');
  });

  test('client bound to a different host key derives non-matching channel keys', async () => {
    const realHost = await createHostIdentity();
    const otherHost = await createHostIdentity();
    // Client trusts otherHost's public key, but realHost answers.
    const client = await createClientHandshake(otherHost.publicJwk);
    const hostMachine = createHostHandshake(realHost.privateKey);
    const hostResult = expectEstablished(await hostMachine.handleText(client.helloText));
    const clientResult = expectEstablished(await client.handleText(hostResult.replyText as string));

    const frame = await hostResult.channel.encryptor.encrypt(new Uint8Array([1, 2, 3]));
    await expect(clientResult.channel.decryptor.decrypt(frame)).rejects.toThrow();
  });
});

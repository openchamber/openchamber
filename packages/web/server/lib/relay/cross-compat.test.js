// Cross-compatibility: the JS host e2ee must interoperate with the normative TS
// modules in packages/ui/src/lib/relay. bun runs TS directly, so import the TS
// client handshake and drive a full TS-client <-> JS-host exchange both ways.

import { describe, expect, it } from 'bun:test';

import { createHostHandshake, exportPublicKeyJwk, generateEcdhKeyPair } from './e2ee.js';
import { createClientHandshake } from '../../../../ui/src/lib/relay/handshake.ts';
import {
  TunnelFrameType as JsFrameType,
  decodeFrameBatch as jsDecodeBatch,
  decodeTunnelFrame as jsDecode,
  encodeFrameBatch as jsEncodeBatch,
  encodeTunnelFrame as jsEncode,
} from './tunnel-codec.js';
import {
  decodeFrameBatch as tsDecodeBatch,
  decodeTunnelFrame as tsDecode,
  encodeFrameBatch as tsEncodeBatch,
  encodeTunnelFrame as tsEncode,
} from '../../../../ui/src/lib/relay/tunnel-codec.ts';
import { TunnelFrameType as TsFrameType } from '../../../../ui/src/lib/relay/protocol.ts';

describe('relay JS-host <-> TS-client cross compatibility', () => {
  it('completes a handshake and exchanges frames both ways', async () => {
    const hostKeys = await generateEcdhKeyPair();
    const hostPubJwk = await exportPublicKeyJwk(hostKeys.publicKey);

    const jsHost = createHostHandshake(hostKeys.privateKey);
    const tsClient = await createClientHandshake(hostPubJwk);

    // TS client hello -> JS host establishes and replies ready.
    const hostAction = await jsHost.handleText(tsClient.helloText);
    expect(hostAction.type).toBe('established');
    const hostChannel = hostAction.channel;

    // JS host ready -> TS client establishes.
    const clientAction = await tsClient.handleText(hostAction.replyText);
    expect(clientAction.type).toBe('established');
    const clientChannel = clientAction.channel;

    // TS client -> JS host.
    const up = new TextEncoder().encode('ts client speaking');
    const upPlain = await hostChannel.decryptor.decrypt(await clientChannel.encryptor.encrypt(up));
    expect(new TextDecoder().decode(upPlain)).toBe('ts client speaking');

    // JS host -> TS client.
    const down = new TextEncoder().encode('js host replying');
    const downPlain = await clientChannel.decryptor.decrypt(await hostChannel.encryptor.encrypt(down));
    expect(new TextDecoder().decode(downPlain)).toBe('js host replying');
  });

  it('tunnel frames are byte-compatible across TS and JS codecs', () => {
    const payload = new TextEncoder().encode('{"method":"GET"}');
    const tsFrame = tsEncode(TsFrameType.HttpRequest, 5, payload);
    const jsFrame = jsEncode(JsFrameType.HttpRequest, 5, payload);
    expect(Array.from(jsFrame)).toEqual(Array.from(tsFrame));

    const decodedByJs = jsDecode(tsFrame);
    const decodedByTs = tsDecode(jsFrame);
    expect(decodedByJs.streamId).toBe(5);
    expect(decodedByTs.streamId).toBe(5);
    expect(decodedByJs.frameType).toBe(TsFrameType.HttpRequest);
  });

  it('negotiates batching between a TS client and a JS host, then exchanges a batch', async () => {
    const hostKeys = await generateEcdhKeyPair();
    const hostPubJwk = await exportPublicKeyJwk(hostKeys.publicKey);

    const jsHost = createHostHandshake(hostKeys.privateKey);
    const tsClient = await createClientHandshake(hostPubJwk);

    const hostAction = await jsHost.handleText(tsClient.helloText);
    expect(hostAction.type).toBe('established');
    expect(hostAction.batch).toBe(true);
    const clientAction = await tsClient.handleText(hostAction.replyText);
    expect(clientAction.type).toBe('established');
    expect(clientAction.batch).toBe(true);

    // TS client encodes a multi-frame batch -> JS host decodes it byte-identically.
    const frames = [
      tsEncode(TsFrameType.HttpBody, 1, new TextEncoder().encode('alpha')),
      tsEncode(TsFrameType.HttpBody, 1, new TextEncoder().encode('beta')),
      tsEncode(TsFrameType.HttpBody, 1, new TextEncoder().encode('gamma')),
    ];
    const overWire = await hostAction.channel.decryptor.decrypt(
      await clientAction.channel.encryptor.encrypt(tsEncodeBatch(frames)),
    );
    const jsFrames = jsDecodeBatch(overWire);
    expect(jsFrames.length).toBe(3);
    jsFrames.forEach((frame, index) => expect(Array.from(frame)).toEqual(Array.from(frames[index])));

    // JS host encodes a batch -> TS client decodes it.
    const downFrames = [
      jsEncode(JsFrameType.HttpBody, 1, new TextEncoder().encode('down-1')),
      jsEncode(JsFrameType.HttpBody, 1, new TextEncoder().encode('down-2')),
    ];
    const downWire = await clientAction.channel.decryptor.decrypt(
      await hostAction.channel.encryptor.encrypt(jsEncodeBatch(downFrames)),
    );
    const tsFrames = tsDecodeBatch(downWire);
    expect(tsFrames.length).toBe(2);
    tsFrames.forEach((frame, index) => expect(Array.from(frame)).toEqual(Array.from(downFrames[index])));
  });

  it('falls back to legacy (no batch) when either peer does not advertise batching', async () => {
    const hostKeys = await generateEcdhKeyPair();
    const hostPubJwk = await exportPublicKeyJwk(hostKeys.publicKey);

    // Legacy JS host (batch:false) vs batch-capable TS client -> batching off.
    const legacyHost = createHostHandshake(hostKeys.privateKey, { batch: false });
    const tsClient = await createClientHandshake(hostPubJwk);
    const hostAction = await legacyHost.handleText(tsClient.helloText);
    expect(hostAction.type).toBe('established');
    expect(hostAction.batch).toBe(false);
    const clientAction = await tsClient.handleText(hostAction.replyText);
    expect(clientAction.type).toBe('established');
    expect(clientAction.batch).toBe(false);

    // Legacy wire: plaintext is a single raw tunnel frame (no container tag).
    const frame = tsEncode(TsFrameType.HttpBody, 1, new TextEncoder().encode('legacy'));
    const overWire = await hostAction.channel.decryptor.decrypt(
      await clientAction.channel.encryptor.encrypt(frame),
    );
    expect(jsDecode(overWire).frameType).toBe(JsFrameType.HttpBody);

    // Batch-capable JS host vs legacy TS client (batch:false) -> also off.
    const host2 = createHostHandshake(hostKeys.privateKey);
    const legacyClient = await createClientHandshake(hostPubJwk, { batch: false });
    const host2Action = await host2.handleText(legacyClient.helloText);
    expect(host2Action.batch).toBe(false);
    const client2Action = await legacyClient.handleText(host2Action.replyText);
    expect(client2Action.batch).toBe(false);
  });
});

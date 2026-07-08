import { describe, expect, test } from 'bun:test';

import { buildRelayOfferUrl } from '@/lib/relay/offer';
import type { RelayOfferV1 } from '@/lib/relay/protocol';

import { parseConnectionPayload } from './mobileQrScan';

const baseOffer: RelayOfferV1 = {
  v: 1,
  mode: 'relay',
  relayUrl: 'wss://relay.example/tunnel',
  serverId: 'srv_test123',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' },
};

describe('parseConnectionPayload', () => {
  test('parses direct pairing links unchanged', () => {
    const payload = parseConnectionPayload('openchamber://connect?v=1&server=http%3A%2F%2F192.168.1.10%3A2606&token=tok&label=Home');
    expect(payload).toEqual({ url: 'http://192.168.1.10:2606', clientToken: 'tok', label: 'Home' });
  });

  test('parses bare http(s) URLs unchanged', () => {
    expect(parseConnectionPayload('https://oc.example')).toEqual({ url: 'https://oc.example' });
    expect(parseConnectionPayload('  http://192.168.1.10:2606 ')).toEqual({ url: 'http://192.168.1.10:2606' });
  });

  test('rejects non-connection payloads', () => {
    expect(parseConnectionPayload('')).toBeNull();
    expect(parseConnectionPayload('hello world')).toBeNull();
    expect(parseConnectionPayload('openchamber://connect')).toBeNull();
    expect(parseConnectionPayload('openchamber://session/abc')).toBeNull();
  });

  test('recognizes relay offers with embedded token and grant', () => {
    const url = buildRelayOfferUrl({ ...baseOffer, label: 'My Desktop', token: 'oc_client_secret', grant: 'grant123' });
    const payload = parseConnectionPayload(url);
    expect(payload).not.toBeNull();
    expect(payload?.url).toBe(url);
    expect(payload?.label).toBe('My Desktop');
    expect(payload?.clientToken).toBe('oc_client_secret');
    expect(payload?.relay).toEqual({
      relayUrl: baseOffer.relayUrl,
      serverId: baseOffer.serverId,
      hostEncPubJwk: baseOffer.hostEncPubJwk,
    });
    expect(payload?.relayGrant).toBe('grant123');
  });

  test('recognizes token-less relay offers (login-on-first-connect)', () => {
    const url = buildRelayOfferUrl(baseOffer);
    const payload = parseConnectionPayload(url);
    expect(payload).not.toBeNull();
    expect(payload?.clientToken).toBe(undefined);
    expect(payload?.relayGrant).toBe(undefined);
    expect(payload?.relay?.serverId).toBe(baseOffer.serverId);
  });

  test('malformed relay offers fall through to direct parsing rules', () => {
    // mode=relay but no fragment payload → not a valid offer, and no `server`
    // param either → rejected entirely, exactly like before relay support.
    expect(parseConnectionPayload('openchamber://connect?v=1&mode=relay')).toBeNull();
    // Direct link that also carries an unrelated mode param keeps direct parsing.
    const direct = parseConnectionPayload('openchamber://connect?v=1&mode=relay&server=http%3A%2F%2Fhost.example');
    expect(direct).toEqual({ url: 'http://host.example' });
  });
});

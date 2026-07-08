import { describe, expect, test } from 'bun:test';

import { buildRelayOfferUrl, parseRelayOfferUrl, redactOffer } from './offer';
import type { RelayOfferV1 } from './protocol';

const baseOffer: RelayOfferV1 = {
  v: 1,
  mode: 'relay',
  relayUrl: 'wss://relay.example.com/host',
  serverId: 'srv_0123456789abcdef',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x-coordinate-b64u', y: 'y-coordinate-b64u' },
};

const fullOffer: RelayOfferV1 = {
  ...baseOffer,
  label: 'My Mac',
  token: 'oc_client_secret_token_value',
  grant: 'grant-value',
};

describe('buildRelayOfferUrl / parseRelayOfferUrl', () => {
  test('round-trips a minimal offer', () => {
    expect(parseRelayOfferUrl(buildRelayOfferUrl(baseOffer))).toEqual(baseOffer);
  });

  test('round-trips a full offer with optional fields', () => {
    expect(parseRelayOfferUrl(buildRelayOfferUrl(fullOffer))).toEqual(fullOffer);
  });

  test('URL has the expected shape', () => {
    const url = buildRelayOfferUrl(baseOffer);
    expect(url.startsWith('openchamber://connect?v=1&mode=relay#offer=')).toBe(true);
  });

  test('token appears only in the fragment, never in the query string', () => {
    const url = buildRelayOfferUrl(fullOffer);
    const [beforeFragment, fragment] = url.split('#');
    expect(beforeFragment).toBe('openchamber://connect?v=1&mode=relay');
    expect(beforeFragment.includes(fullOffer.token as string)).toBe(false);
    expect(fragment.startsWith('offer=')).toBe(true);
    // Token round-trips through the fragment payload.
    expect(parseRelayOfferUrl(url)?.token).toBe(fullOffer.token as string);
  });

  const encodeOffer = (value: unknown): string => {
    const json = JSON.stringify(value);
    const b64 = Buffer.from(json, 'utf8').toString('base64url');
    return `openchamber://connect?v=1&mode=relay#offer=${b64}`;
  };

  test('rejects wrong scheme, host, version, and mode', () => {
    const url = buildRelayOfferUrl(baseOffer);
    expect(parseRelayOfferUrl(url.replace('openchamber://', 'https://'))).toBeNull();
    expect(parseRelayOfferUrl(url.replace('//connect', '//pair'))).toBeNull();
    expect(parseRelayOfferUrl(url.replace('v=1', 'v=2'))).toBeNull();
    expect(parseRelayOfferUrl(url.replace('mode=relay', 'mode=lan'))).toBeNull();
    expect(parseRelayOfferUrl('not a url')).toBeNull();
    expect(parseRelayOfferUrl('openchamber://connect?v=1&mode=relay')).toBeNull();
    expect(parseRelayOfferUrl('openchamber://connect?v=1&mode=relay#offer=')).toBeNull();
    expect(parseRelayOfferUrl('openchamber://connect?v=1&mode=relay#offer=!!not-b64url!!')).toBeNull();
  });

  const without = (key: keyof RelayOfferV1): Record<string, unknown> => {
    const clone: Record<string, unknown> = { ...fullOffer };
    delete clone[key];
    return clone;
  };

  test('rejects wholly when any required field is missing or malformed', () => {
    const cases: unknown[] = [
      { ...fullOffer, v: 2 },
      without('v'),
      { ...fullOffer, mode: 'direct' },
      without('mode'),
      without('relayUrl'),
      { ...fullOffer, relayUrl: '' },
      { ...fullOffer, relayUrl: 'not-a-url' },
      { ...fullOffer, relayUrl: 'ftp://relay.example.com' },
      without('serverId'),
      { ...fullOffer, serverId: '' },
      { ...fullOffer, serverId: 42 },
      without('hostEncPubJwk'),
      { ...fullOffer, hostEncPubJwk: { ...baseOffer.hostEncPubJwk, kty: 'RSA' } },
      { ...fullOffer, hostEncPubJwk: { ...baseOffer.hostEncPubJwk, crv: 'P-384' } },
      { ...fullOffer, hostEncPubJwk: { kty: 'EC', crv: 'P-256', y: 'y' } },
      { ...fullOffer, hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x' } },
      { ...fullOffer, hostEncPubJwk: 'jwk' },
      { ...fullOffer, label: '' },
      { ...fullOffer, token: '' },
      { ...fullOffer, token: 123 },
      { ...fullOffer, grant: '' },
      ['array'],
    ];
    for (const payload of cases) {
      expect(parseRelayOfferUrl(encodeOffer(payload))).toBeNull();
    }
  });

  test('parse strips unknown fields', () => {
    const parsed = parseRelayOfferUrl(encodeOffer({ ...baseOffer, extra: 'field' }));
    expect(parsed).toEqual(baseOffer);
  });
});

describe('redactOffer', () => {
  test('masks token, grant, and host public key coordinates', () => {
    const redacted = redactOffer(fullOffer);
    expect(redacted.token).toBe('[redacted]');
    expect(redacted.grant).toBe('[redacted]');
    expect(redacted.hostEncPubJwk.x).toBe('[redacted]');
    expect(redacted.hostEncPubJwk.y).toBe('[redacted]');
    const serialized = JSON.stringify(redacted);
    expect(serialized.includes(fullOffer.token as string)).toBe(false);
    expect(serialized.includes(baseOffer.hostEncPubJwk.x as string)).toBe(false);
  });

  test('keeps non-secret fields and omits absent optionals', () => {
    const redacted = redactOffer(baseOffer);
    expect(redacted.relayUrl).toBe(baseOffer.relayUrl);
    expect(redacted.serverId).toBe(baseOffer.serverId);
    expect('token' in redacted).toBe(false);
    expect('grant' in redacted).toBe(false);
  });

  test('does not mutate the input offer', () => {
    const copy = structuredClone(fullOffer);
    redactOffer(fullOffer);
    expect(fullOffer).toEqual(copy);
  });
});

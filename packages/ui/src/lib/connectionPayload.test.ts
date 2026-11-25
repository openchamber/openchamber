import { describe, expect, test } from 'bun:test';

import {
  buildPairingConnectionPayload,
  encodePairingConnectionPayload,
  parsePairingConnectionPayload,
  parsePairingConnectionPayloadString,
} from './connectionPayload';

const hostEncPubJwk = { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' } as const;

describe('connection payload helpers', () => {
  test('round-trips v2 pairing payloads with direct candidates', () => {
    const payload = buildPairingConnectionPayload({
      pairingId: 'pair_123',
      secret: 'one-time-secret',
      label: 'Desktop',
      fingerprint: 'ABCD-1234',
      expiresAt: '2099-01-01T00:00:00.000Z',
      candidates: [
        { type: 'lan', url: 'http://192.168.1.20:4096/', priority: 20 },
        { type: 'tunnel', url: 'https://runtime.example/', priority: 10 },
      ],
    });

    const encoded = encodePairingConnectionPayload(payload);

    expect(encoded.startsWith('openchamber://connect?v=2&p=')).toBe(true);
    expect(parsePairingConnectionPayload(encoded)).toEqual({
      ...payload,
      candidates: [
        { type: 'lan', url: 'http://192.168.1.20:4096', priority: 20 },
        { type: 'tunnel', url: 'https://runtime.example', priority: 10 },
      ],
    });
  });

  test('round-trips a relay candidate (transport, not a URL)', () => {
    const payload = buildPairingConnectionPayload({
      pairingId: 'pair_relay',
      secret: 'one-time-secret',
      candidates: [
        { type: 'lan', url: 'http://192.168.1.20:4096', priority: 10 },
        { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv_abc', hostEncPubJwk, priority: 30 },
      ],
    });

    const parsed = parsePairingConnectionPayload(encodePairingConnectionPayload(payload));
    expect(parsed?.candidates).toEqual([
      { type: 'lan', url: 'http://192.168.1.20:4096', priority: 10 },
      { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv_abc', hostEncPubJwk, priority: 30 },
    ]);
  });

  test('relay candidate keeps its path and rejects non-ws relay URLs / bad JWKs', () => {
    const withBadRelay = (candidate: Record<string, unknown>) =>
      Buffer.from(JSON.stringify({ v: 2, pairingId: 'pair_1', secret: 's', candidates: [candidate] })).toString('base64url');

    // https relay URL is not a WebSocket endpoint → candidate dropped → no candidates → null.
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${withBadRelay({ type: 'relay', relayUrl: 'https://relay.example/ws', serverId: 'srv', hostEncPubJwk })}`)).toBeNull();
    // Missing serverId.
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${withBadRelay({ type: 'relay', relayUrl: 'wss://relay.example/ws', hostEncPubJwk })}`)).toBeNull();
    // Non-P-256 key.
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${withBadRelay({ type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv', hostEncPubJwk: { kty: 'EC', crv: 'P-384', x: 'a', y: 'b' } })}`)).toBeNull();
  });

  test('drops a private-key member from a relay JWK (keeps only public coordinates)', () => {
    const withKey = Buffer.from(JSON.stringify({
      v: 2,
      pairingId: 'pair_1',
      secret: 's',
      candidates: [{ type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv', hostEncPubJwk: { ...hostEncPubJwk, d: 'PRIVATE' } }],
    })).toString('base64url');
    const parsed = parsePairingConnectionPayload(`openchamber://connect?v=2&p=${withKey}`);
    expect(parsed?.candidates[0]).toEqual({ type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv', hostEncPubJwk });
  });

  test('rejects invalid v2 pairing payloads', () => {
    expect(parsePairingConnectionPayload('openchamber://connect?v=1&server=https://runtime.example&token=t')).toBeNull();
    expect(parsePairingConnectionPayload('openchamber://connect?v=2&p=not-json')).toBeNull();

    const missingSecret = Buffer.from(JSON.stringify({
      v: 2,
      pairingId: 'pair_123',
      candidates: [{ type: 'lan', url: 'http://runtime.example' }],
    })).toString('base64url');
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${missingSecret}`)).toBeNull();

    const invalidCandidate = Buffer.from(JSON.stringify({
      v: 2,
      pairingId: 'pair_123',
      secret: 'secret',
      candidates: [{ type: 'lan', url: 'file:///tmp/socket' }],
    })).toString('base64url');
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${invalidCandidate}`)).toBeNull();

    const expired = Buffer.from(JSON.stringify({
      v: 2,
      pairingId: 'pair_123',
      secret: 'secret',
      expiresAt: '2000-01-01T00:00:00.000Z',
      candidates: [{ type: 'lan', url: 'http://runtime.example' }],
    })).toString('base64url');
    expect(parsePairingConnectionPayload(`openchamber://connect?v=2&p=${expired}`)).toBeNull();
  });
});

describe('a link damaged on the way between two machines', () => {
  const encoded = encodePairingConnectionPayload(buildPairingConnectionPayload({
    pairingId: 'pair_123',
    secret: 'one-time-secret',
    label: 'windows-host',
    expiresAt: '2099-01-01T00:00:00.000Z',
    candidates: [
      { type: 'lan', url: 'http://192.168.1.20:4096', priority: 10 },
      { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv_abc', hostEncPubJwk, priority: 30 },
    ],
  }));
  const intact = parsePairingConnectionPayload(encoded);
  const every = (size: number, insert: string) => (encoded.match(new RegExp(`.{1,${size}}`, 'g')) ?? []).join(insert);
  const breaks = (count: number, insert: string) => [60, 120, 180].slice(0, count).reduceRight((text, at) => `${text.slice(0, at)}${insert}${text.slice(at)}`, encoded);
  const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
  const WORD_JOINER = String.fromCodePoint(0x2060);
  const FIRST_STRONG_ISOLATE = String.fromCodePoint(0x2068);
  const POP_ISOLATE = String.fromCodePoint(0x2069);

  // The app decodes with the browser's atob, which refuses what Buffer and bun's
  // atob skip. These cases run with no Buffer and an atob as strict as the
  // standard one: whitespace is dropped first, then wrong padding or any other
  // character throws.
  const asBrowser = <T,>(run: () => T): T => {
    const nodeBuffer = globalThis.Buffer;
    const laxAtob = globalThis.atob;
    Reflect.set(globalThis, 'Buffer', undefined);
    Reflect.set(globalThis, 'atob', (input: string): string => {
      let data = input.replace(/[\t\n\f\r ]/g, '');
      if (data.length % 4 === 0) data = data.replace(/={1,2}$/, '');
      if (data.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(data)) throw new Error('InvalidCharacterError');
      return laxAtob(data);
    });
    try {
      return run();
    } finally {
      Reflect.set(globalThis, 'Buffer', nodeBuffer);
      Reflect.set(globalThis, 'atob', laxAtob);
    }
  };

  const damaged: Array<[string, string]> = [
    // One to three breaks: whether the old decoder got past a break depended on
    // how many there were.
    ['one line break of a wrapped mail or terminal line, as a text field keeps it', breaks(1, ' ')],
    ['two line breaks, as a text field keeps them', breaks(2, ' ')],
    ['three line breaks, as a text field keeps them', breaks(3, ' ')],
    ['zero-width spaces a chat app puts into a long word', every(40, ZERO_WIDTH_SPACE)],
    ['a word joiner after the link', `${encoded}${WORD_JOINER}`],
    ['direction marks around the link', `${FIRST_STRONG_ISOLATE}${encoded}${POP_ISOLATE}`],
    ['one line break as macOS hands it to the app', breaks(1, '%0A')],
    ['two line breaks as macOS hands them to the app', breaks(2, '%0A')],
    ['three line breaks as macOS hands them to the app', breaks(3, '%0A')],
    ['a zero-width space as macOS hands it to the app', `${encoded}%E2%80%8B`],
  ];

  for (const [name, text] of damaged) {
    test(`reads the link through ${name}`, () => {
      expect(intact).not.toBeNull();
      expect(asBrowser(() => parsePairingConnectionPayload(text))).toEqual(intact);
    });
  }

  test('the Android fallback reads the same damaged text', () => {
    expect(asBrowser(() => parsePairingConnectionPayloadString(breaks(3, ' ')))).toEqual(intact);
    expect(asBrowser(() => parsePairingConnectionPayloadString(every(40, ZERO_WIDTH_SPACE)))).toEqual(intact);
  });

  test('noise next to a query key does not make it the link payload', () => {
    // The desktop shell confirms the server it reads from the text as it came.
    // Both parsers must pick the same `p`, or the dialog names one server and
    // the app pairs with another.
    const other = encodePairingConnectionPayload(buildPairingConnectionPayload({
      pairingId: 'pair_other',
      secret: 'other-secret',
      candidates: [{ type: 'lan', url: 'http://10.0.0.9:4096', priority: 10 }],
    }));
    const otherP = other.slice(other.indexOf('p=') + 2);
    const p = encoded.slice(encoded.indexOf('p=') + 2);
    for (const noise of [' ', ZERO_WIDTH_SPACE]) {
      const text = `openchamber://connect?v=2&${noise}p=${otherP}&p=${p}`;
      expect(asBrowser(() => parsePairingConnectionPayload(text))).toEqual(intact);
    }
  });

  test('still refuses a link that lost or changed characters', () => {
    expect(asBrowser(() => parsePairingConnectionPayload(encoded.slice(0, -1)))).toBeNull();
    expect(asBrowser(() => parsePairingConnectionPayload(encoded.slice(0, encoded.length / 2)))).toBeNull();
    expect(asBrowser(() => parsePairingConnectionPayload(encoded.replace('&', '&amp;')))).toBeNull();
    expect(asBrowser(() => parsePairingConnectionPayload(`${encoded}${encoded}`))).toBeNull();
  });
});

describe('parsePairingConnectionPayloadString (Android WebView fallback)', () => {
  const payload = buildPairingConnectionPayload({
    pairingId: 'pair_123',
    secret: 'one-time-secret',
    label: 'Desktop',
    candidates: [
      { type: 'lan', url: 'http://192.168.1.20:4096', priority: 20 },
      { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv_abc', hostEncPubJwk, priority: 30 },
    ],
  });
  const encoded = encodePairingConnectionPayload(payload);

  test('parses the canonical link identically to the URL-based parser', () => {
    // Old Android WebViews resolve the same string with hostname "" / pathname "//connect";
    // the string parser must not depend on the URL API to succeed.
    expect(parsePairingConnectionPayloadString(encoded)).toEqual(parsePairingConnectionPayload(encoded));
  });

  test('recovers a link whose scheme/host case the URL parser would reject', () => {
    const mixedCase = encoded.replace('openchamber://connect', 'OpenChamber://CONNECT');
    expect(parsePairingConnectionPayload(mixedCase)).toBeNull();
    expect(parsePairingConnectionPayloadString(mixedCase)).toEqual(parsePairingConnectionPayload(encoded));
  });

  test('tolerates a trailing slash and reordered query params', () => {
    const trailingSlash = encoded.replace('openchamber://connect?', 'openchamber://connect/?');
    expect(parsePairingConnectionPayloadString(trailingSlash)).toEqual(parsePairingConnectionPayload(encoded));

    const p = encoded.slice(encoded.indexOf('p=') + 2);
    expect(parsePairingConnectionPayloadString(`openchamber://connect?p=${p}&v=2`)).toEqual(parsePairingConnectionPayload(encoded));
  });

  test('still rejects non-pairing and malformed payloads', () => {
    expect(parsePairingConnectionPayloadString('')).toBeNull();
    expect(parsePairingConnectionPayloadString('hello world')).toBeNull();
    expect(parsePairingConnectionPayloadString('openchamber://connect')).toBeNull();
    expect(parsePairingConnectionPayloadString('openchamber:///connect?v=2&p=x')).toBeNull();
    expect(parsePairingConnectionPayloadString('openchamber://connect?v=1&server=http%3A%2F%2F192.168.1.10%3A2606&token=t')).toBeNull();
    expect(parsePairingConnectionPayloadString('openchamber://connect?v=2&p=not-json')).toBeNull();
  });
});

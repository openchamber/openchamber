import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));

// Load the verbatim inline PWA bootstrap script from index.html with the
// browser globals stubbed, the same shape as the #2031 reproduction probe.
const loadBootstrap = () => {
  const html = readFileSync(path.join(here, 'index.html'), 'utf8');
  const start = html.indexOf('<script>', html.indexOf('Web app manifest'));
  const end = html.indexOf('</script>', start);
  if (start < 0 || end < 0) {
    throw new Error('PWA bootstrap script block not found in index.html');
  }
  const script = html.slice(start + '<script>'.length, end);
  const store = new Map();
  const saved = {
    localStorage: globalThis.localStorage,
    location: globalThis.location,
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
  };
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  globalThis.location = { origin: 'http://localhost', search: '' };
  globalThis.document = {
    documentElement: { setAttribute() {} },
    querySelector: () => null,
    createElement: () => ({ rel: '', crossOrigin: '', href: '' }),
    head: { appendChild() {} },
  };
  globalThis.window = globalThis;
  globalThis.fetch = async () => { throw new Error('endpoint down (fallback path)'); };
  const createObjectURL = globalThis.URL.createObjectURL;
  globalThis.URL.createObjectURL = () => 'blob:stub';
  const BlobImpl = globalThis.Blob;
  globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
  try {
    return new Function(`${script}\n;return { normalizePwaName, truncate, buildManifest, buildShortcuts };`)();
  } finally {
    globalThis.localStorage = saved.localStorage;
    globalThis.location = saved.location;
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
    globalThis.URL.createObjectURL = createObjectURL;
    globalThis.Blob = BlobImpl;
  }
};

const EMOJI = '\u{1F600}';
const hasLoneSurrogate = (value) => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
};
const encodesClean = (value) => !new TextDecoder().decode(new TextEncoder().encode(value)).includes('\uFFFD');

describe('client PWA manifest bootstrap (index.html)', () => {
  it('never splits a surrogate pair at the client clamps (oracle: astral char straddling offsets 64, 48, 32 and 30 encodes with no U+FFFD, ASCII and exact-fit controls stay exact)', () => {
    const api = loadBootstrap();
    // 64: install name.
    expect(api.normalizePwaName('a'.repeat(63) + EMOJI + 'tail', 'fb')).toBe('a'.repeat(63));
    // 48: recent-session title truncate.
    expect(api.truncate('a'.repeat(47) + EMOJI + 'tail', 48)).toBe('a'.repeat(47));
    // 30: manifest short_name.
    const manifest = api.buildManifest('a'.repeat(29) + EMOJI + 'tail', [], 'system');
    expect(manifest.short_name).toBe('a'.repeat(29));
    // 32: shortcut name/short_name.
    const shortcuts = api.buildShortcuts([{ sessionId: 's1', title: 'a'.repeat(31) + EMOJI + 'tail' }]);
    const recent = shortcuts.find((shortcut) => shortcut.url.includes('s1'));
    expect(recent.name).toBe('a'.repeat(31));
    expect(recent.short_name).toBe('a'.repeat(31));
    for (const value of [manifest.name, manifest.short_name, recent.name]) {
      expect(hasLoneSurrogate(value)).toBe(false);
      expect(encodesClean(value)).toBe(true);
    }
    // Controls: ASCII cuts at exactly the limit; a pair fitting exactly inside survives.
    expect(api.normalizePwaName('a'.repeat(100), 'fb')).toBe('a'.repeat(64));
    expect(api.truncate('a'.repeat(46) + EMOJI, 48)).toBe('a'.repeat(46) + EMOJI);
    expect(api.truncate('a'.repeat(60), 48)).toBe('a'.repeat(48));
  });

  it('never splits a grapheme cluster at the client clamps (oracle: UAX #29 extended grapheme clusters, caps 64, 48, 32 and 30)', () => {
    const api = loadBootstrap();
    const combining = 'e\u0301';
    const family = '\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
    // 64: install name — a combining cluster straddling the cap drops
    // whole instead of leaving a bare base char.
    expect(api.normalizePwaName('a'.repeat(63) + combining + 'tail', 'fb')).toBe('a'.repeat(63));
    // Exact fit: 62 + 2 = 64 keeps the complete accented cluster.
    expect(api.normalizePwaName('a'.repeat(62) + combining, 'fb')).toBe('a'.repeat(62) + combining);
    // 48: recent-session title truncate — a joined ZWJ sequence
    // straddling the cap drops whole, with no dangling ZWJ.
    const truncated = api.truncate('a'.repeat(45) + family + 'tail', 48);
    expect(truncated).toBe('a'.repeat(45));
    expect(truncated.endsWith('\u200D')).toBe(false);
    // 32: shortcut short_name via truncate at 32.
    expect(api.truncate('a'.repeat(31) + combining + 'tail', 32)).toBe('a'.repeat(31));
    // 30: manifest short_name.
    const manifest = api.buildManifest('a'.repeat(29) + combining + 'tail', [], 'system');
    expect(manifest.short_name).toBe('a'.repeat(29));
    for (const value of [manifest.name, manifest.short_name, truncated]) {
      expect(hasLoneSurrogate(value)).toBe(false);
      expect(encodesClean(value)).toBe(true);
    }
  });
});

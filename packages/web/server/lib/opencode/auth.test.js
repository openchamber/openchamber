import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { loadAuthMerged, oauthExpires, readGrokAuth } from './auth.js';

/**
 * Fixture tests for the multi-source auth.json merge added in Wave 0.2.
 *
 * The merge semantics are ported verbatim from the canonical mystatus
 * `loadAuthMerged` / `oauthExpires` helpers:
 *   - for each path in order, parse JSON; for each [provider, cred]:
 *     - if no existing entry, set it;
 *     - else if cred is oauth with a finite numeric `expires` AND
 *       (existing has no oauth expires OR cred.expires > existing.expires),
 *       replace.
 *   - non-oauth entries: first-match wins (no freshness comparison).
 *   - unreadable / malformed files are skipped silently.
 *
 * `loadAuthMerged` and `readGrokAuth` accept an optional `paths` argument so
 * the tests can dependency-inject fixture paths without touching the real
 * home directory.
 */

let tmpRoot;

function makeTempRoot() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-auth-merge-'));
  return tmpRoot;
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
}

function cleanupTempRoot() {
  if (!tmpRoot) return;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = undefined;
}

beforeEach(() => {
  makeTempRoot();
});

afterEach(() => {
  cleanupTempRoot();
});

describe('oauthExpires', () => {
  it('returns the expires timestamp for an oauth cred with a finite numeric expires', () => {
    expect(oauthExpires({ type: 'oauth', expires: 1234567890 })).toBe(1234567890);
  });

  it('returns undefined for a non-oauth cred', () => {
    expect(oauthExpires({ type: 'api', expires: 1234567890 })).toBeUndefined();
    expect(oauthExpires({ expires: 1234567890 })).toBeUndefined();
  });

  it('returns undefined when expires is missing or non-finite', () => {
    expect(oauthExpires({ type: 'oauth' })).toBeUndefined();
    expect(oauthExpires({ type: 'oauth', expires: 'soon' })).toBeUndefined();
    expect(oauthExpires({ type: 'oauth', expires: Infinity })).toBeUndefined();
    expect(oauthExpires({ type: 'oauth', expires: NaN })).toBeUndefined();
  });

  it('returns undefined for non-object input', () => {
    expect(oauthExpires(null)).toBeUndefined();
    expect(oauthExpires(undefined)).toBeUndefined();
    expect(oauthExpires('oauth')).toBeUndefined();
  });
});

describe('loadAuthMerged', () => {
  it('returns {} when every candidate path is absent', () => {
    const a = path.join(tmpRoot, 'missing-a', 'auth.json');
    const b = path.join(tmpRoot, 'missing-b', 'auth.json');
    expect(loadAuthMerged([a, b])).toEqual({});
  });

  it('keeps the freshest oauth expires across multiple auth.json sources', () => {
    // Path order: stale first, fresh second. The fresh entry must win.
    const stalePath = path.join(tmpRoot, 'stale', 'auth.json');
    const freshPath = path.join(tmpRoot, 'fresh', 'auth.json');
    writeJson(stalePath, {
      grok: { type: 'oauth', access: 'old-token', expires: 1000 },
    });
    writeJson(freshPath, {
      grok: { type: 'oauth', access: 'new-token', expires: 2000 },
    });

    const merged = loadAuthMerged([stalePath, freshPath]);
    expect(merged.grok).toEqual({ type: 'oauth', access: 'new-token', expires: 2000 });
  });

  it('does NOT replace an oauth entry when the candidate has an older expires', () => {
    // Path order: fresh first, stale second. The fresh entry must survive.
    const freshPath = path.join(tmpRoot, 'fresh', 'auth.json');
    const stalePath = path.join(tmpRoot, 'stale', 'auth.json');
    writeJson(freshPath, {
      grok: { type: 'oauth', access: 'new-token', expires: 2000 },
    });
    writeJson(stalePath, {
      grok: { type: 'oauth', access: 'old-token', expires: 1000 },
    });

    const merged = loadAuthMerged([freshPath, stalePath]);
    expect(merged.grok).toEqual({ type: 'oauth', access: 'new-token', expires: 2000 });
  });

  it('keeps the existing oauth entry when the candidate has no oauth expires', () => {
    const firstPath = path.join(tmpRoot, 'first', 'auth.json');
    const secondPath = path.join(tmpRoot, 'second', 'auth.json');
    writeJson(firstPath, {
      grok: { type: 'oauth', access: 'has-exp', expires: 2000 },
    });
    writeJson(secondPath, {
      grok: { type: 'oauth', access: 'no-exp' },
    });

    const merged = loadAuthMerged([firstPath, secondPath]);
    expect(merged.grok).toEqual({ type: 'oauth', access: 'has-exp', expires: 2000 });
  });

  it('replaces an oauth entry that has no expires when the candidate has a finite expires', () => {
    const firstPath = path.join(tmpRoot, 'first', 'auth.json');
    const secondPath = path.join(tmpRoot, 'second', 'auth.json');
    writeJson(firstPath, {
      grok: { type: 'oauth', access: 'no-exp' },
    });
    writeJson(secondPath, {
      grok: { type: 'oauth', access: 'has-exp', expires: 1000 },
    });

    const merged = loadAuthMerged([firstPath, secondPath]);
    expect(merged.grok).toEqual({ type: 'oauth', access: 'has-exp', expires: 1000 });
  });

  it('uses first-match for non-oauth entries (no freshness comparison)', () => {
    const firstPath = path.join(tmpRoot, 'first', 'auth.json');
    const secondPath = path.join(tmpRoot, 'second', 'auth.json');
    writeJson(firstPath, {
      anthropic: { type: 'api', key: 'first-key' },
    });
    writeJson(secondPath, {
      anthropic: { type: 'api', key: 'second-key' },
    });

    const merged = loadAuthMerged([firstPath, secondPath]);
    expect(merged.anthropic).toEqual({ type: 'api', key: 'first-key' });
  });

  it('merges disjoint providers across files', () => {
    const a = path.join(tmpRoot, 'a', 'auth.json');
    const b = path.join(tmpRoot, 'b', 'auth.json');
    writeJson(a, { grok: { type: 'oauth', access: 'g', expires: 100 } });
    writeJson(b, { anthropic: { type: 'api', key: 'k' } });

    const merged = loadAuthMerged([a, b]);
    expect(merged).toEqual({
      grok: { type: 'oauth', access: 'g', expires: 100 },
      anthropic: { type: 'api', key: 'k' },
    });
  });

  it('skips missing files silently', () => {
    const missing = path.join(tmpRoot, 'nope', 'auth.json');
    const present = path.join(tmpRoot, 'present', 'auth.json');
    writeJson(present, { grok: { type: 'oauth', access: 'g', expires: 100 } });

    const merged = loadAuthMerged([missing, present]);
    expect(merged).toEqual({ grok: { type: 'oauth', access: 'g', expires: 100 } });
  });

  it('skips malformed JSON silently', () => {
    const malformed = path.join(tmpRoot, 'malformed', 'auth.json');
    const present = path.join(tmpRoot, 'present', 'auth.json');
    fs.mkdirSync(path.dirname(malformed), { recursive: true });
    fs.writeFileSync(malformed, '{ not valid json', 'utf8');
    writeJson(present, { grok: { type: 'oauth', access: 'g', expires: 100 } });

    const merged = loadAuthMerged([malformed, present]);
    expect(merged).toEqual({ grok: { type: 'oauth', access: 'g', expires: 100 } });
  });

  it('skips a non-object JSON payload silently', () => {
    const nonObject = path.join(tmpRoot, 'non-object', 'auth.json');
    const present = path.join(tmpRoot, 'present', 'auth.json');
    fs.mkdirSync(path.dirname(nonObject), { recursive: true });
    fs.writeFileSync(nonObject, JSON.stringify(['array', 'not', 'object']), 'utf8');
    writeJson(present, { grok: { type: 'oauth', access: 'g', expires: 100 } });

    const merged = loadAuthMerged([nonObject, present]);
    expect(merged).toEqual({ grok: { type: 'oauth', access: 'g', expires: 100 } });
  });

  it('defaults to authJsonSearchPaths() when no paths argument is given', () => {
    // Smoke test: calling with no args must not throw and must return an object.
    // We cannot assert exact contents without touching the real home dir, but
    // the call must be safe and return a plain object.
    const merged = loadAuthMerged();
    expect(merged).toEqual(expect.any(Object));
  });
});

describe('readGrokAuth', () => {
  it('returns null when the grok auth file is absent', () => {
    const missing = path.join(tmpRoot, 'grok', 'auth.json');
    expect(readGrokAuth(missing)).toBeNull();
  });

  it('returns the parsed object when the grok auth file exists', () => {
    const grokPath = path.join(tmpRoot, 'grok', 'auth.json');
    writeJson(grokPath, { token: 'abc', expires: 9999 });

    expect(readGrokAuth(grokPath)).toEqual({ token: 'abc', expires: 9999 });
  });

  it('returns null for malformed JSON', () => {
    const grokPath = path.join(tmpRoot, 'grok', 'auth.json');
    fs.mkdirSync(path.dirname(grokPath), { recursive: true });
    fs.writeFileSync(grokPath, '{ broken', 'utf8');

    expect(readGrokAuth(grokPath)).toBeNull();
  });

  it('returns null for a non-object JSON payload', () => {
    const grokPath = path.join(tmpRoot, 'grok', 'auth.json');
    fs.mkdirSync(path.dirname(grokPath), { recursive: true });
    fs.writeFileSync(grokPath, JSON.stringify([1, 2, 3]), 'utf8');

    expect(readGrokAuth(grokPath)).toBeNull();
  });
});
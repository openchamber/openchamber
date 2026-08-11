import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { getCandidateBaseUrls, normalizeBaseUrl } from './readiness';

describe('normalizeBaseUrl', () => {
  test('strips trailing slashes', () => {
    assert.equal(normalizeBaseUrl('http://127.0.0.1:4096/'), 'http://127.0.0.1:4096');
    assert.equal(normalizeBaseUrl('http://127.0.0.1:4096///'), 'http://127.0.0.1:4096');
  });

  test('leaves urls without trailing slashes unchanged', () => {
    assert.equal(normalizeBaseUrl('http://127.0.0.1:4096'), 'http://127.0.0.1:4096');
  });
});

describe('getCandidateBaseUrls', () => {
  test('returns origin for urls with a path prefix', () => {
    assert.deepEqual(
      getCandidateBaseUrls('http://127.0.0.1:4096/api'),
      ['http://127.0.0.1:4096']
    );
  });

  test('includes both origin and normalized url for root paths', () => {
    assert.deepEqual(
      getCandidateBaseUrls('http://127.0.0.1:4096/'),
      ['http://127.0.0.1:4096']
    );
    assert.deepEqual(
      getCandidateBaseUrls('http://127.0.0.1:4096'),
      ['http://127.0.0.1:4096']
    );
  });

  test('deduplicates equivalent candidates', () => {
    const candidates = getCandidateBaseUrls('http://127.0.0.1:4096/');
    assert.equal(new Set(candidates).size, candidates.length);
  });

  test('falls back to normalized input for invalid urls', () => {
    assert.deepEqual(getCandidateBaseUrls('not-a-url'), ['not-a-url']);
  });
});

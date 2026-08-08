import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('release certification rejects skipped gates and requires exact evidence', async () => {
  const source = await readFile(new URL('./release-certification.mjs', import.meta.url), 'utf8');
  assert.match(source, /Required certification gate is not passed/);
  assert.match(source, /result !== 'passed'/);
  assert.match(source, /evidence\.commit !== actual\.openchamberCommit/);
  assert.match(source, /Provider certification evidence is not verified/);
  assert.match(source, /Certification evidence SHA-256 mismatch/);
  assert.doesNotMatch(source, /CERTIFICATION_HOOKS/);
  assert.match(source, /bun\.lock/);
  assert.match(source, /appleContainerManagedEgress/);
  assert.match(source, /failureInjection/);
  assert.match(source, /securityReview/);
  assert.match(source, /Certification evidence timestamp is invalid or stale/);
  assert.match(source, /--print-template/);
});

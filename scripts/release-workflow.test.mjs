import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));
const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf8'));

test('package-manager listings wait for the published release and skip dry runs', () => {
  const job = workflow.jobs['publish-package-managers'];
  assert.deepEqual(job.needs, ['create-release', 'finalize-release']);
  assert.match(job.if, /needs\.finalize-release\.result == 'success'/);
  assert.match(job.if, /dry_run != 'true'/);
  // The release is already public, so nothing may wait on this job.
  for (const other of Object.values(workflow.jobs)) {
    assert.ok(![].concat(other.needs ?? []).includes('publish-package-managers'));
  }
});

test('manifests combine after partial build failures while publication stays strict', () => {
  assert.equal(
    workflow.jobs['combine-electron-manifests'].if,
    "${{ !cancelled() && needs.create-release.result == 'success' }}",
  );
  // Skipped jobs count as done; any failure still stops the release.
  assert.equal(workflow.jobs['finalize-release'].if, "${{ !cancelled() && !failure() }}");
});

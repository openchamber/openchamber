import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));
const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf8'));

test('release recovery tolerates build failures without bypassing publication gates', () => {
  assert.equal(
    workflow.jobs['combine-electron-manifests'].if,
    "${{ !cancelled() && needs.create-release.result == 'success' }}",
  );
  assert.equal(
    workflow.jobs['finalize-release'].if,
    "${{ !cancelled() && needs.combine-electron-manifests.result == 'success' && github.event.inputs.dry_run != 'true' }}",
  );
});

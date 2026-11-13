import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));
const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf8'));
const finalize = workflow.jobs['finalize-release'];
const stepOf = (job, name) => workflow.jobs[job].steps.find((step) => step.name === name);

test('a release reaches updaters only once desktop, server and Android are all attached', () => {
  // Updaters read only the latest full release, never a prerelease.
  const create = stepOf('create-release', 'Create GitHub Release');
  assert.equal(create.with.prerelease, true);
  assert.equal(create.with.draft, undefined);

  assert.ok(finalize.needs.includes('mobile-release'));
  const verify = stepOf('finalize-release', 'Verify desktop, server and Android release assets');
  for (const asset of ['-win-x64.exe', '-win-arm64.exe', '-linux-x86_64.AppImage', '-linux-arm64.AppImage', '-linux-amd64.deb', '-linux-x86_64.rpm', '-linux-arm64.deb', '-linux-aarch64.rpm', 'openchamber-web-', 'openchamber-sdk-', '-android.apk']) {
    assert.ok(verify.run.includes(asset), `finalize-release must check for ${asset}`);
  }

  const publish = stepOf('finalize-release', 'Publish release');
  assert.ok(finalize.steps.indexOf(publish) > finalize.steps.indexOf(verify));
  assert.equal(publish.with.prerelease, false);
  assert.equal(publish.if, "${{ github.event.inputs.dry_run != 'true' }}");
});

test('Stable Android builds use the shared epoch code and verify that same artifact', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-release-version-'));
  try {
    const output = path.join(directory, 'output');
    const before = Math.floor(Date.now() / 60_000);
    execFileSync('bash', ['-euc', stepOf('create-release', 'Get version').run], {
      env: { ...process.env, GITHUB_OUTPUT: output, RELEASE_INPUT_VERSION: '2.6.1', RELEASE_REF: 'refs/tags/v2.6.1' },
    });
    const values = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map((line) => line.split('=')));
    const code = Number(values.build_number);
    assert.ok(Number.isSafeInteger(code) && code >= before && code <= Math.floor(Date.now() / 60_000));
    assert.equal(values.version, '2.6.1');
    assert.equal(workflow.jobs['create-release'].outputs.build_number, '${{ steps.get_version.outputs.build_number }}');
    assert.equal(workflow.jobs['mobile-release'].with.build_number, '${{ needs.create-release.outputs.build_number }}');
    assert.equal(stepOf('finalize-release', 'Verify desktop, server and Android release assets').env.BUILD_NUMBER, '${{ needs.create-release.outputs.build_number }}');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import vm from 'node:vm';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));
const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf8'));
const finalize = workflow.jobs['finalize-release'];
const stepOf = (job, name) => workflow.jobs[job].steps.find((step) => step.name === name);
const canary = yaml.parse(fs.readFileSync(new URL('../.github/workflows/canary.yml', import.meta.url), 'utf8'));
const mobile = yaml.parse(fs.readFileSync(new URL('../.github/workflows/mobile-release.yml', import.meta.url), 'utf8'));

test('stable uploads preserve prerelease status and attach both server packages', () => {
  // Given the action configuration used for every stable asset upload.
  const uploads = Object.entries(workflow.jobs).flatMap(([job, value]) =>
    (value.steps ?? []).filter((step) => step.uses?.startsWith('softprops/action-gh-release@') && step.with.files)
      .map((step) => ({ job, step })));
  // When uploads run before the final inventory check.
  for (const { job, step } of uploads) {
    // Then no uploader can turn the release into a draft or a full release.
    assert.equal(step.with.draft, undefined, job);
    assert.notEqual(step.with.prerelease, false, job);
  }
  const packages = stepOf('package-tarball', 'Upload npm tarball to release').with.files.trim().split('\n');
  assert.deepEqual(packages, ['packages/web/*.tgz', 'packages/sdk/*.tgz']);
});

test('the stable inventory rejects missing, duplicate, empty assets and API errors', async () => {
  // Given all assets required by the fork's supported platforms.
  const version = '2.7.3';
  const build = '30000000';
  const names = [
    `OpenChamber-${version}-win-x64.exe`, `OpenChamber-${version}-win-arm64.exe`,
    'latest.yml', 'latest-arm64.yml', 'latest-linux.yml', 'latest-linux-arm64.yml',
    ...['x86_64.AppImage', 'amd64.deb', 'x86_64.rpm', 'arm64.AppImage', 'arm64.deb', 'aarch64.rpm']
      .map((suffix) => `OpenChamber-${version}-linux-${suffix}`),
    `openchamber-web-${version}.tgz`, `openchamber-sdk-${version}.tgz`,
    `OpenChamber-${version}-${build}-android.apk`,
  ];
  const assets = names.map((name) => ({ name, size: 42 }));
  const run = stepOf('finalize-release', 'Verify desktop, server and Android release assets').run;
  const source = run.match(/<<'NODE'\n([\s\S]*)\nNODE/)[1];
  async function inspect(candidate, ok = true) {
    let status = 0;
    await vm.runInNewContext(source, {
      process: { env: { REPOSITORY: 'rubimpassos/openchamber', VERSION: version, RELEASE_ID: '123', BUILD_NUMBER: build, GITHUB_TOKEN: 'fixture' }, exit: (code) => { status = code; } },
      fetch: async (url) => {
        assert.equal(url, 'https://api.github.com/repos/rubimpassos/openchamber/releases/123');
        return { ok, status: 503, text: async () => 'unavailable', json: async () => ({ assets: candidate }) };
      },
      console: { log() {}, error() {} },
    });
    return status;
  }
  // When the actual workflow script inspects each inventory.
  // Then only a complete, nonempty inventory succeeds.
  assert.equal(await inspect(assets), 0);
  for (const asset of assets) {
    assert.equal(await inspect(assets.filter((item) => item !== asset)), 1, asset.name);
    assert.equal(await inspect([...assets, asset]), 1, asset.name);
    assert.equal(await inspect(assets.map((item) => item === asset ? { ...item, size: 0 } : item)), 1, asset.name);
  }
  assert.equal(await inspect(assets, false), 1);
});

for (const failUpload of [false, true]) test(`Canary ${failUpload ? 'stops before manifests when a payload upload fails' : 'retains current tarballs and the previous installed build'}`, () => {
  // Given a previous Canary and downloaded files from the current build.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-canary-publish-'));
  const version = '2.7.4-canary.20261116.20';
  const previous = '2.7.4-canary.20261115.19';
  const sdk = `openchamber-sdk-${version}.tgz`;
  const web = `openchamber-web-${version}.tgz`;
  const old = [`openchamber-sdk-${previous}.tgz`, `openchamber-web-${previous}.tgz`, `OpenChamber-${previous}-win-x64.exe`, 'obsolete.tgz'];
  try {
    fs.mkdirSync(path.join(directory, 'files'));
    fs.mkdirSync(path.join(directory, 'bin'));
    for (const name of [sdk, web, `OpenChamber-${version}-win-x64.exe`, 'latest-linux.yml', 'latest-linux-arm64.yml']) {
      fs.writeFileSync(path.join(directory, 'files', name), 'fixture');
    }
    for (const name of ['latest.yml', 'latest-arm64.yml', 'canary-notes.json']) fs.writeFileSync(path.join(directory, name), 'fixture');
    fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({ assets: old, commands: [] }));
    fs.writeFileSync(path.join(directory, 'bin', 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const state = JSON.parse(fs.readFileSync('state.json', 'utf8'));
const args = process.argv.slice(2);
state.commands.push(args);
if (args[1] === 'view') console.log(state.assets.join('\\n'));
if (args[1] === 'upload' && process.env.FAIL_UPLOAD === 'true' && args.some((arg) => arg.endsWith('.exe'))) {
  fs.writeFileSync('state.json', JSON.stringify(state));
  process.exit(1);
}
if (args[1] === 'upload') for (const file of args.slice(3).filter((arg) => !arg.startsWith('--'))) {
  if (!fs.statSync(file).size) process.exit(1);
  state.assets.push(path.basename(file));
}
if (args[1] === 'delete-asset') state.assets = state.assets.filter((name) => name !== args[3]);
fs.writeFileSync('state.json', JSON.stringify(state));
`, { mode: 0o755 });
    // When the real publication script runs against a filesystem-backed gh fake.
    const publish = canary.jobs.publish.steps.find((step) => step.name === 'Publish to the canary pre-release');
    const options = {
      cwd: directory,
      env: { ...process.env, PATH: `${directory}/bin:${process.env.PATH}`, RUNNER_TEMP: directory, VERSION: version, SHA: 'a'.repeat(40), GH_REPO: 'rubimpassos/openchamber', BUILD_NUMBER: '30000000', FAIL_UPLOAD: String(failUpload) },
    };
    if (failUpload) assert.throws(() => execFileSync('bash', ['-euc', publish.run], options));
    else execFileSync('bash', ['-euc', publish.run], options);
    // Then current server assets and the previous installable build survive cleanup.
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8'));
    if (failUpload) {
      assert.ok(state.commands.every((args) => !['delete-asset', 'edit'].includes(args[1])));
      assert.ok(state.commands.every((args) => !args.includes(`${directory}/latest.yml`)));
      return;
    }
    for (const name of [sdk, web, ...old.slice(0, 3)]) assert.ok(state.assets.includes(name), name);
    assert.ok(!state.assets.includes('obsolete.tgz'));
    const uploads = state.commands.filter((args) => args[1] === 'upload');
    assert.equal(uploads[0][3], `files/${sdk}`);
    assert.ok(uploads[1].includes(`files/${web}`));
    assert.ok(uploads.at(-1).includes(`${directory}/latest.yml`));
    assert.equal(state.commands.at(-1)[1], 'edit');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fork release jobs use supported runners and credentials only', () => {
  // Given the stable workflow and the active fork legs of the reusable workflows.
  const active = [workflow.jobs, Object.fromEntries(Object.entries(canary.jobs).filter(([name]) => !['build-macos', 'build-ios'].includes(name))),
    Object.fromEntries(Object.entries(mobile.jobs).filter(([name]) => name !== 'ios-testflight'))];
  const allowedSecrets = new Set(['GITHUB_TOKEN', 'ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD']);
  // When resolving job dependencies and secret references.
  for (const jobs of active) for (const [name, job] of Object.entries(jobs)) {
    for (const dependency of [job.needs ?? []].flat()) assert.ok(jobs[dependency], `${name} needs ${dependency}`);
    for (const [, secret] of JSON.stringify(job).matchAll(/secrets\.([A-Z_0-9]+)/g)) {
      // Then every secret belongs to the existing fork signing/publication setup.
      assert.ok(allowedSecrets.has(secret), `${name}: ${secret}`);
    }
  }
  assert.equal(workflow.jobs['build-desktop-electron-windows']['runs-on'], 'windows-2022');
  assert.equal(mobile.jobs['android-release'].environment, 'signing');
  for (const trigger of ['workflow_dispatch', 'workflow_call']) assert.equal(mobile.on[trigger].inputs.build_ios.default, false);
});

test('publication gates reject failed builds and Apple jobs remain unreachable on the fork', () => {
  // Given GitHub job results for the supported release platforms.
  const github = { repository: 'rubimpassos/openchamber' };
  function evaluate(expression, needs, failure = false) {
    const source = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/needs\.([\w-]+)/g, 'needs["$1"]');
    return vm.runInNewContext(source, {
      github, needs, inputs: { build_ios: true }, cancelled: () => false, failure: () => failure,
    });
  }
  const needs = Object.fromEntries(canary.jobs.publish.needs.map((name) => [name, { result: 'success', outputs: { build: 'true' } }]));
  // When GitHub evaluates the workflow conditions on this fork.
  assert.equal(evaluate(canary.jobs.publish.if, needs), true);
  for (const name of canary.jobs.publish.needs.filter((job) => job !== 'prepare')) {
    for (const result of ['failure', 'skipped', 'cancelled']) {
      // Then no incomplete Canary is published, and no Apple runner starts.
      assert.equal(evaluate(canary.jobs.publish.if, { ...needs, [name]: { result } }), false, `${name}: ${result}`);
    }
  }
  assert.equal(evaluate(canary.jobs['build-macos'].if, needs), false);
  assert.equal(evaluate(canary.jobs['build-ios'].if, needs), false);
  assert.equal(evaluate(mobile.jobs['ios-testflight'].if, needs), false);
  assert.equal(evaluate(finalize.if, {}, true), false);
});

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

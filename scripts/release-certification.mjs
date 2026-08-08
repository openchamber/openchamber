#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const release = process.argv.includes('--release');
const printTemplate = process.argv.includes('--print-template');
const evidencePath = process.env.CERTIFICATION_EVIDENCE || '.release-certification/evidence.json';
const REQUIRED_GATES = [
  'coreTests', 'compatibility', 'failureInjection', 'artifactApply', 'relayTransport',
  'hostedWeb', 'hostedMobile', 'capacitorMobile',
  'electronMacos', 'windowsPackage', 'linuxPackage',
  'iosSimulator', 'androidEmulator',
  'dockerProvider', 'kubernetesProvider', 'appleContainerProvider', 'appleContainerManagedEgress',
  'checksums', 'signatures', 'manifests', 'securityReview',
];

const fail = (message) => {
  throw new Error(message);
};

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const exact = (value, name) => {
  if (!value || typeof value !== 'string' || /^(unknown|latest|skipped|pending|tbd)$/i.test(value)) {
    fail(`Missing exact ${name}`);
  }
  return value;
};
const requireMatch = (value, name, pattern) => {
  const resolved = exact(value, name);
  if (!pattern.test(resolved)) fail(`Invalid exact ${name}: ${resolved}`);
  return resolved;
};

const packageJson = await readJson('package.json');
const webPackage = await readJson('packages/web/package.json');
const electronPackage = await readJson('packages/electron/package.json');
const lockfile = await readFile('bun.lock', 'utf8');
const pluginSpec = webPackage.devDependencies?.['@openchamber/opencode-container-workspace']
  || webPackage.dependencies?.['@openchamber/opencode-container-workspace']
  || electronPackage.devDependencies?.['@openchamber/opencode-container-workspace'];
const pluginCommit = pluginSpec?.match(/#([0-9a-f]{40})$/i)?.[1];
const sdkVersion = packageJson.dependencies?.['@opencode-ai/sdk'];
const pluginApiVersion = lockfile.match(/"@openchamber\/opencode-container-workspace"[^\n]*"@opencode-ai\/plugin": "([^"]+)"/)?.[1];

const actual = {
  openchamberCommit: process.env.GITHUB_SHA,
  pluginCommit,
  opencodeVersion: process.env.OPENCODE_VERSION,
  sdkVersion,
  pluginApiVersion,
  runtimeImage: process.env.RUNTIME_IMAGE,
  gatewayImage: process.env.GATEWAY_IMAGE,
};

if (printTemplate) {
  console.log(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    commit: actual.openchamberCommit,
    identities: actual,
    gates: Object.fromEntries(REQUIRED_GATES.map((name) => [name, 'pending'])),
    providerEvidence: {
      status: 'pending',
      commit: actual.openchamberCommit,
      pluginCommit: actual.pluginCommit,
      runtimeImage: actual.runtimeImage,
      gatewayImage: actual.gatewayImage,
    },
  }, null, 2));
  process.exit(0);
}

if (release) {
  for (const [key, value] of Object.entries(actual)) exact(value, key);
  requireMatch(actual.openchamberCommit, 'OpenChamber commit', /^[a-f0-9]{40}$/i);
  requireMatch(actual.pluginCommit, 'plugin commit', /^[a-f0-9]{40}$/i);
  requireMatch(actual.sdkVersion, 'SDK version', /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  requireMatch(actual.pluginApiVersion, 'plugin API version', /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  requireMatch(actual.opencodeVersion, 'OpenCode version', /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  requireMatch(actual.runtimeImage, 'runtime image digest', /^ghcr\.io\/openchamber\/opencode-workspace@sha256:[a-f0-9]{64}$/i);
  requireMatch(actual.gatewayImage, 'gateway image digest', /^ghcr\.io\/openchamber\/workspace-egress-gateway@sha256:[a-f0-9]{64}$/i);
}

let evidence;
try {
  const evidenceBytes = await readFile(evidencePath);
  if (release) {
    const expectedDigest = exact(process.env.CERTIFICATION_EVIDENCE_SHA256, 'certification evidence SHA-256');
    if (!/^[a-f0-9]{64}$/i.test(expectedDigest)) fail('Certification evidence SHA-256 must be a 64-character hex digest');
    const actualDigest = crypto.createHash('sha256').update(evidenceBytes).digest('hex');
    if (actualDigest !== expectedDigest.toLowerCase()) fail('Certification evidence SHA-256 mismatch');
  }
  evidence = JSON.parse(evidenceBytes.toString('utf8'));
} catch (error) {
  if (release) fail(`Certification evidence is required at ${evidencePath}: ${error.message}`);
  console.warn(`Certification evidence unavailable for manual preparation: ${error.message}`);
  process.exit(0);
}

if (evidence.commit !== actual.openchamberCommit) fail('Certification evidence is for a different OpenChamber commit');
if (evidence.schemaVersion !== 1) fail('Unsupported certification evidence schema');
const generatedAt = Date.parse(evidence.generatedAt);
if (!Number.isFinite(generatedAt) || generatedAt > Date.now() + 5 * 60 * 1000 || generatedAt < Date.now() - 7 * 24 * 60 * 60 * 1000) {
  fail('Certification evidence timestamp is invalid or stale');
}
for (const [key, value] of Object.entries(actual)) {
  if (evidence.identities?.[key] !== value) fail(`Evidence identity mismatch: ${key}`);
}

for (const name of REQUIRED_GATES) {
  const result = evidence.gates?.[name];
  if (result !== 'passed') fail(`Required certification gate is not passed: ${name} (${result ?? 'missing'})`);
}

if (evidence.providerEvidence?.status !== 'verified') fail('Provider certification evidence is not verified');
if (evidence.providerEvidence.commit !== actual.openchamberCommit) fail('Provider evidence is not bound to this commit');
if (evidence.providerEvidence.pluginCommit !== actual.pluginCommit) fail('Provider evidence is not bound to this plugin commit');
if (evidence.providerEvidence.runtimeImage !== actual.runtimeImage || evidence.providerEvidence.gatewayImage !== actual.gatewayImage) {
  fail('Provider evidence is not bound to the exact image digests');
}

console.log(JSON.stringify({ status: 'passed', release, identities: actual }, null, 2));

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Conformance for the quota provider manifest (design #1808, phase 1 #1809):
// the VS Code dispatch switch and the listConfiguredQuotaProviders configured
// set are surfaces of the one logical provider set the manifest states (the
// canonical file lives with the web quota module; this test reads it from
// the repo tree by relative path). A provider that appears in a list but not
// the manifest fails, and so does a manifest provider silently absent from a
// list - a surface absence is only ever a named exception in the manifest,
// never a silent one (contract rule 2).

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(path.join(here, '../../web/server/lib/quota/provider-manifest.json'), 'utf8')
);
const source = fs.readFileSync(path.join(here, 'quotaProviders.ts'), 'utf8');

const expectedFor = (surface: string) => new Set<string>(
  [...manifest.providers, ...manifest.aliases]
    .filter((row: { surfaces: Record<string, boolean> }) => row.surfaces[surface])
    .map((row: { id: string }) => row.id)
);

const dispatchIds = () => {
  const start = source.indexOf('switch (providerId)');
  assert.notEqual(start, -1, 'dispatch switch not found');
  const window = source.slice(start, start + 12000);
  const body = window.slice(0, window.indexOf('default:'));
  return new Set([...body.matchAll(/case\s+'([^']+)'/g)].map((match) => match[1]));
};

const configuredIds = () => {
  const start = source.indexOf('export const listConfiguredQuotaProviders');
  assert.notEqual(start, -1, 'listConfiguredQuotaProviders not found');
  const rest = source.slice(start);
  const end = rest.indexOf('\nexport const ', 10);
  const body = end === -1 ? rest : rest.slice(0, end);
  return new Set([...body.matchAll(/configured\.add\('([^']+)'\)/g)].map((match) => match[1]));
};

describe('quota provider manifest (vscode)', () => {
  it('the dispatch switch is exactly the manifest vscode_dispatch surface', () => {
    assert.deepEqual(dispatchIds(), expectedFor('vscode_dispatch'));
  });

  it('the configured set is exactly the manifest vscode_configured surface', () => {
    assert.deepEqual(configuredIds(), expectedFor('vscode_configured'));
  });

  it('dispatch and configured sets agree with each other', () => {
    assert.deepEqual(dispatchIds(), configuredIds());
  });
});

// Managed-credential conformance (issue #2281): the bridge credentials
// handler and the webview fetch interceptor are surfaces of the one
// managed-credential provider set stated in quotaCredentials.ts
// (MANAGED_PROVIDERS). A provider missing from either surface — the
// opendesign gap this guards — fails here, as does a surface inventing
// its own list.
const credentialsSource = fs.readFileSync(path.join(here, 'quotaCredentials.ts'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(here, 'bridge-system-runtime.ts'), 'utf8');
const webviewSource = fs.readFileSync(path.join(here, '../webview/main.tsx'), 'utf8');

const managedProviders = () => {
  const match = credentialsSource.match(/MANAGED_PROVIDERS[^=]*=\s*\[([^\]]+)\]/);
  assert.ok(match, 'MANAGED_PROVIDERS not found in quotaCredentials.ts');
  return new Set([...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]));
};

const interceptorRegex = () => {
  const line = webviewSource.split('\n').find((entry) => entry.includes('quotaCredentialMatch') && entry.includes('pathname.match'));
  assert.ok(line, 'webview quota credential interceptor not found');
  const literal = line.match(/pathname\.match\((\/.+\/)\)/)?.[1];
  assert.ok(literal, 'interceptor regex literal not found');
  return new RegExp(literal.slice(1, literal.lastIndexOf('/')));
};

describe('managed credential surfaces (vscode)', () => {
  it('the bridge credentials handler derives its allowlist from MANAGED_PROVIDERS', () => {
    const start = bridgeSource.indexOf("case 'api:quota:credentials'");
    assert.notEqual(start, -1, 'bridge credentials case not found');
    const body = bridgeSource.slice(start, start + 4000);
    assert.ok(body.includes('MANAGED_PROVIDERS'), 'bridge allowlist must use the shared MANAGED_PROVIDERS constant');
    assert.ok(!/\['exe-dev', 'cursor', 'zenmux'\]/.test(body), 'bridge must not keep a separate hardcoded provider list');
    assert.ok(managedProviders().size > 0);
  });

  it('the webview interceptor alternation is exactly the managed-credential provider set', () => {
    const line = webviewSource.split('\n').find((entry) => entry.includes('quotaCredentialMatch') && entry.includes('pathname.match'));
    assert.ok(line);
    const alternation = line.match(/credentials\\\/\(([^)]+)\)/)?.[1];
    assert.ok(alternation, 'interceptor provider alternation not found');
    assert.deepEqual(new Set(alternation.split('|')), managedProviders());
  });

  it('the webview interceptor routes every managed provider credential path incl. validate and import', () => {
    const regex = interceptorRegex();
    for (const provider of managedProviders()) {
      assert.ok(regex.test(`/api/quota/credentials/${provider}`), `${provider} base path`);
      assert.ok(regex.test(`/api/quota/credentials/${provider}/validate`), `${provider} validate path`);
      assert.ok(regex.test(`/api/quota/credentials/${provider}/import`), `${provider} import path`);
    }
    assert.ok(!regex.test('/api/quota/credentials/command-code'), 'command-code is not a managed credential provider');
  });
});

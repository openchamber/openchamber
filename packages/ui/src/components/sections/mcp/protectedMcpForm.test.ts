import { describe, expect, test } from 'bun:test';
import { getRuntimeUrlResolver, configureRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { getProtectedConnection, type ProtectedConnectionView, type ProtectedDefinition } from './protectedMcp';
import {
  changeKind,
  definitionFromForm,
  destinationChanged,
  emptyProtectedForm,
  formFromConnection,
  secretsToType,
  slotFor,
  type ProtectedForm,
} from './protectedMcpForm';

/**
 * A connection view as the broker answers it, parsed by the real client, so
 * the fixtures stay in the broker's grammar (`service/dev-server-manifest.js`
 * shapes, normalized as `parseDefinition` returns them).
 */
const viewOf = async (editable: ProtectedDefinition, secrets: Record<string, { set: boolean }> = {}): Promise<ProtectedConnectionView> => {
  const previousFetch = globalThis.fetch;
  const previousResolver = getRuntimeUrlResolver();
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.test' });
  const body = JSON.stringify({ connection: { id: 'pmcp_00000000000000a1', name: editable.name, revision: 3, enabled: editable.enabled, transport: editable.transport, secrets, credential: 'stored', editable } });
  globalThis.fetch = async () => new Response(body, { headers: { 'Content-Type': 'application/json' } });
  try {
    return await getProtectedConnection('pmcp_00000000000000a1');
  } finally {
    globalThis.fetch = previousFetch;
    setRuntimeUrlResolver(previousResolver);
  }
};

const github: ProtectedDefinition = {
  name: 'precocerto-github', enabled: true, transport: 'stdio',
  stdio: { command: '/usr/local/bin/github-mcp-server', args: ['stdio', '--toolsets', 'repos,issues,pull_requests,actions,code_security'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: { secret: 'token' } } },
  policy: {},
};

const microsoft: ProtectedDefinition = {
  name: 'precocerto-microsoft', enabled: true, transport: 'stdio',
  stdio: {
    command: '/opt/mcp-microsoft/node_modules/.bin/ms-365-mcp-server',
    args: ['--org-mode'],
    env: {
      MS365_MCP_TOKEN_CACHE_PATH: { state: 'token-cache.json' },
      MS365_MCP_SELECTED_ACCOUNT_PATH: { state: 'selected-account.json' },
      MS365_MCP_LOG_DIR: { state: 'logs' },
      MS365_MCP_USE_KEYTAR: '0',
    },
  },
  policy: {},
};

const gcp: ProtectedDefinition = {
  name: 'precocerto-gcp', enabled: true, transport: 'stdio',
  stdio: {
    command: '/opt/mcp-gcp/node_modules/.bin/gcloud-mcp',
    args: [],
    env: {
      CLOUDSDK_CONFIG: { state: 'gcloud' },
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: { secretFile: 'service_account' },
      CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
      CLOUDSDK_CORE_PROJECT: 'example-project',
    },
  },
  policy: {},
};

const harness: ProtectedDefinition = {
  name: 'precocerto-harness', enabled: true, transport: 'http',
  http: { url: 'https://mcp.harness.io/mcp', headers: {}, oauth: { scopes: ['openid', 'offline_access'], clientId: 'mcp-client' } },
  policy: { denyTools: ['harness_create', 'harness_update', 'harness_delete', 'harness_execute'], defaultArguments: { org_id: 'org', project_id: 'project' } },
};

const bridge: ProtectedDefinition = {
  name: 'precocerto-atlassian', enabled: true, transport: 'http',
  http: { url: 'http://127.0.0.1:18080/mcp', headers: {} },
  policy: {},
};

describe('migrated connections survive an edit unchanged', () => {
  const cases: [string, ProtectedDefinition, Record<string, { set: boolean }>][] = [
    ['GitHub, stdio with a secret environment value', github, { token: { set: true } }],
    ['Microsoft, stdio with private paths', microsoft, {}],
    ['GCP, stdio with a secret file, a private path and text', gcp, { service_account: { set: true } }],
    ['Harness, http with an OAuth client id, hidden tools and default arguments', harness, {}],
    ['a bridge, http with a URL only', bridge, {}],
  ];
  for (const [label, definition, secrets] of cases) {
    test(label, async () => {
      const view = await viewOf(definition, secrets);
      expect(definitionFromForm(formFromConnection(view))).toEqual({ definition, secrets: {} });
      expect(changeKind(view, formFromConnection(view))).toBe('none');
      expect(secretsToType(view, formFromConnection(view))).toEqual([]);
    });
  }
});

describe('secret slots', () => {
  test('a new slot follows the label, within the slot grammar', () => {
    expect(slotFor('GITHUB_TOKEN', new Set())).toBe('github_token');
    expect(slotFor('X-Api-Key', new Set())).toBe('x-api-key');
    expect(slotFor('__Weird Name!', new Set())).toBe('weird_name_');
    expect(slotFor('***', new Set())).toBe('secret');
    expect(slotFor('A'.repeat(40), new Set())).toBe('a'.repeat(32));
  });

  test('a collision appends a counter within 32 characters', () => {
    expect(slotFor('token', new Set(['token']))).toBe('token-2');
    expect(slotFor('token', new Set(['token', 'token-2']))).toBe('token-3');
    const long = 'b'.repeat(32);
    expect(slotFor(long, new Set([long]))).toBe(`${'b'.repeat(30)}-2`);
  });

  test('new secrets get their own slots beside existing ones, and only typed values are sent', async () => {
    const form = formFromConnection(await viewOf(github, { token: { set: true } }));
    form.env.push(
      { key: 'TOKEN', kind: 'secret', text: '', slot: null, stored: false, secret: 'typed-a' },
      { key: 'token', kind: 'secretFile', text: '', slot: null, stored: false, secret: '' },
    );
    const { definition, secrets } = definitionFromForm(form);
    expect(definition.transport === 'stdio' ? definition.stdio.env : null).toEqual({
      GITHUB_PERSONAL_ACCESS_TOKEN: { secret: 'token' },
      TOKEN: { secret: 'token-2' },
      token: { secretFile: 'token-3' },
    });
    expect(secrets).toEqual({ 'token-2': 'typed-a' });
  });

  test('header and OAuth client secrets are named after the header and oauth_client_secret', () => {
    const form = emptyProtectedForm('api', 'http');
    form.url = 'https://api.test/mcp';
    form.headers.push({ name: 'X-Api-Key', kind: 'secret', text: '', prefix: '', slot: null, stored: false, secret: 'k' });
    form.oauth = { enabled: true, scopes: ['read'], clientId: '', clientSecret: { slot: null, stored: false, secret: 'c' }, issuer: '', redirectUri: '' };
    expect(definitionFromForm(form)).toEqual({
      definition: {
        name: 'api', enabled: true, transport: 'http',
        http: { url: 'https://api.test/mcp', headers: { 'X-Api-Key': { secret: 'x-api-key' } }, oauth: { scopes: ['read'], clientSecret: { secret: 'oauth_client_secret' } } },
        policy: {},
      },
      secrets: { 'x-api-key': 'k', oauth_client_secret: 'c' },
    });
  });
});

describe('destination changes', () => {
  const edit = async (definition: ProtectedDefinition, change: (form: ProtectedForm) => void) => {
    const form = formFromConnection(await viewOf(definition));
    const saved = definitionFromForm(form).definition;
    change(form);
    return destinationChanged(saved, definitionFromForm(form).definition);
  };
  const apiKeyHeader: ProtectedDefinition = {
    ...bridge,
    http: { url: 'https://api.test/mcp', headers: { Authorization: { secret: 'key', prefix: 'Bearer ' } } },
  };

  test('a text environment value is part of the destination', async () => {
    expect(await edit(gcp, (form) => {
      const row = form.env.find((entry) => entry.key === 'CLOUDSDK_CORE_PROJECT');
      if (row) row.text = 'other-project';
    })).toBe(true);
  });

  test('a header prefix is part of the destination', async () => {
    expect(await edit(apiKeyHeader, (form) => {
      const [row] = form.headers;
      if (row) row.prefix = 'Token ';
    })).toBe(true);
  });

  test('an OAuth scope is part of the destination', async () => {
    expect(await edit(harness, (form) => { form.oauth.scopes.push('admin'); })).toBe(true);
  });

  test('a fixed redirect address is part of the destination', async () => {
    expect(await edit(harness, (form) => { form.oauth.redirectUri = 'https://fixed.test/callback'; })).toBe(true);
  });

  test('tool policy and enabled are not', async () => {
    expect(await edit(harness, (form) => {
      form.policy.denyTools = [];
      form.policy.defaultArguments.push({ name: 'account_id', value: 'acc' });
      form.enabled = false;
    })).toBe(false);
  });

  test('reordering environment rows is not', async () => {
    expect(await edit(gcp, (form) => { form.env.reverse(); })).toBe(false);
  });
});

describe('what saving asks for', () => {
  test('without a destination change only secrets neither stored nor typed are asked for', async () => {
    const view = await viewOf(gcp, { service_account: { set: true } });
    const unchanged = formFromConnection(view);
    unchanged.policy.allowTools = ['list_*'];
    expect(changeKind(view, unchanged)).toBe('autosave');
    expect(secretsToType(view, unchanged)).toEqual([]);

    const missingView = await viewOf(gcp, { service_account: { set: false } });
    expect(secretsToType(missingView, formFromConnection(missingView))).toEqual(['CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE']);
  });

  test('a destination change asks for every secret that is not typed again', async () => {
    const view = await viewOf(github, { token: { set: true } });
    const form = formFromConnection(view);
    form.args.push({ kind: 'text', value: '--read-only' });
    expect(changeKind(view, form)).toBe('destination');
    expect(secretsToType(view, form)).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN']);
    const [row] = form.env;
    if (row) row.secret = 'retyped';
    expect(secretsToType(view, form)).toEqual([]);
  });

  test('an untouched form has nothing to save', async () => {
    const view = await viewOf(harness);
    expect(changeKind(view, formFromConnection(view))).toBe('none');
  });
});

describe('V7 configured secrets after revocation', () => {
  const revokedOAuth: ProtectedDefinition = {
    ...harness,
    http: { ...harness.http, headers: { 'X-Api-Key': { secret: 'api_key', prefix: '' } }, oauth: { scopes: [], clientSecret: { secret: 'oauth_client_secret' } } },
  };

  test('retains header and OAuth references when no values remain stored', async () => {
    // Given revoked configured slots.
    const view = await viewOf(revokedOAuth, { api_key: { set: false }, oauth_client_secret: { set: false } });
    // When the unchanged form is serialized.
    const result = definitionFromForm(formFromConnection(view));
    // Then configuration survives independently of credential availability.
    expect(result).toEqual({ definition: revokedOAuth, secrets: {} });
  });

  test('requires every configured HTTP secret when the destination changes after revocation', async () => {
    // Given revoked header and OAuth slots.
    const view = await viewOf(revokedOAuth, { api_key: { set: false }, oauth_client_secret: { set: false } });
    const form = formFromConnection(view);
    // When the destination changes.
    form.url = 'https://different.test/mcp';
    // Then both configured secrets must be retyped.
    expect(secretsToType(view, form)).toEqual(['X-Api-Key', 'oauth_client_secret']);
  });

  test('retains secret environment and file references when their values are missing', async () => {
    // Given missing environment and secret-file slots.
    const raw: ProtectedDefinition = { ...gcp, stdio: { ...gcp.stdio, env: { ...gcp.stdio.env, TOKEN: { secret: 'token' } } } };
    const view = await viewOf(raw, { service_account: { set: false }, token: { set: false } });
    // When the form is serialized without entering values.
    const result = definitionFromForm(formFromConnection(view));
    // Then both references remain in the definition.
    expect(result).toEqual({ definition: raw, secrets: {} });
  });
});

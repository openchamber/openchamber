#!/usr/bin/env node
// Builds a migration manifest from dev-server's workspace catalog, the
// non-secret `ansible/group_vars/all/workspaces.json`. It reads no credential:
// the manifest names the files where the root-run migration finds them, with
// the same paths, policies and pins the Ansible role renders.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isPlainObject, isString } from '../../shared/guards.js';
import { ProtectedMcpError } from './contract.js';

/** The pins of `ansible/roles/workspaces/defaults/main.yml` this was written against. */
const DEV_SERVER_DEFAULTS = {
  atlassianOauthUrl: 'https://mcp.atlassian.com/v1/mcp/authv2',
  atlassianLegacyUrl: 'https://mcp.atlassian.com/v1/mcp',
  atlassianLegacyIssuer: 'https://mcp.atlassian.com',
  atlassianTokenUrl: 'https://mcp.atlassian.com/v2/mcp',
  sentryUrl: 'https://mcp.sentry.dev/mcp',
  harnessUrl: 'https://mcp.harness.io/mcp',
  harnessClientId: 'mcp-client',
  harnessWriteTools: ['harness_create', 'harness_update', 'harness_delete', 'harness_execute'],
};

const ENV_DIR = '/etc/dev-server/mcp';
const STATE_ROOT = '/var/lib/dev-server-mcp';

/** A stable connection id per domain and provider, so a regenerated manifest matches what was migrated. */
export const connectionIdFor = (domain, provider) => `pmcp_${createHash('sha256').update(`dev-server:${domain}/${provider}`).digest('hex').slice(0, 16)}`;

const envCredential = (domain, provider, key) => ({ envFile: `${ENV_DIR}/${domain}/${provider}.env`, key });

/**
 * One connection per enabled provider, or a `manual` note when its credential
 * lives somewhere the generic service cannot take over as it is. Notes are
 * never silently dropped: the migration must preserve every provider.
 */
function providerEntry(domain, provider, config, defaults) {
  const base = { id: connectionIdFor(domain, provider), source: `dev-server:${domain}/${provider}`, name: `${domain}-${provider}` };
  switch (provider) {
    case 'github':
      return {
        ...base,
        definition: {
          name: base.name, transport: 'stdio',
          stdio: { command: '/usr/local/bin/github-mcp-server', args: ['stdio', '--toolsets', 'repos,issues,pull_requests,actions,code_security'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: { secret: 'token' } } },
        },
        credentials: { token: envCredential(domain, provider, 'GITHUB_PERSONAL_ACCESS_TOKEN') },
      };
    case 'gitlab':
      return {
        ...base,
        definition: {
          name: base.name, transport: 'stdio',
          stdio: { command: '/opt/mcp-gitlab/node_modules/.bin/mcp-gitlab', env: { GITLAB_PERSONAL_ACCESS_TOKEN: { secret: 'token' }, GITLAB_API_URL: config.api_url ?? 'https://gitlab.com/api/v4' } },
        },
        credentials: { token: envCredential(domain, provider, 'GITLAB_PERSONAL_ACCESS_TOKEN') },
      };
    case 'sentry': {
      const auth = config.auth ?? 'oauth';
      if (auth === 'token') {
        const env = { SENTRY_ACCESS_TOKEN: { secret: 'token' } };
        if (Array.isArray(config.skills) && config.skills.length > 0) env.MCP_SKILLS = config.skills.join(',');
        return {
          ...base,
          definition: { name: base.name, transport: 'stdio', stdio: { command: '/opt/mcp-sentry/node_modules/.bin/sentry-mcp', env } },
          credentials: { token: envCredential(domain, provider, 'SENTRY_ACCESS_TOKEN') },
        };
      }
      const scope = [config.organization, config.project].filter(Boolean).join('/');
      return {
        ...base,
        definition: { name: base.name, transport: 'http', http: { url: `${defaults.sentryUrl}${scope ? `/${scope}` : ''}`, oauth: { scopes: [] } } },
        reauthorize: 'The Sentry grant stays with the old broker; sign in once in Settings → MCP → this connection → "Sign in", choosing the same skills.',
      };
    }
    case 'harness': {
      const readOnly = config.read_only !== false;
      const defaultArguments = Object.fromEntries([['org_id', config.org], ['project_id', config.project]].filter(([, value]) => isString(value) && value));
      const policy = {};
      if (readOnly) policy.denyTools = defaults.harnessWriteTools;
      if (Object.keys(defaultArguments).length > 0) policy.defaultArguments = defaultArguments;
      if ((config.auth ?? 'oauth') === 'token') {
        return { ...base, manual: 'Harness token mode runs harness-mcp-v2 locally; create it as a protected server in Settings → MCP with its API key and HARNESS_READ_ONLY as before.' };
      }
      return {
        ...base,
        definition: { name: base.name, transport: 'http', http: { url: defaults.harnessUrl, oauth: { scopes: ['openid', 'offline_access'], clientId: defaults.harnessClientId } }, policy },
        reauthorize: 'The Harness grant stays with the old broker; sign in once in Settings → MCP → this connection → "Sign in".',
      };
    }
    case 'atlassian':
      return {
        ...base,
        manual: 'Atlassian runs dev-server\'s Rovo adapter with its permission-group policy (atlassian_policy.py), which a generic connection does not enforce. Keep the broker until that policy has an equivalent here.',
      };
    case 'aws':
      return {
        ...base,
        manual: 'AWS grants arrive per profile from make aws-login into /run/dev-server-aws; the service has no receiver for them yet. Keep the broker; its IAM limits and grant expiry are unchanged.',
      };
    case 'google':
      return {
        ...base,
        manual: 'workspace-mcp serves HTTP itself and keeps its OAuth state under the broker\'s StateDirectory. Run it as a stdio connection from a root-owned runtime, copying credentials/*.json with stateFiles, after checking its single-user mode.',
      };
    case 'microsoft':
      return {
        ...base,
        definition: {
          name: base.name, transport: 'stdio',
          stdio: {
            command: '/opt/mcp-microsoft/node_modules/.bin/ms-365-mcp-server',
            args: [...(config.org_mode ? ['--org-mode'] : []), ...(Array.isArray(config.allowed_scopes) && config.allowed_scopes.length ? ['--allowed-scopes', config.allowed_scopes.join(' ')] : [])],
            env: {
              MS365_MCP_TOKEN_CACHE_PATH: { state: 'token-cache.json' },
              MS365_MCP_SELECTED_ACCOUNT_PATH: { state: 'selected-account.json' },
              MS365_MCP_LOG_DIR: { state: 'logs' },
              MS365_MCP_USE_KEYTAR: '0',
            },
          },
        },
        stateFiles: [
          { from: `${STATE_ROOT}/${domain}-microsoft/token-cache.json`, to: 'token-cache.json' },
          { from: `${STATE_ROOT}/${domain}-microsoft/selected-account.json`, to: 'selected-account.json' },
        ],
        note: 'A custom app registration (MS365_MCP_CLIENT_ID/TENANT_ID) is not carried over; add it as plain environment values if the domain uses one.',
      };
    case 'gcp': {
      const env = {
        CLOUDSDK_CONFIG: { state: 'gcloud' },
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: { secretFile: 'service_account' },
        CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
      };
      if (isString(config.project_id) && config.project_id) env.CLOUDSDK_CORE_PROJECT = config.project_id;
      return {
        ...base,
        definition: { name: base.name, transport: 'stdio', stdio: { command: '/opt/mcp-gcp/node_modules/.bin/gcloud-mcp', env } },
        credentials: { service_account: { file: `${STATE_ROOT}/${domain}-gcp/service-account.json` } },
      };
    }
    default:
      return { ...base, manual: `Unknown provider ${provider}: migrate it by hand.` };
  }
}

/** A broker address from the rendered catalog, only when it is this machine's loopback. */
const loopbackBroker = (value) => {
  if (!isString(value)) return null;
  try {
    const url = new URL(value);
    const local = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    return local && url.protocol === 'http:' && !url.username && !url.password && !url.search && !url.hash ? url.href : null;
  } catch {
    return null;
  }
};

/**
 * The manifest and a list of what needs a person, from the parsed catalog.
 * `brokers` is dev-server's rendered `/etc/dev-server/workspaces.json`, which
 * lists only the brokers that run: with it, a provider the service cannot take
 * over becomes a connection to its running broker, which keeps its credential
 * and policy, and a provider without a broker is left out instead of failing.
 */
export function buildManifest(catalog, { defaults = DEV_SERVER_DEFAULTS, brokers = null } = {}) {
  const source = isPlainObject(catalog?.workspaces) ? catalog.workspaces : catalog;
  if (!isPlainObject(source?.domains) || !Array.isArray(source?.projects)) {
    throw new ProtectedMcpError('invalid_catalog', { message: 'Expected the workspaces catalog with domains and projects' });
  }
  const connections = [];
  const pending = [];
  const migrated = new Map();
  for (const [domain, domainConfig] of Object.entries(source.domains)) {
    for (const [provider, config] of Object.entries(domainConfig?.providers ?? {})) {
      const entry = providerEntry(domain, provider, isPlainObject(config) ? config : {}, defaults);
      const running = brokers ? brokers.domains?.[domain]?.mcp?.[provider] : undefined;
      if (brokers && running === undefined) {
        pending.push({ source: entry.source, action: 'skip', reason: 'No broker runs for it, so there is nothing to move.' });
        continue;
      }
      if (entry.manual && brokers) {
        const url = loopbackBroker(running);
        if (!url) {
          pending.push({ source: entry.source, action: 'check', reason: 'The rendered catalog names a broker that is not plain http on this machine; left out.' });
          continue;
        }
        connections.push({ id: entry.id, source: entry.source, definition: { name: entry.name, transport: 'http', http: { url } }, credentials: {}, stateFiles: [] });
        pending.push({ source: entry.source, action: 'bridge', reason: `${entry.manual} Until then the connection reaches the running broker, which keeps its credential and policy.` });
        migrated.set(`${domain}/${provider}`, entry.id);
        continue;
      }
      if (entry.manual) {
        pending.push({ source: entry.source, action: 'keep-broker', reason: entry.manual });
        continue;
      }
      const { reauthorize, note, ...connection } = entry;
      connections.push({ id: connection.id, source: connection.source, definition: connection.definition, credentials: connection.credentials ?? {}, stateFiles: connection.stateFiles ?? [] });
      if (reauthorize) pending.push({ source: entry.source, action: 'authorize', reason: reauthorize });
      if (note) pending.push({ source: entry.source, action: 'check', reason: note });
      migrated.set(`${domain}/${provider}`, connection.id);
    }
  }
  // The plugin injected each domain's brokers into its projects under the provider's name.
  const selections = [];
  for (const project of source.projects) {
    if (!isString(project?.path) || !isString(project?.domain)) continue;
    for (const provider of Object.keys(source.domains[project.domain]?.providers ?? {})) {
      const connection = migrated.get(`${project.domain}/${provider}`);
      if (connection) selections.push({ scope: 'project', project: project.path, name: provider, connection });
    }
  }
  return { manifest: { version: 1, connections, selections }, pending };
}

const USAGE = `Usage: dev-server-manifest.js --catalog <workspaces.json> [--brokers <rendered workspaces.json>] [--out <manifest.json>]

Reads dev-server's non-secret workspace catalog
(ansible/group_vars/all/workspaces.json) and writes a migration manifest for
migrate.js. With --brokers, the rendered /etc/dev-server/workspaces.json, it
moves only the brokers that run, and connects the ones it cannot move to the
running broker. Prints what needs a person: connections to authorize again,
brokers kept as they are, and providers left out.
`;

async function cli(argv) {
  const option = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? null : argv[index + 1] ?? null;
  };
  if (argv.includes('--help') || !option('--catalog')) {
    (argv.includes('--help') ? process.stdout : process.stderr).write(USAGE);
    return argv.includes('--help') ? 0 : 64;
  }
  const brokers = option('--brokers') ? JSON.parse(await fs.readFile(option('--brokers'), 'utf8')) : null;
  const { manifest, pending } = buildManifest(JSON.parse(await fs.readFile(option('--catalog'), 'utf8')), { brokers });
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (option('--out')) await fs.writeFile(option('--out'), text, { mode: 0o644 });
  else process.stdout.write(text);
  process.stderr.write(`${JSON.stringify({ connections: manifest.connections.length, selections: manifest.selections.length, pending }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await fs.realpath(process.argv[1])) {
  cli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`${error.code ?? 'error'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

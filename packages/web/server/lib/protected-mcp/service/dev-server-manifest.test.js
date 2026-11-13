import { describe, expect, it } from 'vitest';
import { buildManifest, connectionIdFor } from './dev-server-manifest.js';
import { parseManifest } from './migrate.js';

/** The shape of dev-server's `group_vars/all/workspaces.json`, with made-up values. */
const catalog = {
  workspaces: {
    default_domain: 'alpha',
    domains: {
      alpha: {
        port_base: 41900,
        providers: {
          github: {},
          sentry: { auth: 'oauth', organization: 'acme', project: 'web' },
          harness: { auth: 'oauth', org: 'acme-org', project: 'acme-proj', read_only: true },
          atlassian: { auth: 'oauth', oauth_groups: ['read_jira'] },
          aws: { mode: 'grants', default_profile: 'read-staging', profiles: [] },
          google: {},
        },
      },
      beta: {
        port_base: 41920,
        providers: {
          gitlab: { api_url: 'https://gitlab.example.com/api/v4' },
          microsoft: { org_mode: true, allowed_scopes: ['Mail.Read'] },
          gcp: { project_id: 'beta-project' },
        },
      },
    },
    projects: [
      { name: 'web', domain: 'alpha', path: '/home/dev/workspace/web' },
      { name: 'infra', domain: 'beta', path: '/home/dev/workspace/infra' },
    ],
  },
};

describe('dev-server manifest', () => {
  it('produces a valid manifest that names credential files, never values, with every policy kept', () => {
    const { manifest, pending } = buildManifest(catalog);
    expect(() => parseManifest(manifest)).not.toThrow();
    const byName = Object.fromEntries(manifest.connections.map((connection) => [connection.definition.name, connection]));
    expect(byName['alpha-github'].credentials).toEqual({ token: { envFile: '/etc/dev-server/mcp/alpha/github.env', key: 'GITHUB_PERSONAL_ACCESS_TOKEN' } });
    expect(byName['alpha-github'].definition.stdio.args).toEqual(['stdio', '--toolsets', 'repos,issues,pull_requests,actions,code_security']);
    expect(byName['alpha-sentry'].definition.http.url).toBe('https://mcp.sentry.dev/mcp/acme/web');
    expect(byName['alpha-harness'].definition.policy).toEqual({
      denyTools: ['harness_create', 'harness_update', 'harness_delete', 'harness_execute'],
      defaultArguments: { org_id: 'acme-org', project_id: 'acme-proj' },
    });
    expect(byName['beta-gitlab'].definition.stdio.env.GITLAB_API_URL).toBe('https://gitlab.example.com/api/v4');
    expect(byName['beta-microsoft'].definition.stdio.args).toEqual(['--org-mode', '--allowed-scopes', 'Mail.Read']);
    expect(byName['beta-microsoft'].stateFiles.map((file) => file.to)).toEqual(['token-cache.json', 'selected-account.json']);
    expect(byName['beta-gcp'].credentials).toEqual({ service_account: { file: '/var/lib/dev-server-mcp/beta-gcp/service-account.json' } });

    // Every provider is accounted for: migrated, or listed for a person.
    const accounted = new Set([...manifest.connections.map((connection) => connection.source), ...pending.map((item) => item.source)]);
    expect([...accounted].sort()).toEqual([
      'dev-server:alpha/atlassian', 'dev-server:alpha/aws', 'dev-server:alpha/github', 'dev-server:alpha/google',
      'dev-server:alpha/harness', 'dev-server:alpha/sentry', 'dev-server:beta/gcp', 'dev-server:beta/gitlab', 'dev-server:beta/microsoft',
    ]);
    expect(pending.filter((item) => item.action === 'keep-broker').map((item) => item.source).sort()).toEqual([
      'dev-server:alpha/atlassian', 'dev-server:alpha/aws', 'dev-server:alpha/google',
    ]);
  });

  it('selects each project\'s domain connections under the provider name the plugin used', () => {
    const { manifest } = buildManifest(catalog);
    expect(manifest.selections).toEqual(expect.arrayContaining([
      { scope: 'project', project: '/home/dev/workspace/web', name: 'github', connection: connectionIdFor('alpha', 'github') },
      { scope: 'project', project: '/home/dev/workspace/infra', name: 'gitlab', connection: connectionIdFor('beta', 'gitlab') },
    ]));
    expect(manifest.selections.some((selection) => selection.name === 'aws')).toBe(false);
  });

  it('with the rendered broker list, bridges what it cannot move and skips brokers that are not running', () => {
    // dev-server's /etc/dev-server/workspaces.json: enabled brokers only, no secrets.
    const brokers = {
      default_domain: 'alpha',
      projects: catalog.workspaces.projects,
      domains: {
        alpha: { mcp: { github: 'http://127.0.0.1:41900/mcp', sentry: 'http://127.0.0.1:41903/mcp', harness: 'http://127.0.0.1:41909/mcp', atlassian: 'http://127.0.0.1:41902/mcp', google: 'http://127.0.0.1:41905/mcp' } },
        beta: { mcp: { gitlab: 'http://127.0.0.1:41921/mcp', microsoft: 'http://127.0.0.1:41927/mcp', gcp: 'http://127.0.0.1:41928/mcp' } },
      },
    };
    const { manifest, pending } = buildManifest(catalog, { brokers });
    expect(() => parseManifest(manifest)).not.toThrow();
    const byName = Object.fromEntries(manifest.connections.map((connection) => [connection.definition.name, connection]));
    // The broker keeps its credential and its policy; the connection only reaches it.
    expect(byName['alpha-atlassian']).toEqual({
      id: connectionIdFor('alpha', 'atlassian'),
      source: 'dev-server:alpha/atlassian',
      definition: { name: 'alpha-atlassian', transport: 'http', http: { url: 'http://127.0.0.1:41902/mcp' } },
      credentials: {},
      stateFiles: [],
    });
    expect(byName['alpha-google'].definition.http.url).toBe('http://127.0.0.1:41905/mcp');
    // AWS has no running broker in alpha: nothing to move, and no failing entry appears.
    expect(byName['alpha-aws']).toBeUndefined();
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'dev-server:alpha/aws', action: 'skip' }),
      expect.objectContaining({ source: 'dev-server:alpha/atlassian', action: 'bridge' }),
    ]));
    expect(pending.some((item) => item.action === 'keep-broker')).toBe(false);
    expect(manifest.selections).toEqual(expect.arrayContaining([
      { scope: 'project', project: '/home/dev/workspace/web', name: 'atlassian', connection: connectionIdFor('alpha', 'atlassian') },
    ]));
    expect(manifest.selections.some((selection) => selection.name === 'aws')).toBe(false);
  });

  it('refuses a broker address that is not on this machine', () => {
    const brokers = { domains: { alpha: { mcp: { atlassian: 'http://broker.example.com/mcp' } } } };
    const { manifest, pending } = buildManifest(catalog, { brokers });
    expect(manifest.connections.some((connection) => connection.source === 'dev-server:alpha/atlassian')).toBe(false);
    expect(pending).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'dev-server:alpha/atlassian', action: 'check' })]));
  });

  it('gives the same ids every time, so a regenerated manifest resumes', () => {
    expect(buildManifest(catalog).manifest).toEqual(buildManifest(catalog).manifest);
    expect(connectionIdFor('alpha', 'github')).toMatch(/^pmcp_[0-9a-f]{16}$/);
  });
});

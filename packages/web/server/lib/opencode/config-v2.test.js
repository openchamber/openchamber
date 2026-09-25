import { describe, expect, it } from 'vitest';

import {
  permissionMapToRules,
  normalizePermissionRules,
  normalizePermissionAction,
  effectiveAgentRules,
  readGlobalPermissionRules,
  parseModelSelection,
  formatModelSelection,
  toAgentEntity,
  writeWarmingEnabled,
  fromAgentEntity,
  isLegacyAgentFrontmatter,
  toCommandEntity,
  toMcpEntity,
  toProviderEntity,
  toPluginEntity,
  fromPluginEntity,
  readSectionEntry,
  writeSectionEntry,
  deleteSectionEntry,
  readMcpEntries,
  readLayeredMcpEntries,
  writeMcpEntry,
  parseWebSearchSelection,
  writeWebSearchSelection,
  findWebSearchProjectOverride,
} from './config-v2.js';

describe('permission translation', () => {
  it('renames the v1 actions v2 renamed', () => {
    expect(normalizePermissionAction('bash')).toBe('shell');
    expect(normalizePermissionAction('task')).toBe('subagent');
    expect(normalizePermissionAction('write')).toBe('edit');
    expect(normalizePermissionAction('patch')).toBe('edit');
    expect(normalizePermissionAction('read')).toBe('read');
  });

  it('turns a v1 permission map into an ordered rule array', () => {
    expect(permissionMapToRules({
      bash: { 'git push *': 'ask' },
      edit: 'allow',
      task: 'deny',
    })).toEqual([
      { action: 'shell', resource: 'git push *', effect: 'ask' },
      { action: 'edit', resource: '*', effect: 'allow' },
      { action: 'subagent', resource: '*', effect: 'deny' },
    ]);
  });

  it('turns a bare v1 permission string into a catch-all rule', () => {
    expect(permissionMapToRules('ask')).toEqual([{ action: '*', resource: '*', effect: 'ask' }]);
    expect(permissionMapToRules('nonsense')).toEqual([]);
  });

  it('passes a v2 rule array through and drops malformed rules', () => {
    expect(normalizePermissionRules([
      { action: 'shell', resource: '*', effect: 'allow' },
      { action: 'shell', resource: '*', effect: 'maybe' },
      'nope',
    ])).toEqual([{ action: 'shell', resource: '*', effect: 'allow' }]);
  });

  it('reads global rules from tools, permission and permissions in normalizer order', () => {
    expect(readGlobalPermissionRules({
      tools: { websearch: false },
      permission: { bash: 'ask' },
      permissions: [{ action: 'read', resource: '*', effect: 'allow' }],
    })).toEqual([
      { action: 'websearch', resource: '*', effect: 'deny' },
      { action: 'shell', resource: '*', effect: 'ask' },
      { action: 'read', resource: '*', effect: 'allow' },
    ]);
  });

  it('puts global rules before agent rules so the agent wins on a tie', () => {
    expect(effectiveAgentRules(
      [{ action: 'edit', resource: '*', effect: 'allow' }],
      { edit: 'deny' },
    )).toEqual([
      { action: 'edit', resource: '*', effect: 'allow', source: 'global' },
      { action: 'edit', resource: '*', effect: 'deny', source: 'agent' },
    ]);
  });
});

describe('model selection', () => {
  it('splits provider/model#variant', () => {
    expect(parseModelSelection('anthropic/claude-sonnet-4-5#high')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-5',
      variant: 'high',
    });
  });

  it('joins a separate v1 variant onto the model reference', () => {
    expect(formatModelSelection(parseModelSelection('anthropic/claude-sonnet-4-5', 'high')))
      .toBe('anthropic/claude-sonnet-4-5#high');
  });

  it('rejects references v2 would not parse', () => {
    expect(parseModelSelection('claude-sonnet')).toBeNull();
    expect(parseModelSelection('/model')).toBeNull();
    expect(parseModelSelection('anthropic/')).toBeNull();
  });
});

describe('agent entity', () => {
  it('reads a v1 agent into the v2 shape', () => {
    expect(toAgentEntity({
      prompt: 'Review carefully.',
      model: 'anthropic/claude-sonnet-4-5',
      variant: 'high',
      temperature: 0.7,
      top_p: 0.9,
      maxSteps: 12,
      disable: false,
      permission: { bash: 'ask', edit: 'deny' },
    })).toEqual({
      system: 'Review carefully.',
      model: 'anthropic/claude-sonnet-4-5#high',
      steps: 12,
      disabled: false,
      request: { body: { temperature: 0.7, top_p: 0.9 } },
      permissions: [
        { action: 'shell', resource: '*', effect: 'ask' },
        { action: 'edit', resource: '*', effect: 'deny' },
      ],
    });
  });

  it('reads a native v2 agent unchanged', () => {
    const native = {
      system: 'Be brief.',
      model: 'openai/gpt-5#low',
      mode: 'subagent',
      hidden: true,
      color: '#aabbcc',
      steps: 4,
      permissions: [{ action: 'read', resource: '*', effect: 'allow' }],
    };
    expect(toAgentEntity(native)).toEqual(native);
  });

  it('maps a v1 theme color onto the hex OpenCode migrates it to', () => {
    // v2 only decodes `#rrggbb`; OpenCode's migration turns anything else into #aaaaaa.
    expect(toAgentEntity({ color: 'primary' }).color).toBe('#aaaaaa');
    expect(toAgentEntity({ color: '#abc' }).color).toBe('#aaaaaa');
    expect(toAgentEntity({ color: '#AABBCC' }).color).toBe('#AABBCC');
    expect(toAgentEntity({ color: '' }).color).toBeUndefined();
    expect(fromAgentEntity({ color: 'accent', description: 'A' }).fields).toEqual({
      color: '#aaaaaa',
      description: 'A',
    });
  });

  it('lets the markdown body win over a frontmatter system field', () => {
    expect(toAgentEntity({ system: 'from frontmatter' }, 'from body').system).toBe('from body');
  });

  it('splits the system prompt out for markdown persistence', () => {
    expect(fromAgentEntity({ system: 'Body text.', description: 'Agent' })).toEqual({
      fields: { description: 'Agent' },
      system: 'Body text.',
    });
  });

  it('flags frontmatter that OpenCode would route through its v1 decoder', () => {
    expect(isLegacyAgentFrontmatter({ model: 'a/b', permissions: [] })).toBe(false);
    expect(isLegacyAgentFrontmatter({ model: 'a/b', variant: 'high' })).toBe(false);
    expect(isLegacyAgentFrontmatter({ temperature: 0.5 })).toBe(true);
    expect(isLegacyAgentFrontmatter({ permission: { bash: 'ask' } })).toBe(true);
  });
});

describe('command entity', () => {
  it('renames subtask to subagent and joins the variant', () => {
    expect(toCommandEntity({
      template: 'Review the current changes.',
      model: 'anthropic/claude-sonnet-4-5',
      variant: 'high',
      subtask: true,
    })).toEqual({
      template: 'Review the current changes.',
      model: 'anthropic/claude-sonnet-4-5#high',
      subagent: true,
    });
  });
});

describe('mcp entity', () => {
  it('migrates a v1 local server', () => {
    expect(toMcpEntity({
      type: 'local',
      command: ['npx', '@playwright/mcp'],
      enabled: true,
      timeout: 30000,
    })).toEqual({
      type: 'local',
      command: ['npx', '@playwright/mcp'],
      disabled: false,
      timeout: { catalog: 30000, execution: 30000 },
    });
  });

  it('migrates v1 camelCase OAuth to snake_case', () => {
    expect(toMcpEntity({
      type: 'remote',
      url: 'https://mcp.example.com',
      oauth: { clientId: 'id', clientSecret: 'secret', callbackPort: 4242, redirectUri: 'http://localhost/cb' },
      enabled: false,
    })).toEqual({
      type: 'remote',
      url: 'https://mcp.example.com',
      oauth: {
        client_id: 'id',
        client_secret: 'secret',
        callback_port: 4242,
        redirect_uri: 'http://localhost/cb',
      },
      disabled: true,
    });
  });

  it('keeps a non-default protocol on both transports', () => {
    expect(toMcpEntity({ type: 'local', command: ['a'], protocol: 'auto' }).protocol).toBe('auto');
    expect(toMcpEntity({
      type: 'remote',
      url: 'https://mcp.example.com',
      protocol: '2026-07-28',
    }).protocol).toBe('2026-07-28');
  });

  it('drops the protocol key for legacy, for an unknown value and for a removal', () => {
    // The editor saves "legacy" as `null`: absent is what OpenCode calls legacy,
    // so the config file only ever names a non-default negotiation.
    expect(toMcpEntity({ type: 'local', command: ['a'], protocol: null })).not.toHaveProperty('protocol');
    expect(toMcpEntity({ type: 'local', command: ['a'], protocol: 'made-up' })).not.toHaveProperty('protocol');
    expect(toMcpEntity({ type: 'local', command: ['a'], protocol: 'legacy' }).protocol).toBe('legacy');
  });

  it('keeps auth_server_metadata_url and drops it again when emptied', () => {
    expect(toMcpEntity({
      type: 'remote',
      url: 'https://mcp.example.com',
      oauth: {
        client_id: 'id',
        auth_server_metadata_url: 'https://auth.example.com/.well-known/oauth-authorization-server',
      },
    }).oauth).toEqual({
      client_id: 'id',
      auth_server_metadata_url: 'https://auth.example.com/.well-known/oauth-authorization-server',
    });

    // An emptied field arrives as '' because the editor rebuilds the whole
    // oauth block; the key must not survive.
    expect(toMcpEntity({
      type: 'remote',
      url: 'https://mcp.example.com',
      oauth: { client_id: 'id', auth_server_metadata_url: '   ' },
    }).oauth).toEqual({ client_id: 'id' });

    // Nothing left in the block at all removes `oauth` itself.
    expect(toMcpEntity({
      type: 'remote',
      url: 'https://mcp.example.com',
      oauth: { auth_server_metadata_url: '' },
    })).not.toHaveProperty('oauth');
  });

  it('reads v1 mcp.<name> and v2 mcp.servers, with v2 winning', () => {
    const config = {
      mcp: {
        timeout: { catalog: 1000 },
        legacy: { type: 'local', command: ['a'] },
        shared: { type: 'local', command: ['old'] },
        servers: { shared: { type: 'local', command: ['new'] } },
      },
    };
    const entries = readMcpEntries(config);
    expect([...entries.keys()]).toEqual(['legacy', 'shared']);
    expect(entries.get('shared').value.command).toEqual(['new']);
  });

  it('applies layer precedence after normalizing each layer', () => {
    // A raw deep merge would leave user `mcp.servers.shared` next to project
    // `mcp.shared`, and the v2 spelling would then shadow the project override.
    const user = { mcp: { servers: { shared: { type: 'remote', url: 'https://global' }, only: { type: 'local', command: ['u'] } } } };
    const project = { mcp: { shared: { type: 'remote', url: 'https://project' } } };
    const entries = readLayeredMcpEntries([user, project]);
    expect(entries.get('shared')).toEqual({
      value: { type: 'remote', url: 'https://project' },
      key: 'mcp',
      legacy: true,
    });
    expect(entries.get('only').value.command).toEqual(['u']);
    expect(readLayeredMcpEntries([project, user]).get('shared').value.url).toBe('https://global');
  });

  it('rewrites a v1 mcp entry into mcp.servers in place', () => {
    const config = { mcp: { legacy: { type: 'local', command: ['a'] } } };
    writeMcpEntry(config, 'legacy', { type: 'local', command: ['b'] });
    expect(config.mcp).toEqual({ servers: { legacy: { type: 'local', command: ['b'] } } });
  });
});

describe('provider entity', () => {
  it('migrates npm/api/options into package/settings', () => {
    expect(toProviderEntity({
      npm: '@ai-sdk/openai-compatible',
      api: 'https://llm.example.com/v1',
      options: { apiKey: '{env:ACME_API_KEY}', headers: { 'X-A': '1' } },
    })).toEqual({
      package: 'aisdk:@ai-sdk/openai-compatible',
      settings: { apiKey: '{env:ACME_API_KEY}', baseURL: 'https://llm.example.com/v1' },
      headers: { 'X-A': '1' },
    });
  });

  it('keeps the v2-only canonical and compatibility fields', () => {
    const native = {
      canonical: 'openai',
      name: 'Proxy',
      package: 'aisdk:@ai-sdk/openai-compatible',
      settings: { baseURL: 'https://proxy.example.com/v1' },
      models: {
        m: {
          modelID: 'm',
          name: 'M',
          compatibility: { reasoningField: 'reasoning_content', requireReasoning: true, maxTokensField: 'max_tokens' },
        },
      },
    };
    expect(toProviderEntity(native)).toEqual(native);
    expect(toProviderEntity({ models: { m: { compatibility: {} } } }).models.m).toEqual({});
  });

  it('migrates v1 interleaved into compatibility.reasoningField', () => {
    const models = toProviderEntity({
      models: {
        text: { interleaved: 'reasoning_text' },
        field: { interleaved: { field: 'reasoning' } },
        flag: { interleaved: true },
      },
    }).models;
    expect(models.text).toEqual({ compatibility: { reasoningField: 'reasoning_text' } });
    expect(models.field).toEqual({ compatibility: { reasoningField: 'reasoning' } });
    expect(models.flag).toEqual({});
  });

  it('migrates model fields', () => {
    expect(toProviderEntity({
      models: {
        m: {
          id: 'real-model-id',
          name: 'M',
          tool_call: false,
          modalities: { input: ['text'], output: ['text'] },
          status: 'deprecated',
          cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
          variants: { high: { reasoningEffort: 'high' } },
        },
      },
    }).models.m).toEqual({
      modelID: 'real-model-id',
      name: 'M',
      capabilities: { tools: false, input: ['text'], output: ['text'] },
      variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }],
      cost: { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } },
      disabled: true,
    });
  });
});

describe('plugin entity', () => {
  it('accepts v1 strings and tuples and v2 objects', () => {
    expect(toPluginEntity('pkg')).toEqual({ package: 'pkg' });
    expect(toPluginEntity(['pkg', { a: 1 }])).toEqual({ package: 'pkg', options: { a: 1 } });
    expect(toPluginEntity({ package: 'pkg', options: { a: 1 } })).toEqual({ package: 'pkg', options: { a: 1 } });
    expect(toPluginEntity(42)).toBeNull();
  });

  it('serializes to a bare string or a v2 object, never a tuple', () => {
    expect(fromPluginEntity(['pkg', {}])).toBe('pkg');
    expect(fromPluginEntity(['pkg', { a: 1 }])).toEqual({ package: 'pkg', options: { a: 1 } });
  });
});

describe('config sections', () => {
  it('prefers the v2 key and reports where an entry was found', () => {
    expect(readSectionEntry({ agent: { a: { prompt: 'x' } } }, 'agents', 'a'))
      .toEqual({ value: { prompt: 'x' }, key: 'agent', legacy: true });
    expect(readSectionEntry({ agent: { a: 1 }, agents: { a: 2 } }, 'agents', 'a'))
      .toEqual({ value: 2, key: 'agents', legacy: false });
  });

  it('rewrites a v1 entry into the v2 key and leaves siblings alone', () => {
    const config = { agent: { a: { prompt: 'x' }, b: { prompt: 'y' } } };
    writeSectionEntry(config, 'agents', 'a', { system: 'x' });
    expect(config).toEqual({ agent: { b: { prompt: 'y' } }, agents: { a: { system: 'x' } } });
  });

  it('drops the v1 map entirely when its last entry moves', () => {
    const config = { agent: { a: { prompt: 'x' } } };
    writeSectionEntry(config, 'agents', 'a', { system: 'x' });
    expect(config).toEqual({ agents: { a: { system: 'x' } } });
  });

  it('deletes an entry under either spelling', () => {
    const config = { agent: { a: 1 }, agents: { a: 2 } };
    expect(deleteSectionEntry(config, 'agents', 'a')).toBe(true);
    expect(config).toEqual({});
  });
});

describe('web search choice', () => {
  it('accepts off, remove, random and a provider id, and nothing else', () => {
    expect(parseWebSearchSelection(false)).toBe(false);
    expect(parseWebSearchSelection(null)).toBe(null);
    expect(parseWebSearchSelection('random')).toBe('random');
    expect(parseWebSearchSelection(' exa ')).toBe('exa');
    expect(parseWebSearchSelection('')).toBeUndefined();
    expect(parseWebSearchSelection(true)).toBeUndefined();
    expect(parseWebSearchSelection(undefined)).toBeUndefined();
    expect(parseWebSearchSelection({ provider: 'exa' })).toBeUndefined();
  });

  it('writes the OpenCode shape and leaves other keys alone', () => {
    const config = { model: 'openai/gpt-5' };
    expect(writeWebSearchSelection(config, 'exa')).toBe(true);
    expect(config).toEqual({ model: 'openai/gpt-5', websearch: { provider: 'exa' } });
    expect(writeWebSearchSelection(config, 'exa')).toBe(false);
    expect(writeWebSearchSelection(config, false)).toBe(true);
    expect(config.websearch).toBe(false);
    expect(writeWebSearchSelection(config, null)).toBe(true);
    expect(config).toEqual({ model: 'openai/gpt-5' });
    expect(writeWebSearchSelection(config, null)).toBe(false);
  });
});

describe('findWebSearchProjectOverride', () => {
  const userPath = '/home/u/.config/opencode/opencode.json';
  const layers = (customConfig = {}) => ({ userConfig: { websearch: false }, projectConfig: {}, customConfig, paths: { userPath, projectPath: null } });

  it('names the deepest project file that sets websearch', () => {
    const files = [
      { path: '/repo/app/.opencode/opencode.json', config: { plugins: [] } },
      { path: '/repo/opencode.json', config: { websearch: false } },
    ];
    expect(findWebSearchProjectOverride(layers(), files)).toBe('/repo/opencode.json');
    expect(findWebSearchProjectOverride(layers(), [{ path: '/repo/app/opencode.json', config: { websearch: { provider: 'exa' } } }, ...files])).toBe('/repo/app/opencode.json');
  });

  it('is null when no project file sets websearch', () => {
    expect(findWebSearchProjectOverride(layers(), [{ path: '/repo/opencode.json', config: { model: 'x' } }])).toBeNull();
    expect(findWebSearchProjectOverride(layers(), [])).toBeNull();
  });

  it('is null when OPENCODE_CONFIG sets websearch too, since it wins', () => {
    expect(findWebSearchProjectOverride(layers({ websearch: { provider: 'exa' } }), [{ path: '/repo/opencode.json', config: { websearch: false } }])).toBeNull();
  });

  it('ignores the user config showing up among project files', () => {
    expect(findWebSearchProjectOverride(layers(), [{ path: userPath, config: { websearch: false } }])).toBeNull();
  });
});

describe('session warming', () => {
  it('turns warming on and off, keeping a hand-tuned object', () => {
    const config = { model: 'openai/gpt-5' };
    expect(writeWarmingEnabled(config, true)).toBe(true);
    expect(config.warming).toBe(true);
    expect(writeWarmingEnabled(config, true)).toBe(false);
    expect(writeWarmingEnabled(config, false)).toBe(true);
    expect(config).toEqual({ model: 'openai/gpt-5' });
    expect(writeWarmingEnabled(config, false)).toBe(false);

    const tuned = { warming: { interval: '3 minutes' } };
    expect(writeWarmingEnabled(tuned, true)).toBe(false);
    expect(tuned.warming).toEqual({ interval: '3 minutes' });
  });
});

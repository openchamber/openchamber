import { describe, expect, test } from 'bun:test';
import type { IntegrationInfo } from '@opencode/client';

import { findMcpIntegration, getMcpOAuthMethods } from './mcpOAuthIntegration';

const integration = (overrides: Partial<IntegrationInfo>): IntegrationInfo => ({
  id: 'mcp_0123456789abcdef',
  name: 'linear',
  metadata: { source: 'mcp' },
  methods: [{ id: 'mcp_0123456789abcdef', type: 'oauth', label: 'linear' }],
  connections: [],
  ...overrides,
});

describe('findMcpIntegration', () => {
  test('matches the MCP registration by source and server name', () => {
    const list = [
      integration({ id: 'anthropic', name: 'Anthropic', metadata: undefined }),
      integration({ id: 'mcp_aaaaaaaaaaaaaaaa', name: 'context7' }),
      integration({}),
    ];
    expect(findMcpIntegration(list, 'linear')?.id).toBe('mcp_0123456789abcdef');
  });

  test('a provider integration that happens to share the name is not an MCP login', () => {
    const list = [integration({ id: 'linear', metadata: undefined })];
    expect(findMcpIntegration(list, 'linear')).toBeUndefined();
  });

  test('only oauth methods are offered', () => {
    const found = integration({
      methods: [
        { type: 'key', label: 'API key' },
        { id: 'm', type: 'oauth', label: 'linear' },
      ],
    });
    expect(getMcpOAuthMethods(found).map((method) => method.id)).toEqual(['m']);
    expect(getMcpOAuthMethods(undefined)).toEqual([]);
  });
});

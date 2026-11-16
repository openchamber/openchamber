#!/usr/bin/env node
// A stdio MCP server with many tools and no behavior, standing in for a large
// API server (thousands of tools, as a Cloudflare server has) so the Code Mode
// catalog is as crowded as in a real session. Every call answers that the
// stand-in has no data.
//
// Usage: node fake-mcp.mjs <tool-count> <prefix>

import readline from 'node:readline';

const count = Number.parseInt(process.argv[2] ?? '1000', 10);
const prefix = process.argv[3] ?? 'api';

const RESOURCES = ['zone', 'dns_record', 'worker', 'route', 'bucket', 'queue', 'certificate', 'firewall_rule', 'load_balancer', 'pool', 'monitor', 'token', 'member', 'invite', 'subscription', 'page_rule', 'tunnel', 'access_app', 'policy', 'gateway_list'];
const VERBS = [
  ['list', 'Lists every'],
  ['get', 'Fetches one'],
  ['create', 'Creates a'],
  ['update', 'Updates a'],
  ['delete', 'Deletes a'],
  ['settings_get', 'Reads the settings of a'],
  ['settings_update', 'Changes the settings of a'],
  ['analytics_get', 'Reads usage analytics for a'],
];

const tools = Array.from({ length: count }, (_, index) => {
  const resource = RESOURCES[index % RESOURCES.length];
  const [verb, phrase] = VERBS[Math.floor(index / RESOURCES.length) % VERBS.length];
  const scope = Math.floor(index / (RESOURCES.length * VERBS.length));
  const name = `${prefix}_${scope === 0 ? '' : `v${scope}_`}${resource}_${verb}`;
  const human = resource.replaceAll('_', ' ');
  return {
    name,
    description: `${phrase} ${human}${verb === 'list' ? 's' : ''} in the account.`,
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Account identifier.' },
        ...(verb === 'list' ? { page: { type: 'integer', description: 'Page number.' } } : { id: { type: 'string', description: `The ${human} identifier.` } }),
      },
      required: ['account_id'],
    },
  };
});

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const handle = (request) => {
  switch (request.method) {
    case 'initialize':
      return { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: prefix, version: '1.0.0' } };
    case 'tools/list':
      return { tools };
    case 'tools/call':
      return { content: [{ type: 'text', text: 'This account has no data.' }] };
    case 'ping':
      return {};
    default:
      return undefined;
  }
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return;
  const result = handle(request);
  if (result === undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Unknown method ${request.method}` } });
  else send({ jsonrpc: '2.0', id: request.id, result });
});

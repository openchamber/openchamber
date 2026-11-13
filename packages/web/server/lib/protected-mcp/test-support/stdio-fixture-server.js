#!/usr/bin/node
// A stdio MCP server for tests. It proves it received its credential by
// comparing a hash, and never prints the credential itself.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';

const hash = (value) => createHash('sha256').update(value ?? '').digest('hex');
// Read at every call, as tools that load a credential file per request do.
const currentToken = () => {
  if (!process.env.TOKEN_FILE) return process.env.TOKEN;
  try {
    return fs.readFileSync(process.env.TOKEN_FILE, 'utf8');
  } catch {
    return null;
  }
};
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const slow = new Map();

const tools = [
  { name: 'whoami', description: 'Says whether the credential arrived', inputSchema: { type: 'object', properties: {} } },
  { name: 'delete_everything', description: 'A tool the policy should hide', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Waits until cancelled', inputSchema: { type: 'object', properties: {} } },
  { name: 'environment', description: 'Lists the variable names it received', inputSchema: { type: 'object', properties: {} } },
  { name: 'echo_args', description: 'Echoes its arguments', inputSchema: { type: 'object', properties: { org_id: { type: 'string' }, query: { type: 'string' } } } },
];

const handle = (message) => {
  if (message.method === 'notifications/cancelled') {
    const id = message.params?.requestId;
    if (slow.has(id)) {
      clearTimeout(slow.get(id));
      slow.delete(id);
      send({ jsonrpc: '2.0', id, error: { code: -32800, message: 'Request cancelled' } });
    }
    return;
  }
  if (message.id === undefined || !message.method) return;
  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'stdio-fixture', version: '1.0.0' },
      });
    case 'tools/list':
      return reply({ tools });
    case 'tools/call': {
      const name = message.params?.name;
      if (name === 'whoami') {
        const token = currentToken();
        const matches = Boolean(token) && hash(token) === process.env.EXPECTED_TOKEN_SHA256;
        return reply({ content: [{ type: 'text', text: matches ? 'credential matches' : 'credential missing or wrong' }] });
      }
      if (name === 'environment') return reply({ content: [{ type: 'text', text: Object.keys(process.env).sort().join(',') }] });
      if (name === 'echo_args') return reply({ content: [{ type: 'text', text: JSON.stringify(message.params?.arguments ?? {}) }] });
      if (name === 'slow') {
        slow.set(message.id, setTimeout(() => reply({ content: [{ type: 'text', text: 'finished' }] }), 30_000));
        return undefined;
      }
      return reply({ content: [{ type: 'text', text: `ran ${name}` }] });
    }
    case 'resources/list':
      return reply({ resources: [{ uri: 'fixture://readme', name: 'readme', mimeType: 'text/plain' }] });
    case 'resources/read':
      return reply({ contents: [{ uri: message.params?.uri, mimeType: 'text/plain', text: 'fixture resource' }] });
    case 'prompts/list':
      return reply({ prompts: [{ name: 'greet', description: 'A greeting' }] });
    case 'prompts/get':
      return reply({ messages: [{ role: 'user', content: { type: 'text', text: 'hello from the fixture' } }] });
    case 'ping':
      return reply({});
    default:
      return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim()) handle(JSON.parse(line));
});
process.stdin.on('end', () => process.exit(0));

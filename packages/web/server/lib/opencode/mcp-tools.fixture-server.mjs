#!/usr/bin/env node
// Minimal newline-framed MCP server for listMcpTools tests.

import { createInterface } from 'readline';

const tools = [
  {
    name: 'alpha',
    description: 'Alpha tool',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
    },
  },
  {
    name: 'beta',
    description: 'Beta tool',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture-mcp', version: '0.0.1' },
      },
    });
    return;
  }

  if (message.method === 'notifications/initialized') {
    return;
  }

  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { tools },
    });
    return;
  }

  if (message.id != null) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    });
  }
});

#!/usr/bin/env node
// Minimal Content-Length-framed MCP server for listMcpTools fallback tests.
// Deliberately does not understand newline-delimited JSON, so a client that
// only speaks newline framing will see no response and time out — matching
// how an older, Content-Length-only MCP server behaves in the wild.

const tools = [
  {
    name: 'gamma',
    description: 'Gamma tool',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number' },
      },
    },
  },
];

let buffer = Buffer.alloc(0);
let contentLength = null;

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (true) {
    if (contentLength == null) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      contentLength = Number(match[1]);
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }

    if (buffer.length < contentLength) return;
    const body = buffer.subarray(0, contentLength).toString('utf8');
    buffer = buffer.subarray(contentLength);
    contentLength = null;

    let message;
    try {
      message = JSON.parse(body);
    } catch {
      continue;
    }

    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture-mcp-content-length', version: '0.0.1' },
        },
      });
      continue;
    }

    if (message.method === 'notifications/initialized') {
      continue;
    }

    if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools } });
      continue;
    }

    if (message.id != null) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
    }
  }
});

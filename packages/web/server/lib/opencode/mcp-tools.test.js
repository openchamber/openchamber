import { describe, expect, test } from 'vitest';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { listLocalMcpTools, listMcpTools, listRemoteMcpTools } from './mcp-tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureServer = path.join(__dirname, 'mcp-tools.fixture-server.mjs');
const contentLengthFixtureServer = path.join(__dirname, 'mcp-tools.fixture-server-content-length.mjs');

async function withHttpServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}/mcp`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

describe('listMcpTools', () => {
  test('lists tools from a local newline-framed MCP server', async () => {
    const result = await listLocalMcpTools({
      type: 'local',
      command: [process.execPath, fixtureServer],
      timeout: 10_000,
    });

    expect(result.serverInfo?.name).toBe('fixture-mcp');
    expect(result.tools.map((tool) => tool.name)).toEqual(['alpha', 'beta']);
    expect(result.tools[0]?.description).toBe('Alpha tool');
    expect(result.tools[0]?.inputSchema).toEqual({
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
    });
    expect(result.truncated).toBe(false);
  });

  test('falls back to Content-Length framing for older local MCP servers', async () => {
    // The fixture server only understands Content-Length frames, so the newline
    // attempt must time out (bounded by its own budget) before the fallback runs.
    const result = await listLocalMcpTools({
      type: 'local',
      command: [process.execPath, contentLengthFixtureServer],
      timeout: 4_000,
    });

    expect(result.serverInfo?.name).toBe('fixture-mcp-content-length');
    expect(result.tools.map((tool) => tool.name)).toEqual(['gamma']);
  }, 15_000);

  test('rejects disabled servers', async () => {
    await expect(listMcpTools({
      type: 'local',
      enabled: false,
      command: [process.execPath, fixtureServer],
    })).rejects.toThrow(/disabled/i);
  });

  test('rejects local servers without a command', async () => {
    await expect(listMcpTools({
      type: 'local',
      command: [],
    })).rejects.toThrow(/command is required/i);
  });

  test('rejects oauth-configured remote probes', async () => {
    await expect(listMcpTools({
      type: 'remote',
      url: 'https://example.com/mcp',
      oauth: { clientId: 'demo' },
    })).rejects.toThrow(/OAuth-protected/i);
  });

  test('lists tools from a remote MCP server over JSON responses', async () => {
    await withHttpServer(async (req, res) => {
      const message = await readJsonBody(req);
      res.setHeader('Content-Type', 'application/json');
      if (message.method === 'initialize') {
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture-remote-mcp', version: '0.0.1' },
          },
        }));
        return;
      }
      if (message.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (message.method === 'tools/list') {
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { tools: [{ name: 'delta', description: 'Delta tool' }] },
        }));
        return;
      }
      res.statusCode = 404;
      res.end();
    }, async (url) => {
      const result = await listRemoteMcpTools({ type: 'remote', url }, { timeoutMs: 5_000 });
      expect(result.serverInfo?.name).toBe('fixture-remote-mcp');
      expect(result.tools.map((tool) => tool.name)).toEqual(['delta']);
    });
  });

  test('parses tools/list results delivered over an SSE response', async () => {
    await withHttpServer(async (req, res) => {
      const message = await readJsonBody(req);
      if (message.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      const result = message.method === 'initialize'
        ? {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture-sse-mcp', version: '0.0.1' },
          }
        : { tools: [{ name: 'epsilon', description: 'Epsilon tool' }] };
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
    }, async (url) => {
      const result = await listRemoteMcpTools({ type: 'remote', url }, { timeoutMs: 5_000 });
      expect(result.serverInfo?.name).toBe('fixture-sse-mcp');
      expect(result.tools.map((tool) => tool.name)).toEqual(['epsilon']);
    });
  });
});

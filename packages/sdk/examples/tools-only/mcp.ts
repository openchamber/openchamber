// Optional, read-only MCP fixture. The extension itself remains manifest-only.
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { JsonValue } from '@openchamber/sdk';

const requestSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]).optional(), method: z.string(),
  params: z.object({ name: z.string().optional(), protocolVersion: z.string().optional(), arguments: z.object({ scope: z.string().optional(), project: z.string().optional() }).optional() }).optional(),
});
type SampleTool = { name: string; description: string; inputSchema: { type: 'object'; properties: { [key: string]: { type: 'string'; description: string } }; required: string[] } };
const tools: SampleTool[] = [
  { name: 'findings', description: 'Show a clearly labeled sample code review. Does not inspect files.', inputSchema: { type: 'object', properties: { scope: { type: 'string', description: 'Label for this sample review' } }, required: ['scope'] } },
  { name: 'checks', description: 'Show sample project checks. Does not run commands or inspect files.', inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Label for these sample checks' } }, required: ['project'] } },
];
const samples = {
  findings: { summary: 'Sample review · 3 findings · no files inspected', items: [
    { severity: 'High', file: 'src/auth.ts', finding: 'Reject expired sessions before reading account data.' },
    { severity: 'Medium', file: 'src/search.ts', finding: 'Keep the previous results when a request fails.' },
    { severity: 'Low', file: 'src/settings.ts', finding: 'Give the empty state a useful next action.' },
  ] },
  checks: { summary: 'Sample checks · 2 passed · 1 needs attention · no commands run', items: [
    { check: 'Type-check', status: 'Passed', detail: 'All public contracts agree.' },
    { check: 'Tests', status: 'Passed', detail: 'The failure path is covered too.' },
    { check: 'Accessibility', status: 'Needs attention', detail: 'Add a label to the search input.' },
  ] },
};
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  try {
    const parsed = requestSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } })}\n`);
      return;
    }
    if (parsed.data.id === undefined) return;
    const request = parsed.data;
    const reply = (result: JsonValue) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    if (request.method === 'initialize') {
      reply({ protocolVersion: request.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'openchamber-tool-gallery', version: '1.1.0' } });
    } else if (request.method === 'tools/list') reply({ tools });
    else if (request.method === 'ping') reply({});
    else if (request.method === 'tools/call') {
      const name = request.params?.name;
      if (name !== 'findings' && name !== 'checks') reply({ isError: true, content: [{ type: 'text', text: 'Unknown sample tool.' }] });
      else reply({ content: [{ type: 'text', text: JSON.stringify(samples[name]) }], structuredContent: samples[name] });
    } else process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
  }
});

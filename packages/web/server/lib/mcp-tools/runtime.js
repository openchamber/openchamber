import path from 'node:path';
import { z } from 'zod';

const directorySchema = z.string().min(1).max(4096).refine(path.isAbsolute).transform((value) => path.normalize(value));
const identifier = z.string().min(1).max(256);
const toolSchema = z.object({
  namespace: identifier,
  name: identifier,
  description: z.string().max(16_384),
});
const reportSchema = z.object({ directory: directorySchema, tools: z.array(toolSchema).max(10_000) });
const serversSchema = z.object({
  location: z.object({ directory: directorySchema }),
  data: z.array(z.object({
    name: identifier,
    status: z.discriminatedUnion('status', [
      z.object({ status: z.literal('connected') }),
      z.object({ status: z.literal('pending') }),
      z.object({ status: z.literal('disabled') }),
      z.object({ status: z.literal('failed'), error: z.string() }),
      z.object({ status: z.literal('needs_auth'), error: z.string() }),
    ]),
  })).max(1000),
});
const failure = (message, statusCode) => Object.assign(new Error(message), { statusCode });

const normalizeMcpNamespace = (value) => value.replace(/[^A-Za-z0-9_-]/g, '_');

/** Latest complete managed-plugin reports. The lifecycle owner clears on child replacement. */
export const createMcpToolsRuntime = ({ resolveProjectDirectory, createClient, isExternalOpenCode }) => {
  const catalogs = new Map();
  const report = (payload) => {
    const parsed = reportSchema.safeParse(payload);
    if (!parsed.success) throw failure('Invalid MCP tool catalog report', 400);
    const { directory, tools } = parsed.data;
    if (Buffer.byteLength(JSON.stringify(parsed.data)) > 1_048_576) throw failure('MCP tool catalog exceeds 1 MB', 413);
    if (!catalogs.has(directory) && catalogs.size >= 256) throw failure('MCP tool catalog location limit reached', 503);
    catalogs.set(directory, tools.map((tool) => ({ ...tool, namespace: normalizeMcpNamespace(tool.namespace) })));
  };

  const getProjectTools = async (projectId) => {
    const resolved = await resolveProjectDirectory(projectId);
    if (!resolved) throw failure('Project not found', 404);
    const directory = directorySchema.parse(resolved);
    const external = isExternalOpenCode();
    const result = serversSchema.parse(await createClient(directory).mcp.list({ location: { directory } }));
    if (result.location.directory !== directory) throw failure('MCP server list returned a different directory', 502);
    const catalog = external ? undefined : catalogs.get(directory);
    const toolsByNamespace = new Map();
    for (const tool of catalog ?? []) {
      const tools = toolsByNamespace.get(tool.namespace) ?? [];
      tools.push({ name: tool.name, description: tool.description });
      toolsByNamespace.set(tool.namespace, tools);
    }
    return {
      status: external ? 'external' : catalog === undefined ? 'loading' : 'ready',
      servers: result.data.map((server) => ({
        name: server.name,
        status: server.status.status,
        tools: toolsByNamespace.get(normalizeMcpNamespace(server.name)) ?? [],
      })),
    };
  };

  return { report, getProjectTools, clear: () => catalogs.clear() };
};

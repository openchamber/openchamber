# Project MCP tools

## Ownership

This module owns the in-memory tool reports for the managed OpenCode child and
`GET /api/projects/:projectId/mcp-tools`. The agent-tool runtime owns callback
authentication and plugin generation. The project registry resolves project IDs;
the OpenCode lifecycle supplies the current client and external-process mode.

## Invariants

- Reports contain `{ directory, tools: [{ namespace, name, description }] }`.
  Parsing produces trusted objects before replacing a complete directory catalog.
  Invalid reports leave the previous catalog intact.
- A report has at most 10,000 tools and 1 MB of parsed JSON. Names and namespaces
  have at most 256 characters, descriptions 16,384, directories 4,096. At most
  256 directory catalogs are retained. Capacity failures reject the new location;
  existing catalogs remain valid. Child rotation clears all reports.
- Namespace normalization replaces every character outside `[A-Za-z0-9_-]`
  with `_`, matching OpenCode. Tool names retain their MCP spelling.
- Each request resolves the project's current directory and calls the SDK once
  as `client.mcp.list({ location: { directory } })`. It never starts other
  project locations. A mismatched response location is a failure.
- SDK server names and current statuses are authoritative. Reports supply only
  matching tools. Disconnected servers remain visible with their current status.
- Responses are `{ status, servers: [{ name, status, tools }] }`, where server
  status is the SDK's nested `status.status` string. An absent managed report is
  `loading`; a successful empty report is `ready`. External OpenCode is always
  `external` and has no reported tools, allowing the editor to accept manual names.
- SDK failures and malformed responses produce HTTP errors and preserve reports.
  Responses never include provider error messages or callback credentials.

## Decisions

### Why tool reports accompany SDK server reads

The official SDK lists server names and connection status but has no MCP tool
catalog route. The managed plugin's tool registry supplies descriptions while
the SDK remains authoritative for the servers currently configured in the project.

### Why failed reports retry on the next interval

The plugin records a snapshot only after a successful callback. The next 30-second
tick retries an unacknowledged snapshot; an additional retry loop would duplicate
the existing schedule. One report may be in flight per plugin location.

## Coordinator integration

1. Construct `createMcpToolsRuntime({ resolveProjectDirectory, createClient,
   isExternalOpenCode })` once per server instance. The resolver returns the
   registered project's absolute path or null. `createClient(directory)` returns
   the current official SDK promise client. `isExternalOpenCode()` reads the
   current lifecycle mode. None of these callbacks may fan out across projects.
2. Pass that instance as `mcpToolsRuntime` to `createAgentToolRuntime`. Its existing
   `registerRoutes(app, express)` adds the authenticated report callback at
   `/api/openchamber/agent-tool/mcp-tools`. `createChildEnv()` clears old reports
   when rotating the per-child token.
3. Call `registerMcpToolRoutes(app, { mcpToolsRuntime })` after normal UI
   authentication and before the generic OpenCode proxy. The project route relies
   on that existing UI authentication. The report callback separately enforces
   same-machine and per-child-token authentication.
4. If the lifecycle changes OpenCode ownership without calling `createChildEnv`,
   call `mcpToolsRuntime.clear()` at that boundary before accepting managed reports.
   External reads ignore all managed reports even before clearing.

## Runtimes

| Runtime | Behavior |
| --- | --- |
| Web | Managed catalog through the server; external mode permits manual names. |
| Electron | Uses the same in-process server and managed plugin. |
| Hosted mobile | Reads the connected server's project catalog. |
| Capacitor mobile | Reads the connected server's project catalog. |
| VS Code | Bots and their lens editor are unsupported; no server route is installed here. |

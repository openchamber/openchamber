# Tool Gallery

A page-less extension that makes structured tool results readable in the conversation. Two exact rules turn sample review findings and project checks into tables. The `mcp.*` fallback keeps other matching results in the JSON viewer.

## Try the complete example

1. Install this folder in Settings → Extensions. It adds no panel and asks for no extension capabilities.
2. Add the optional fixture server to your OpenCode MCP configuration, replacing the absolute path below:

```json
{
  "mcp": {
    "example": {
      "type": "local",
      "command": ["node", "/absolute/path/to/openchamber/packages/sdk/examples/tools-only/mcp.js"]
    }
  }
}
```

3. Reload OpenCode, then ask your agent: `Call the example findings tool with scope "Authentication", then the example checks tool with project "My project".`
4. Expand the results in chat. Disable Tool Gallery in Settings → Extensions to compare the normal rendering.

These are labeled sample results. The fixture does not read files, run project commands, or contact a network service. Starting an MCP server is separate from installing an extension.

The manifest matches the tool names `example_findings` and `example_checks`. If your MCP configuration uses another server name, update those exact matches to the names OpenCode reports. Columns read keys from each entry in the result's `items` array. Titles read tool inputs; subtitles read the result's summary.

## Make it yours

Replace the sample server with your own tool. Keep its data structured, choose the columns that answer the reader's question, and use the subtitle for a concise outcome. The extension needs no iframe or JavaScript to render those results.

`mcp.ts` is only the optional fixture server. Rebuild its checked-in Node bundle from the repository root:

```bash
bun packages/sdk/scripts/bundle-guest.ts --node packages/sdk/examples/tools-only/mcp.ts packages/sdk/examples/tools-only/mcp.js
```

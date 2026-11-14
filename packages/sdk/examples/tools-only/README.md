# Tool Gallery

A page-less extension that makes structured tool results readable in the conversation. Two exact rules turn sample review findings and project checks into tables, and two more draw a sample tracker issue as a card and an issue search as a list. The `example_*` fallback puts the result of any other tool you add to that server in the JSON viewer.

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

3. Reload OpenCode, then ask your agent: `Call the example findings tool with scope "Authentication".` When it answers, ask: `Call the example checks tool with project "My project".`
4. For the card, ask: `Call the example issue tool with key "DEMO-482".` For the list: `Call the example issues tool with query "open".`
5. Expand the results in chat. Disable Tool Gallery in Settings → Extensions to compare the normal rendering.

These are labeled sample results. The fixture does not read files, run project commands, or contact a network service. Starting an MCP server is separate from installing an extension.

The manifest matches the tool names `example_findings`, `example_checks`, `example_issue` and `example_issues`, and `example_*` for the rest. If your MCP configuration uses another server name, update the matches to the names OpenCode reports. Columns read keys from each entry in the result's `items` array. Titles read tool inputs; subtitles read the result's summary.

The two issue rules use `output: "card"`. Each part of the card names where its value sits in the result: the label reads `{output.key}`, the title `{output.fields.summary}`, the status badge `{output.fields.status.name}` with a tone for the statuses the manifest lists, and the link takes `{output.url}`, which has to be an `https` address. `example_issues` answers `{ summary, items }`, so the same description draws one row per item. Ask for a key the fixture does not have (`DEMO-1`) to see a failed call keep its normal look. The card needs an OpenChamber release newer than 2.7.0.

With Code Mode on, the agent calls tools from a script. A script that makes one call shows as that tool's row once it has finished, and the rule reads what the script returned. A script that makes several calls, or that fails, keeps the script row, which is why steps 3 and 4 ask for one tool at a time.

## Make it yours

Replace the sample server with your own tool. Keep its data structured, choose the columns that answer the reader's question, and use the subtitle for a concise outcome. The extension needs no iframe or JavaScript to render those results.

`mcp.ts` is only the optional fixture server. Rebuild its checked-in Node bundle from the repository root:

```bash
bun packages/sdk/scripts/bundle-guest.ts --node packages/sdk/examples/tools-only/mcp.ts packages/sdk/examples/tools-only/mcp.js
```

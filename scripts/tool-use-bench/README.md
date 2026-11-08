# Tool-use bench

Checks whether an agent reaches OpenChamber's own tools (`openchamber`, `openchamber_memory`, `openchamber_schedule` and the rest) when it should. Most of them sit behind OpenCode's Code Mode (`packages/web/server/lib/agent-tool/DOCUMENTATION.md`), so a change to their descriptions, catalog lines or the session guidance is checked here. It also records what a session costs in context: the size of the first request of every run.

## Run

```sh
node scripts/tool-use-bench/bench.mjs run --models zai-coding-plan/glm-5.3-flash,openai/gpt-6.1-sol --samples 2
node scripts/tool-use-bench/bench.mjs report ~/.cache/openchamber-tool-use-bench/<run>
node scripts/tool-use-bench/bench.mjs regrade ~/.cache/openchamber-tool-use-bench/<run>
```

`regrade` grades the saved transcripts again with the current cases and grader, without model calls.

- `--case <id,...>`, `--samples <n>` (default 2), `--timeout <seconds>` per run (default 300), `--out <dir>`, `--port <first API port>` (default 47300), `--keep` keeps the instance folders, without the copied credentials.
- A model is `provider/model`, optionally `#variant`. Its provider must be signed in in your own OpenCode.
- One run takes 10 seconds to 3 minutes. Every model gets its own instance and they all run side by side; runs within one instance go one at a time.

## What a run is

- Each model gets an isolated OpenChamber server (`packages/web/server/index.js` from this checkout) with its own HOME, XDG folders and OpenChamber data folder, and the OpenCode binary of the installed app. No `OPENCODE_*`, `OPENCHAMBER_*` or `GIT_*` variable of your shell reaches it or the bench's git commands. The bench stops if the port is taken or the server sees any real session.
- Every OpenChamber tool except image generation is on. OpenCode gets two stand-in MCP servers from `fake-mcp.mjs`, 3000 and 60 tools, so the Code Mode catalog is as crowded as with a large API server connected.
- The instance gets copies of your OpenCode credential rows for the providers under test, and the whole folder is deleted at the end.
- Before each run the bench clears what the previous one saved (memory, todos, schedules), resets the demo project and removes extra worktrees and branches. A session is created on the model, synced with session knowledge as a real session is, and given the case's prompt. The run ends when the session goes idle, when the agent waits for the user (`asked`: a question, a page with `awaitAnswer`, a secret request), at the timeout, or after 2 minutes without any change. A run that stalls or ends in a provider error counts as an error and stays out of pass rates. Sessions the agent dispatched are interrupted.

Results: one line per run in `results.jsonl` in the output folder, and the full messages in `transcripts/`.

## Cases

`cases.json`, one object per case:

- `prompt`: what the user writes, in Ukrainian as the maintainer does.
- `kind`: `explicit` (the user asks for what the tool does), `implicit` (the session guidance asks the agent to use the tool unasked) or `control`.
- `expect.calls`: every listed call must appear. `tool` and `action` match an OpenChamber call (an action matches by prefix, so `models.` takes `models.list` or `models.search`); `args` match its inputs by dotted path, `~text` as a case-insensitive substring. `toolIncludes` matches any tool by name. Calls made from a Code Mode `execute` script count the same as direct ones.
- `expect.noOpenChamberCalls`: the run passes only without any OpenChamber call.

The demo project is a two-file JavaScript library with one test; a case that needs more writes it into the prompt.

## Limits

- The isolated server has no browser panel, so `browser.open` fails there; reaching the tool is what `browser-open` checks.
- A case passes on the call, not on the answer the agent gives afterwards.
- The stand-in MCP tools answer every call with "no data".

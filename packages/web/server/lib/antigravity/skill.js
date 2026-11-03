/**
 * The skill the Antigravity delegation plugin registers with OpenCode.
 *
 * The agent reads this when a task matches the description. It is the only
 * place the agent learns how this integration's arguments, model choice,
 * permission limits and resume behavior differ from an ordinary subagent, so
 * it stays short enough to read in one pass.
 *
 * Adapted from chigarow/antigravity-for-opencode (MIT), rewritten for the
 * arguments this integration exposes. The copyright notice stays here and in
 * the module documentation, as the licence requires.
 */
export const ANTIGRAVITY_SKILL = {
  id: 'openchamber-antigravity',
  name: 'antigravity-delegation',
  path: '/builtin/openchamber-antigravity/SKILL.md',
  description: 'Driving the `agy` tool, which runs the Google Antigravity CLI as a delegated worker. Use it when you hand scoped or bulky work to Antigravity, choose an Antigravity model, resume a run, read an `AGY_ERROR [CODE]` result, or decide whether delegating is worth the handoff. Trigger it on "delegate to Antigravity", "use agy", "/agy", or any plan to offload bulk or cross-model work.',
  content: `# Antigravity delegation

\`agy\` runs the Google Antigravity CLI in headless mode. It is a cold process: it sees no chat history and only the session's working directory. Every call returns text plus metadata, and Antigravity failures come back as \`AGY_ERROR [CODE]\` instead of crashing the session.

The result is a claim, never proof. Reading the diff, running the tests and checking that the work happened is the caller's job.

## Is this worth delegating

Delegate work that is wide or bulky: generate tests for a module, scaffold boilerplate, survey a directory, or get a different model's opinion on a design or a diff.

Keep it yourself when the task is small or decided by context you already hold: a fix under roughly 20 lines, an architecture call, or a file you just read. Writing the brief costs more than the edit.

One task per call. Two calls that must not edit the same file are two scopes, not one parallel batch.

## Write the brief, not a wish

Antigravity starts from zero, so the prompt must stand alone:

- Name the files with paths it can open. It works in the session's directory.
- State the constraint that matters: language, framework, test runner, style, what not to touch.
- State the finish line: the command that proves it works, or the exact output shape you want back.
- Ask for a diff or a file list, not prose about what it did.

## Arguments

| Argument | Meaning |
| --- | --- |
| \`prompt\` | Required. Self-contained and specific. |
| \`model\` | Antigravity model id. Defaults to the model chosen under Settings → Providers → Antigravity CLI. |
| \`conversation\` | Antigravity conversation id from an earlier result. Omit it to continue the conversation this session already started. |
| \`timeout\` | Limit such as \`5m\` or \`300s\`. Default 15 minutes, at most 1 hour. |

## Choosing a model

The available ids come from \`agy models\` on the user's machine and are listed on the Antigravity settings page. Models differ by account plan. Do not guess an id or reuse one from another machine. If the result says \`MODEL_NOT_FOUND\`, ask the user to pick a model in Settings.

## Continuing a conversation

A call without \`conversation\` continues the conversation this OpenCode session started, while it is running. The result always ends with the exact id. After an OpenCode restart, or to hand the work to another session, pass that id as \`conversation\`.

Do not start over when a task ran out of time. Resume the same conversation with a larger \`timeout\` and a prompt such as "keep going and finish".

## Permissions

Antigravity uses its own tools and permissions. Headless mode cannot show an approval prompt, so a tool that needs one is denied and the result names the rule it needed. That is a limit of the run, not a tool failure.

When a result is a permission denial, tell the user which operation was refused. They can add an allow rule in the CLI's own settings or turn on "Run commands without asking" in Settings. Do not retry the same call unchanged.

## Errors and the next move

| Code | Move |
| --- | --- |
| \`TIMEOUT\` | Resume the conversation with a larger timeout. |
| \`PERMISSION_DENIED\` | Report the refused operation; the user decides whether to allow it. Do not retry unchanged. |
| \`AUTH_REQUIRED\` | The user must sign in to the CLI on the host machine. |
| \`QUOTA_EXHAUSTED\` | Wait for the plan's reset. Do not retry in a loop. |
| \`MODEL_NOT_FOUND\` | The account does not offer that model. Ask the user to pick one in Settings. |
| \`AGY_NOT_FOUND\` | The CLI is not installed on the host. Report it. |
| \`DISABLED\` / \`ENTERPRISE_MODE\` | Delegation is off for this server; do the work yourself. |
| \`CANCELLED\` | The user stopped the turn. Do not resume unless they ask. |
| \`AGY_FAILED\` | Read the attached details before deciding; do not retry blindly. |

## After the call

Read the changed files yourself and run the tests. If the work landed wrong, send one follow-up with the specific defect inside the same conversation.
`,
};

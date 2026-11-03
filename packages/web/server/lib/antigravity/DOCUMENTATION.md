# Antigravity delegation

## Ownership

This module turns the Google Antigravity CLI (`agy`) into an agent tool and a
`/agy` command. It is not a model provider: Antigravity never appears in the
model picker, Auto routing, title generation or any other request OpenCode
would send to a model. The user's main agent delegates a scoped task, and the
result comes back as an ordinary tool result.

- `cli.js` owns the CLI contract: locating the binary, parsing `agy models`,
  building the run argv, parsing the JSON envelope, and turning a failure into
  a code the agent can act on. Pure except for the injected `isFile` check.
- `runtime.js` owns the lifecycle: the Settings status, the authenticated run
  route, the generated OpenCode plugin, and the process tree.
- The Providers page (`packages/ui/src/components/sections/providers/AntigravityProvidersPage.tsx`)
  owns the setup experience; it never talks to the CLI itself.

## Invariants

- The CLI runs beside this server, in the session's own directory, so web,
  desktop and hosted mobile clients share one implementation. A model cannot
  name a different working directory.
- Settings and enterprise mode are read on every run, not only when the plugin
  is written. Enterprise mode refuses the call even if the plugin is already
  loaded, and the status route reports a blocked state without starting the CLI
  (even `agy models` reaches Google).
- An external OpenCode server is not launched by OpenChamber, so there is no
  managed config to list the plugin in. The status reports `managed: false`,
  the page disables enabling with that reason, and `run` refuses with
  `EXTERNAL_OPENCODE`.
- The plugin exempts its callback host from `NO_PROXY` inside the managed
  child, where the merged environment is visible, so a corporate proxy never
  receives the per-child token.
- The run route accepts only a request carrying the per-child token from this
  machine. The token is minted for each managed OpenCode start, like the agent
  tool's.
- A turn ends when its JSON envelope says so. `status` and the exit code alone
  do not prove completion: a headless soft-denial and a print timeout can both
  arrive as a successful, empty answer.
- Cancellation ends the CLI and the commands it started; a cancelled turn is
  never reported as a result.
- One Antigravity conversation per OpenCode session, kept in the plugin's
  memory so a follow-up continues without naming an id. The result always
  carries the id, which survives a reload.
- A model id or conversation id reaches argv only in the token shape
  Antigravity produces. Anything else is rejected before a process starts.
- Error details are redacted before they reach the model: proxy credentials,
  bearer tokens and key-shaped assignments never leave this module.

## Decisions

### Why the CLI runs on the OpenChamber server and not inside OpenCode

The plugin could spawn `agy` itself, as the reference integration does. Running
it here means one implementation serves every client that reaches this server,
the status route and the tool share the same detection, and a setting or policy
change applies without rewriting the plugin. VS Code runs no OpenChamber server;
delegation is therefore absent there rather than implemented twice.

### Why the run route exists instead of a plugin-side spawn

The route is the enforcement point: it re-reads `antigravityDelegationEnabled`
and enterprise mode on every call, and it owns the process tree that a
cancelled turn must stop. A plugin-side spawn would have needed its own copy of
both, and the enterprise check would only apply at plugin-write time.

### Why delegation is materialized only with the CLI present

An enabled setting on a machine without `agy` would register a tool that always
fails, and the user would read that as a broken provider. The Settings page
already refuses to enable it without a model list, so the plugin and the setting
agree.

### Why auto-approval requires the sandbox

`--dangerously-skip-permissions` approves every tool call. Paired always with
`--sandbox`, an approved command still runs inside the CLI's own terminal
confinement, and the setting is host-owned: the model cannot ask for it. The
default is off, so the CLI's own permission rules apply.

### Why `/agy` sends a prompt instead of calling the tool directly

The command runs in the session, and the reference integration's value is that
the main agent reviews the delegated work. Sending a prompt that names the tool
keeps that review step; executing the CLI from the command would deliver the
answer without one.

### Why the skill is registered by the plugin

The reference integration ships a skill that teaches the agent when delegating
is worth it, how to brief the task and how to resume. The tool description
alone states what the tool does, not when to reach for it. The skill is
registered at runtime, so it is available to agents but is not a file in the
user's skills folder and does not appear in Settings → Skills.

## Attribution

The delegation design, the skill structure and several error-handling decisions
are adapted from `chigarow/antigravity-for-opencode`, MIT licensed:

```
MIT License

Copyright (c) 2026 chigarow
```

The implementation here is rewritten for OpenChamber's server-side callback and
settings model; no source file is copied verbatim.

## Failure behavior

- No binary: `AGY_NOT_FOUND`, with the install page.
- External OpenCode server: `EXTERNAL_OPENCODE`; the page explains it.
- A model or conversation id outside the accepted token shape:
  `INVALID_ARGUMENT`, before a process starts.
- Not signed in or an expired grant: `AUTH_REQUIRED`.
- Quota or rate limit: `QUOTA_EXHAUSTED`.
- Unknown model: `MODEL_NOT_FOUND`.
- A tool headless mode cannot approve: `PERMISSION_DENIED`, carrying the CLI's
  own explanation.
- Print timeout or our host timer: `TIMEOUT`.
- Cancelled by the user: `CANCELLED`.
- Everything else: `AGY_FAILED` with the CLI's stderr.

Every code reaches the agent as text, so it can decide to stop, change the
model, or ask the user instead of retrying blindly.

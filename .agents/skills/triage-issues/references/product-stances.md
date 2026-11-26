# Product stances

Decisions the maintainer has made about what OpenChamber takes and what it leaves out. A request or change that matches a line here is decided: point at the line, with its reason. A stance changes only when the maintainer says so in the session; then edit the line in the same change.

Add a line when the maintainer decides something that will come up again: the stance, the reason in one clause, and the issue or pull request where it was decided.

Sections: Runtimes and backends, Platform scope, Localization, Composer, Sessions and sidebar, Agent tools, Extensions, Providers and quotas, Classification features, Releases.

## Runtimes and backends

- OpenCode is the only agent runtime. No ACP, Pi or other backend: there is no gain now that OpenCode 2.x exists (#3654, #2010). Say that reason; OpenChamber is more than a UI for OpenCode.
- A feature idea is taken on its merits even where OpenCode owns the area. OpenCode is building blocks OpenChamber can rework or route around.
- The supported remote setup runs OpenChamber and OpenCode on the same server. A local OpenChamber working on a remote OpenCode's filesystem is unsupported (#3113); small real bugs found in such reports still get fixed.
- Git is the only version control system. No jj, Lore or other backend (#5605).
- No live sync with other agent apps.
- External tools act on OpenChamber through files it watches, such as `settings.json`.
- An optional server capability never hardcodes a nonstandard endpoint, unless the maintainer names the path; the speech-server voice list is the one exception (#6482).
- A custom speech server's voices are read from `<base URL>/audio/voices` only, the path Kokoro-FastAPI, Speaches and LocalAI share; other servers keep the text field, and Custom… takes any voice. No speaker choice for now (#6482).

## Platform scope

- Multi-tenancy, a second auth system and hosting infrastructure are built by the core maintainers only (#3438).
- Scheduled git sync of agents or dotfiles is a cron or launchd job on the user's side (#4323).
- A catalog of agents pulled from git repositories is declined as one company's need (#4501); it fits an extension. A bundle of agent, plugin and ready MCP server would be considered. Private skills catalogs exist (#4494).
- Several instances under one hub: later.
- Isolated spaces are unfinished. Nothing else builds on them yet.

## Localization

- Russian localization is declined. The reply text is the *russian-locale* template in the `triage-prs` skill.

## Composer

- No prompt optimizer. Mid-session the agent already sees more than a rewriter would, and that is the reason to give.
- Autocomplete: no resizing, no favorites, no word completion.
- The composer is moving off CodeMirror, so nothing new builds on CodeMirror.
- A quote is exactly what the user selected and is never widened implicitly.
- No usage timers that resend a prompt. Quota exhaustion is handled by a fallback provider or model and by switching accounts.
- A model that can't read images always gets images as saved files and their paths, with no setting. `savePastedImagesAsFiles` only adds the saved copy for models that read images (Discord report on browser annotation screenshots, 2026-11).

## Sessions and sidebar

- No cross-session message bus (#3757). Agents already send to and read other sessions through the `openchamber` tool.
- Chats are isolated sessions.
- Chats have their own defaults (Settings → Sessions → Chats: model, thinking level, agent) for every new chat, including chats an agent tool starts and chats from a scheduled task set to use session defaults. An empty field uses New sessions. VS Code reads the shared Chats values and has no Chats section of its own yet (a separate todo, #7226).
- No built-in Recent section. Users build their own sidebar sections, a Recent one included.
- In work rows show the project as an icon; the header and Work Status name it. Users give projects distinct icons.
- Cmd+P shows no session status dot; a separate overview view is the plan. No manual unread mark.
- The agent's todo list is not editable from the UI until OpenCode has an API for the current list.
- VS Code sessions enter In work only by hand.
- In work lists only works that no shown section of the user's own lists (#6220); sections filtered by state and groups of projects take nothing, time filters do take. No per-section switch and no first-match order.
- A pinned work stays out of In work unless "Also in work" on Pinned is on, off by default and one value for all devices. Done on a pinned worktree never archives it.
- Notes and todos in project files are opt-in.
- A session an agent creates with `ownWork` is part of that agent's work: it nests under the agent's session in any folder, takes its done state from it, and nobody talks to it (no question tool, no secret cards, no waiting pages). The user takes one over only from the session's or worktree's menu; opening or writing in it changes nothing. Done on the agent while its workers run asks once: stop them or let them finish. Without `ownWork` a dispatched session stays the user's own root.
- The Scheduled Tasks target picker lists root sessions at rest and finds subagents only by search, each named as its parent's subagent; `ownWork` workers never appear (OPE-374, #6315).
- A subsession in a folder outside every project (a removed worktree, a folder outside the projects) shows under its parent and opens through the parent's folder; its own folder is never registered. A root session there stays hidden, except one in a linked checkout that Git confirms belongs to a repository inside a registered folder: it shows and opens under that project in Projects, In work and search, unless the user declined its folder trust. A separate clone stays hidden ([#7343](https://github.com/openchamber/openchamber/pull/7343)).
- The agent's sidebar row shows no running/finished count of its `ownWork` sessions: they keep the row working and sit in its subtree.
- A lead decides what its `ownWork` sessions ask; it is never a proxy for their questions. Its digest's Needs you holds only the lead's own questions, never a count of its children's pending permissions or questions. A lead stays one session with a brief and a digest: no per-lead task tracker, groups of leads or lead workspaces.
- Between sessions, an idle session has answered: nothing an agent asked another session for waits on that session's subagents, workflow agents or `ownWork` sessions. Signals for the user and for review keep waiting on them, because the parent wakes again on each result: the "ready" notification, the extensions' `turn-finished` event and automatic review.

## Agent tools

- Code Mode stays on for every model, with no setting to turn it off and no per-category toggles (#6608). Per-tool on and off settings stay. A model that struggles gets clearer session guidance.
- Agent tools are split by subject, with no per-action toggles.
- OpenChamber never reads, detects or writes another plugin's private state files, such as oh-my-openagent's. An extension can.
- No inference debug dump.
- One tool per job: while an OpenChamber tool is on, the OpenCode built-in that does the same job is disabled in the managed config (`opencode.tool.image-generate` for `openchamber_image`, `opencode.tool.automation` for `openchamber_schedule`).

## Extensions

- A tool for one user's niche, such as a worktree scratchpad, is an extension.
- Extension contributions are declared independently of each other (#6313).
- Quota cards for third-party services are extensions.

## Providers and quotas

- Custom provider model discovery is a one-time prefill triggered by a button in the custom provider form, and is refused in enterprise mode (#4193).
- OpenRouter OAuth goes directly through OpenChamber, without a wrapper service.

## Classification features

Features that send a question to a classification model.

- Wanted: a provider error mapped to one known class with one concrete action button.
- Declined: collapsing noisy tool output, semantic search in settings, skill or command chips, a stuck-agent detector, a "said done but wasn't" check, automatic review on completion, automatic pick of a pull request remote, and anything that sends diffs or code. Changed files are not a done signal, because agents share one checkout.
- One call per turn at most, with questions batched into it. Each feature has its own setting and is off until the user turns it on.
- Criteria are general common sense, never phrases taken from one user's messages.

## Releases

- 1.x is not maintained. Users of a plugin that only supports 1.x ask its author to port it to OpenCode 2.x.
- Update notes live in Settings > About.

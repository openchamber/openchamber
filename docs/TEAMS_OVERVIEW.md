# OpenChamber Teams — Overview

**Status:** Active fork. Upstream: [openchamber/openchamber](https://github.com/openchamber/openchamber).
**Goal:** Turn OpenChamber into a GitHub-native command center for individuals,
GitHub-hosted teams, and fully-local teams, with the agent experience at the
center of every workflow.

This document is the short reference. Per-mode design docs live next to it:

- [`MODE_1_INDIVIDUAL.md`](MODE_1_INDIVIDUAL.md) — Individual GitHub mode (current focus, autonomous-agent-ready)
- [`MODE_2_GITHUB_TEAM.md`](MODE_2_GITHUB_TEAM.md) — GitHub Team mode
- [`MODE_3_LOCAL_TEAM.md`](MODE_3_LOCAL_TEAM.md) — Local Team mode
- [`IMPLEMENTATION_GUIDE.md`](IMPLEMENTATION_GUIDE.md) — cross-cutting rules for coding agents (read before any mode doc)

## The three modes at a glance

| Mode                  | Who                                                 | Identity          | Source of truth    | Killer feature                          |
| --------------------- | --------------------------------------------------- | ----------------- | ------------------ | --------------------------------------- |
| **1. Individual**     | Solo developer using GitHub daily                   | GitHub OAuth      | GitHub.com         | Issue-to-Work pipeline                  |
| **2. GitHub Team**    | 2–50 person team in a GitHub org                    | GitHub App        | GitHub.com         | Session handoff across teammates        |
| **3. Local Team**     | Co-located / regulated / self-hosted teams          | Device keypair    | Host machine       | Live shared AI sessions (CRDT + follow) |

Users can live in more than one mode at once — the modes are views over the
same underlying app. Mode selection is "what does the work at hand require
right now?".

## Why start with Mode 1

- **Lowest risk, fastest value.** No new auth system, no webhooks, no CRDT.
- **Reuses what already works.** The existing `packages/web/server/lib/github/`
  module already owns auth, Octokit, PR status, issues, pulls, and CI checks.
- **Biggest user pool.** Every solo dev with a GitHub account is a target user.
- **Foundation for Mode 2.** Everything Mode 1 learns about GitHub data shapes,
  UI placement, and agent hand-offs is reused when we move up to team scope.

## The single primitive behind every mode

> **Go from a GitHub artifact → an AI session that is already set up.**

Issues, PRs, review comments, failing CI runs, notifications — each of these
is a pointer to "work that needs doing". Every mode exposes one-click paths
that turn that pointer into a fully loaded OpenCode session: right branch,
right worktree, right context already in the prompt. The three modes differ
in *who* is involved, not in this primitive.

## What this fork does NOT aim to do

- Replace GitHub. GitHub stays the source of truth for code, PRs, reviews.
- Replace Slack. Conversation lives where it already lives. We only add
  context-bound chat inside sessions.
- Become a multi-tenant SaaS. Each mode runs local to the user or the team's
  host machine. No central hosted service is part of this fork's scope.

## Roadmap at a glance

1. **Mode 1 (now):** Inbox, Issue-to-Work, PR Cockpit, Review-Comment-to-Session,
   CI log triage. ~4 weeks.
2. **Mode 2 (next):** Team workspaces, PR board, CODEOWNERS-aware review routing,
   shared skills, session handoff, webhook-driven real-time. ~5–6 weeks.
3. **Mode 3 (last):** Host/peer, TOFU device auth, CRDT-backed shared sessions,
   follow mode, agents-as-participants. ~6–8 weeks.

See each mode's doc for endpoint lists, UI locations, data model changes, and
acceptance criteria.

## Feature matrix (quick scan)

| # | Feature | Mode | Depends on | Priority |
| --- | --- | --- | --- | --- |
| 1.2 | Issue-to-Work Pipeline | 1 | existing worktree + session APIs | **first** |
| 1.3 | PR Cockpit | 1 | existing PullRequestSection | high |
| 1.4 | Review-Comment-to-Session | 1 | 1.3 | medium |
| 1.5 | Actions Log Triage | 1 | 1.3 | medium |
| 1.1 | Unified GitHub Inbox | 1 | 1.2, 1.3, 1.5 | ships last in Mode 1 |
| 2.1 | Team Workspaces | 2 | Mode 1 | **first** in Mode 2 |
| 2.2 | Webhook Receiver | 2 | 2.1, tunnels module | high |
| 2.3 | Team PR Board (Kanban) | 2 | 2.2 | high |
| 2.5 | Session Handoff | 2 | 2.1 | **core team feature** |
| 2.4 | CODEOWNERS-aware review routing | 2 | 2.3 | medium |
| 2.6 | Shared Team Skills | 2 | 2.1, existing skills-catalog | medium |
| 2.8 | Repo Activity Feed | 2 | 2.2 | medium |
| 2.7 | Multi-Agent Team Votes | 2 | 2.1, existing multi-agent | low |
| 2.9 | Projects/Milestone Sync | 2 | 2.1, project scope | low |
| 3.1 | Host mode | 3 | Mode 2 | **first** in Mode 3 |
| 3.2 | Device identity | 3 | 3.1 | **first** in Mode 3 |
| 3.3 | TOFU pairing | 3 | 3.2 | **first** in Mode 3 |
| 3.11 | Local admin UI | 3 | 3.3 | high |
| 3.4 | Shared session CRDT | 3 | 3.3 | **killer feature** |
| 3.5 | Presence + Follow | 3 | 3.4 | **killer feature** |
| 3.7 | Session ownership | 3 | 3.4 | high |
| 3.6 | Agents-as-participants | 3 | 3.4 | high |
| 3.8 | Shared context pool | 3 | 3.4 | medium |
| 3.10 | Local activity feed | 3 | 3.3, Mode 2 activity_events | medium |
| 3.9 | Team chat | 3 | 3.4 | low |
| 3.12 | GitHub bridging in local team | 3 | 3.1, Mode 1 auth | optional |

"First" markers are the **only** safe starting points per mode. All other
features are gated behind them.

## Data model at a glance

- **Mode 1:** no new persistent data. Uses GitHub as source of truth plus
  local JSON for snoozes / prefs in `~/.config/openchamber/teams/`.
- **Mode 2:** adds a team SQLite database with:
  `workspaces`, `workspace_members`, `activity_events`, `assignments`,
  `handoffs`, skills-catalog `scope` column migration.
- **Mode 3:** extends the same SQLite file with:
  `trusted_devices`, `pairing_invites`, `shared_sessions`; adds on-disk Yjs
  docs in `~/.config/openchamber/teams/ydocs/`; uses the same
  `activity_events` table.

Full schemas live in the respective mode docs.

## For autonomous agents

This project is set up to be built by an autonomous coding agent (e.g.
Kimi 2.6 running in a ralph-style loop). The full protocol — reading order,
verification gates, commit policy, stuck protocol — lives in
[`IMPLEMENTATION_GUIDE.md`](IMPLEMENTATION_GUIDE.md). Every mode doc has a
*Defaults for autonomous runs* section and per-feature *Stuck checks*.

Human reviewers: if the agent is operating well, per-feature commits should
land at a predictable cadence (see each mode's "Commit plan" entries).
Anything that doesn't fit those patterns is a signal to intervene.

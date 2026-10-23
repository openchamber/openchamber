# Bots client contracts

## Ownership

This module owns the typed public Bots configuration, item and identity schemas,
and bot-session membership. `../botsApi.ts` parses the server routes and
`../botsRuntime.ts` supplies their runtime lifetime. Components own presentation;
the server schemas and routes under `packages/web/server/lib/bots` own writes
and execution authority.

## Invariants

- Requests use `runtimeFetch` for the selected server's URL, authentication and
  relay transport. VS Code is rejected before a request is sent.
- A runtime switch aborts the previous lifetime before endpoint credentials
  change. A new lifetime is published only after the replacement endpoint is
  installed. Even an A-to-B-to-A visit retires A's original requests.
- API failure throws; it never becomes successful empty config or items.
  Responses are parsed at the boundary. Identity schemas discard secret-bearing
  fields, and request errors expose a code rather than an upstream error body.
- Config writes contain editable fields only. Identity POST sends the raw
  definition; PUT sends `{ definition, expectedRevision }`; DELETE sends
  `{ expectedRevision }`. Secret-bearing resolution is server-only.
- Jira OAuth service identities use `kind: 'jira-oauth'` and write exactly
  `{ kind, label, site, cloudId, clientId, clientSecret }`. The site is the canonical
  `https://<tenant>.atlassian.net` origin, `cloudId` is a UUID string and `clientId`
  is nonempty. Public responses retain the kind, site, cloud ID and client ID;
  client secrets and tokens are discarded. Existing Jira account/service kinds
  retain their email and API-token write contracts.
- Optional `space` options contain exact network and explicit provider references.
  Strict nested parsing rejects typed secrets and URL credentials. Missing options
  grant nothing; disabling isolation retains the configured references.
- `definition.discord.channels` defaults to `[]` for existing definitions and
  contains at most 100 unique `{ guildId, channelId }` pairs. Both IDs remain
  decimal strings and use the server's snowflake constraints. No channel is
  inferred from the bot identity or from a global default.
- Item detail is `{ item, reports, snapshot, sessionDirectories }`; archive is `{ items }`. The root
  snapshot is `{ config, revision, items, presets }`. Item answers preserve their
  client event ID on retry so the server can deduplicate them.
- `sessionDirectories` maps session IDs to nonempty server-captured addresses.
  A missing field defaults to an empty map for older servers. Malformed entries
  fail the read; item worktrees never supply missing session addresses.
- Membership comes from `metadata.openchamber.automation.source === 'bot'` with
  its project, bot, item and stage, then follows parent links to descendants.
  Titles, worktree paths and persisted activity are not membership evidence.
  Same-ID metadata replacements are re-evaluated, and malformed parent cycles
  terminate without inventing an owner.

## Decisions

### Why shared membership and not separate sidebar heuristics

Desktop and mobile must exclude the same bot hierarchy from ordinary project
and In work groups. A single metadata selector also resolves live requests on
unmarked descendants without treating every scheduled session as a bot.

### Why parsed public responses and not secret-bearing identity models

The UI needs immutable IDs and revision references, never credential values.
Separate public schemas keep accidental extra response fields out of component
state while the server remains responsible for never returning those values.

### Why a separate Jira OAuth kind

OAuth service accounts require a cloud ID and client credentials. A separate
kind preserves existing email/API-token identities and lets the shared Jira
picker accept both through its `jira-` kind prefix.

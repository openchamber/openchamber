# Settings sections

One directory per Settings page. `shared/` holds the page chrome and controls
every page is built from; see `.agents/skills/settings-ui-patterns/SKILL.md` for
which primitive to reach for.

## Autosave on the OpenCode configuration pages

`agents/`, `commands/`, `skills/`, `mcp/`, `plugins/` and `behavior/` edit files
that OpenCode v2 watches: it picks up a change and applies it within a second or
two, and the server answers every config mutation with a plain
`{ success, message }`. There is no restart to wait for and no restart state to
show, so these pages carry no Save, Apply or Discard button.

The contract, implemented by `shared/SettingsAutosave.tsx`:

- Toggles, chips, selects, pickers and row removals write immediately. They call
  `requestSave()` right after setting state; the hook runs the save after the
  render commits, so the routine reads the value the control just set.
- Text fields write when they lose focus. `SettingsPageLayout` takes the hook's
  `onBlurCapture`, which fires for any input, textarea or editor inside the
  page, so individual fields need no handler. Long editors (the skill document,
  a plugin file) also write on Cmd/Ctrl+Enter.
- A page's save routine compares the form against what it last wrote and returns
  `AUTOSAVE_UNCHANGED`, `AUTOSAVE_SAVED` or `autosaveFailed(reason)`. Success is
  silent and there is no inline "Saving…"/"Saved" indicator: a write is not
  something the user waits for. A failure is an error toast,
  "Couldn't save: <reason>", raised by the hook itself.
- **One page, one save routine.** A section that writes its own request still
  reports through the page: `agents/AgentPermissionsEditor.tsx` hands its save
  routine to `AgentsPage` via `registerSave`, and the page's save runs it, so a
  failure is reported once.
- Saves run serially. A save request received during a write queues one follow-up
  using the latest committed form state. Unmounting prevents that follow-up.

Do not route these pages through `reportSettingsSaveState` / `showSaveStatus`.
That indicator belongs to settings persisted by `updateDesktopSettings`, and it
is deliberately silent on success.

### Reconciliation

OpenCode re-reads files after writes. Store refreshes can arrive before the
save promise settles, while the user is already editing the next version.
Commands compare incoming values with both the saved baseline and the normalized
submitted snapshot. Successful saves keep that normalized baseline for late
echoes. Agents and MCP preserve dirty drafts and their baseline during refreshes
of the same entity; successful saves advance that baseline. Skills and plugins
preserve dirty drafts while updating their server baseline. A failed write leaves
the form dirty for retry. Superseded skill detail reads are ignored.
Behavior only normalizes the submitted prompt if the user has not changed it.

Scope reconciliation to the selected entity and Settings directory. Selecting
another entity hydrates its form, and an older save completion must not replace
its baseline. Runtime endpoint changes remount Settings through the keyed
`SyncProvider` in `App.tsx`.

### Creating an entity

A new agent, command, skill or MCP server is a draft in its store, not a file.
Nothing is written while the draft is being filled in: the page shows Create and
Cancel, Create validates (name, and whatever else the entity needs) and writes
once, and Cancel drops the draft. Abandoning a half-typed entity leaves nothing
on disk. Once the entity exists, the page switches to the autosave rules above.

`skills/` follows the same split for supporting files: editing an existing file
writes when the dialog closes, while a new file is only created on confirm.

## Providers

`providers/` is not an autosave page. Connecting a provider is an action, not a
setting: an API key is submitted, an OAuth flow is completed, a credential is
removed. OpenCode owns the credential store and announces every change
(`credential.*`, `provider.updated`, `model.updated`), and it watches the config file a custom
provider is written to, so the page never asks for a reload or a restart: it
refetches its own provider sources and integrations and lets the catalog
events refresh the stores. (The old "nudge" went through `/api/config/reload`,
which restarts a managed OpenCode and showed the reload overlay.)

Every credential write (`integration.connect.*`, `integration.oauth.*`) goes
to the location the integration list is read from, through
`getIntegrationClient()` in `lib/opencode/integration-catalog.ts`. OpenCode
registers integrations per location once that location's plugins activate,
and only `integration.list` waits for it. An unscoped write landed in the home
location, which nobody had read yet: it booted there and answered
"Integration not found", so every first connect failed and the retry worked.
`credential.*` routes are not location-bound and stay unscoped.

An integration method can declare a `form` (an Azure resource name, a
Cloudflare account id). OAuth, external and API key methods render it through
the same `ProviderFormFields`, check required fields with the helpers in
`provider-oauth.ts`, and send the answers with the connect call. OpenCode
rejects a key whose required fields are missing. A `custom` field with options
(AWS profiles, Azure resources OpenCode found on the server) offers "Other…"
for a value it did not find.

A provider's sign-in buttons come from its integration's `oauth` and
`external` methods in declared order (`getSignInMethods`), both rendered by
`providers/ProviderOAuthMethods.tsx`. An `external` method (2.0.25+: Azure CLI
login, AWS profile for Bedrock) asks only its form and calls
`integration.connect.external`, which stores a reference to credentials managed
outside OpenCode; the account then lists as "External credentials".

A provider's credentials show as one collapsible card per kind: API key,
browser sign-in, credentials on the server machine
(`providers/ProviderAuthMethodCards.tsx`, built on the Integrations page's
`IntegrationCatalogCard`). The same cards serve the connect page and a
connected provider's page, where they are always on screen. A card names its
kind, says in one line how it works, and carries a pill: In use, Not in use,
Sign in again or Not connected. Opened, it lists the stored accounts of its
kind with their Use, Rename and Remove actions, then the field or button that
adds another. Under a stored account that field or button waits behind "Add
account": an empty key field under a key reads as "replace this key" and a bare
Connect as "reconnect", while both add another account that becomes active. A
provider with one kind starts with its card
open. Keys from environment variables are listed above the cards. A key
OpenCode takes from the environment or the config, or credentials on the
server machine, mark their own card In use, or the key card when the provider
has no card of that kind. In enterprise mode the cards keep the stored accounts and
offer nothing new.

The cards replaced a separate account list over an "Add account" panel that
stacked the key form and the sign-in buttons. That panel read as steps to
complete in order: people saved a key and then signed in as well, and only
learned from "not in use" that one replaces the other, while the account list
repeated what the pills now say. A stored credential records its kind (`key`,
`oauth`, `external`) but not the sign-in method that made it, so the sign-in
methods of one kind (OpenAI's ChatGPT and legacy Codex flows) share one card.
Closing a card unmounts its body, which cancels a sign-in still waiting there,
the same as its Cancel button.

Vertex can sign in through Google Application Default Credentials on the server
machine, which OpenCode neither stores nor reports as a connection. When
OpenCode resolved a project for Vertex (`settings.project` on the provider it
serves), `usesMachineCredentials` counts that as credentials: the card shows
"From environment" and the models section stays open. A provider listed in the
OpenCode config is switched on (`activation: "enabled"`) even without a key, so
activation alone is not a sign-in signal.

The custom-provider form can discover models before save through
`POST /api/provider/discover-models`. Discovery is a one-time prefill the user
starts with "Find models": they pick which returned models to add, the review
panel closes, and nothing stays in sync with the provider afterwards (a
maintainer decision; never add a recurring refresh). Provider metadata wins
field by field and models.dev fills the gaps. Discovery failure never removes
rows or blocks saving.

Model rows render collapsed (name, id, limits, non-text inputs) so a provider
with dozens of models stays scannable; a row added by hand opens, and a row
with a validation error opens on submit. Capabilities are written to the
OpenCode config only when they are known (saved config, discovery, or the
user's edit, `capabilitiesKnown`); otherwise the key is left out so a save
never replaces what OpenCode knows about a model with a text-only default.

Custom-provider icons are OpenChamber profile preferences, keyed by provider
ID. They are not written into OpenCode config because OpenCode has no provider
icon field. "Default" stores nothing, so the provider's own logo (or the
generic fallback) still shows; `ProviderLogo` reads a chosen icon before trying
provider logos, so Settings and every model picker agree.

The "Connect provider" page lists `GET /api/integration` minus the
integrations that already have a connection, MCP OAuth registrations
(`mcp_*`), web search providers (the ones `websearch` lists, and integrations
a plugin marks with `metadata.websearch`, which it lists for search only once
connected), and providers OpenCode already lists (those
connect from their own page); v2's `GET /api/provider` lists only what is
configured or connected right now, so it cannot offer anything new
(`providers/connectableProviders.ts`). Popular providers come first as cards,
in the fixed order of `POPULAR_PROVIDERS`, with a one-line note and a
Recommended pill on the ones the maintainer recommends; every other provider
is a compact row behind "Show all", and the search covers all of them.

The integration list is kept for the app session by
`lib/opencode/integration-catalog.ts`, so the page opens on it without a
loading state. The desktop/web/VS Code app reads it once at startup when the
browser is idle (`hooks/useIntegrationCatalogPrefetch.ts`); the phone layout
and relay connections skip that read, because relay bytes are paid, and read
it when Settings opens. The snapshot is only a starting point: the page reads
the list again on every visit and after every credential write, a read
started earlier never replaces a later one, and a snapshot from another
runtime is ignored.

### MCP OAuth

A remote MCP server with OAuth enabled is registered by OpenCode as an
integration (`mcp_<hash>`, `metadata.source: "mcp"`, named after the server)
with one `oauth` method, so signing in is the same connect / status /
complete flow the Providers page runs. `mcp/McpOAuthSignIn.tsx` looks the
integration up by server name in the server's directory (the registration is
per Location) and mounts the shared `providers/ProviderOAuthMethods.tsx`
with that directory. While the server reports `needs_auth`, the status card
shows its sign-in row; once the credential is stored, the page connects the
server again, which is what moves it out of `needs_auth` or `failed`.

### Why a failed OAuth server's header says "Sign in again"

When the service rejects the stored token (a refresh answered with 403
`access_denied`), OpenCode reports the server `failed`, not `needs_auth`, and
keeps the rejected credential. Connect only sends it again. A fresh sign-in
starts with no tokens (it reuses only the earlier client registration) and
its new credential is the one the next connect uses, so signing in is the
whole recovery; no sign-out call is needed.

So for a `failed` server whose OAuth integration exists
(`useMcpOAuthIntegration`), the header's primary button is "Sign in again" in
place of Connect, and the card shows no second sign-in row: each press mounts
a fresh `McpOAuthSignIn` with `autoStart` and its start button hidden, so only
the attempt's progress appears. Test connection stays on the status line for
the other cause of `failed`, a server that was down; it retries with the
stored credential. A `failed` server without OAuth keeps Connect.

The Integrations catalog keeps its sign-in row and labels its button "Sign in
again" for `failed`, gated on the entry's `auth: 'oauth'` so a failed
token-based entry gets no sign-in block. It starts the sign-in by itself after
an install only for `needs_auth`: a first connect that failed for another
reason waits for a click.

### Claude sign-in on Usage

Claude usage reads Claude Code's own login on the server machine, which the
Providers page cannot add. When Claude reports not configured, the Usage page
shows `usage/ClaudeCodeSignIn.tsx` in its warning instead of the "go to
Providers" text. With the opencode-claude plugin installed it mounts the
plugin's `claude-code` integration sign-in through the shared
`providers/ProviderOAuthMethods.tsx` and re-reads Claude usage once it
finishes. Without the plugin, or when the integration list cannot be read, it
shows the `claude auth login` command, which works in both cases.

### Policy-blocked MCP servers and skills

OpenCode drops an MCP server or skill an `integration.use` deny names
(`mcp:<name>`, `skill:<id>`, wildcards allowed) from its own lists, while the
MCP and Skills pages list what the config files and the disk hold.
`shared/useIntegrationPolicyBlock.ts` reads the statements from
`/api/config` (`readIntegrationPolicies`, decided like OpenCode: documents
reversed, last match wins) and the MCP page marks such a row "Blocked by
policy" and disables Connect and Test. Statements from a connected OpenCode
Console workspace are not in `/api/config`, so a server blocked only there is
not marked.

The Skills page reads the same statements from the skills store. One choice,
"Agents use it" (`skills/SkillUseField.tsx`), answers when agents get a skill:
Automatically, When called (the skill file's `disable-model-invocation` flag)
or Off. A skill's id is its `SKILL.md` folder name, not its display name. Off
writes an exact `skill:<id>` deny where the skill lives (project config for a
project skill, global config otherwise) and leaves the file's flag alone;
leaving Off removes the exact deny from every config file OpenCode reads for
the directory, hand-written ones included. A skill an exact deny turns off
reads "Off" in the sidebar. A wildcard deny is someone else's rule: the choice
is locked, the row reads "Blocked", and the page names the rule and its file.
An allow that decides the skill is named the same way.

### Why one choice and not a switch beside the checkbox

"Run only when called" and "off" answer the same question, when an agent may
take the skill, so two controls let a user set a combination that reads as
nonsense (off, but only when called). One three-way choice keeps them apart
in storage and together on screen.

### Why Off writes where the skill lives and not into a chosen scope

A scope picker would make every user learn how OpenCode orders global and
project policies (global wins) before turning a skill off. Writing where the
skill lives covers the common case with one control, and turning it back on
clears the skill's exact deny wherever it is, so no file keeps a stale rule.

## Skills catalog list

The catalog page lists one source, or every source's search matches, in
`skills/catalog/SkillsCatalogRows.tsx`. From 100 rows on it mounts only the
rows near the viewport, measured inside the settings page's own scroller; a
shorter list renders every row.

### Why a threshold and not a virtualized list for every source

A source can hold thousands of skills: `sickn33/agentic-awesome-skills` has
8,451, and mounting them all froze the page for about 28 seconds on a source
click and up to 47 seconds per search keystroke (#5455). Most built-in
catalogs hold fewer than 60 rows, and a fully mounted short list keeps the
browser's find-in-page and Tab order over every row.

### Why the list waits for the page's scroller

A virtualizer attached before it knows the scroller starts at offset 0 and
scrolls there, so clicking Cursor or a large source on a scrolled page jumped
to the top. The list finds the scroller first, starts from its `scrollTop`,
and holds its estimated height meanwhile, because a list of height 0 for one
render shortens the page and the browser clamps the scroll position.

### Why a row measured at 0 keeps the estimate

A page hidden while the list is mounted measures every row at 0 height. The
virtualizer would then fit the whole list into the viewport, mount all of it,
and re-render without end, so a zero measurement keeps the estimated height.

## Integrations: provider cards

`integrations/IntegrationsPage.tsx` draws one card per source-control provider
and one per tracker the connected server serves, in the registries' order
(`lib/source-control/providers/registry.ts`, `lib/trackers/registry.ts`). No
card names a provider: a provider the server adds (Gitea) appears with no code
here. Source-control cards are left out in VS Code, which uses the editor's own
Git integration; tracker cards exist where the runtime has `RuntimeAPIs.trackers`.

`integrations/SourceControlProviderCard.tsx` takes its name, mark and wording
term from the descriptor. Its body is one `openchamber/ProviderInstanceAccounts`
block per instance of that provider (the default instance stands in until one
is listed), and "Add instance" where the descriptor's settings take an address
(an `instance-url` field) and `instances.multiple` allows another or none is
set up yet. A block offers the sign-in methods the descriptor names *and* the
instance reports available (`capabilities.authenticationMethods`): device
code, personal access token, and the provider's CLI login. When both the
device code and a token are offered, a chip switch (`SettingsChipGroup`)
picks one and only its form shows; it starts on the method an existing
account came from (`oauth` is the device code, `pat` the token), else the
first one the descriptor names. The CLI login keeps its own row. The token
form shows the scopes the descriptor names, literally, under "Create token";
the info hint stays.
Where the descriptor's settings have a `username` field, the token form asks
for a username above the token and sends both (`authSetToken(…, { username })`);
an `http-password` field names the secret an HTTP password instead of a token
(`sourceControlProviderSettings.ts`). Gerrit signs in this way.
`normalizeInstanceInput` reads what the user typed the way the descriptor
says: an origin or a bare host, HTTPS only (HTTP on loopback where allowed), a
port only where allowed, reserved instances refused.

Invariants:

- A token field is a password input that starts empty, is cleared once the
  server accepts the token, and is never logged; a rejected token
  (`INVALID_TOKEN`) stays in the field with the rejection under the address.
  An instance the server says belongs on another provider's card
  (`SourceControlInstanceOtherProviderError`) keeps the token too, and the
  line under the address names that provider by its descriptor's label.
- An instance's async work is dropped when the runtime switches mid-flight
  (`captureRuntime`), so a late answer never writes into the next server's state.
- The github.com device flow (`openchamber/GitHubComAccountSection.tsx`) shows
  only for a descriptor whose `instances.legacyFlow.kind` is
  `github-com-device`; the instance list under it, titled "Other instances",
  leaves that instance out.
- A descriptor that names a settings field kind this version cannot draw shows
  an "update OpenChamber" line instead of the instance setup.
- Settings search anchors: the card is `integrations.source-control.<id>`, its
  body `.connect`; tracker cards keep `integrations.<id>` and its
  `.add-workspace`, `.mapping` and `.session-comments` anchors, the ids
  Linear's entries always had.

`integrations/TrackerSettings.tsx` is the tracker card: browser sign-in with a
poll that stops when a new or re-authorized account appears, disconnect, and the
account switch where `multipleAccounts` is set. `TrackerProjectMapping` and
`TrackerSessionComments` show where `projectMapping` and `sessionComments` are
set. A tracker that offers no browser sign-in asks for an update instead of a
dead Connect button.

### Why `{provider}` keys and not keys per provider

The sentences these cards show name the provider through `{provider}` and the
CLI through `{cli}` (`settings.sourceControl.*`, `settings.integrations.tracker.*`),
so a provider the server adds reads correct sentences with no keys of its own.
`openchamber/sourceControlProviderSettings.ts` selects only what really differs:
the description by change-request term and the instance hint by
`allowLoopbackHttp`. `integrations/trackerSettingsCopy.ts` keeps whole sentences
per tracker only where they carry the tracker's own nouns (Linear's workspace
and team), because interpolating a noun breaks case and gender in de, pl, uk
and fr; any other tracker reads the generic account and group sentences.

### Why a method switch and not stacked rows

The sign-in methods used to stack, the device code's Connect above the token
field, so a first visit read as two competing forms. The maintainer chose a
chip switch: the card opens on one Connect choice and the other method is one
click away. A chip group rather than radios because the labels are short and
`settings-ui-patterns` puts short exclusive choices in chips.

## Magic Prompts

`magic-prompts/` is not an autosave page: each prompt block has its own Save
and reset button. Storage and resolution belong to
`packages/web/server/lib/magic-prompts/DOCUMENTATION.md`.

The page opens on the Global scope. The Project scope edits the project the
Settings project selector names, matched by exact path, so a worktree
registered as its own project keeps its own id. Choosing it never moves the
chat. Saving the built-in text in Global removes the global override; in
Project the same text stays an override, because it still wins over a
different global one.

A failed read or an `invalid` scope shows the error with Retry and no editor,
never editable built-in text. Drafts and writes are kept per runtime, scope,
project and prompt. A context runs one write at a time, because every write
answers with the whole scope and overlapping answers could land out of order,
and a read older than the latest write is dropped. File paths render as their
own `dir="ltr"` element so an RTL sentence never reorders them.

The page is hidden in VS Code (`metadata.ts`).

## Plugin duplicate sources

`plugins/PluginsGrid.tsx` keeps every configuration entry and its editing target.
A discovered package card is hidden when its normalized target is already
represented by a declaration or another discovery record. Distinct declarations
and their options remain separate, including declarations of the same target.
Editable local files always keep their own cards and file edit/delete actions,
including files declared in config.

### Why paths determine discovery duplicates

Names can match for unrelated plugins, and OpenCode's runtime list can omit
disabled or not-yet-loaded plugins. Only exact target paths filter discovery;
runtime status never controls card membership. Web, Electron and mobile use the
server's path metadata; VS Code's file-only discovery stays visible.

Discovery records keep their original `absolutePath` for runtime matching and
their canonical `resolvedPath` for duplicate filtering. Resolving symlinks in
the runtime path would lose statuses reported through the original alias.

## Entity shapes: OpenCode 2 only

Every OpenCode entity these pages read and write speaks the v2 shape defined in
`packages/web/server/lib/opencode/DOCUMENTATION.md`, section "Entity routes (v2
shapes)". The server reads v1 files too and rewrites them in place as v2; the UI
only ever sends v2.

| Entity | What the page reads and writes |
|---|---|
| Agent | `system` (the markdown body), `description`, `model` as `provider/model#variant`, `mode`, `steps`, `hidden`, `color`, `request.body.temperature` / `request.body.top_p`, and an ordered `permissions` rule list |
| Command | `template` (the markdown body), `description`, `agent`, `model` with `#variant`, `subagent` |
| MCP server | `type` (required), `command` / `url`, `environment`, `headers`, `disabled`, `codemode`, `timeout: { startup, catalog, execution }`, snake_case `oauth` |
| Provider | `package` with the `aisdk:` prefix, `settings.baseURL`, `headers`, `body`, models keyed by id with `modelID`, `capabilities`, `variants`, `cost.cache.read/write`, `disabled` |
| Plugin | `{ package, options }`, serialized as a bare string when there are no options |

Two consequences worth knowing:

- **Edit the stored entry, never the resolved one.** `AgentInfo` and the model
  catalog are what OpenCode resolved: built-in defaults, global config and live
  session grants are already merged in. Writing that back would bake them into
  the file. `agents/AgentsPage.tsx` and `AgentPermissionsEditor.tsx` therefore
  read `GET /api/config/agents/:name/config` and `…/permissions`, and the
  commands store reads `GET /api/config/commands/:name/config` because the v2
  `CommandInfo` carries only a name and a description.
- **`request` is replaced wholesale.** A PATCH that sends `request` overwrites
  the whole block, so `AgentsPage` merges the fields it owns into the stored
  `request` instead of sending only what changed.

`disabled: true` is not a soft toggle: OpenCode 2 drops the entity entirely, so
no page exposes it as an on/off switch for agents. For MCP servers `disabled` is
the documented way to keep a server configured but inactive, and the page's
"Enable" checkbox writes it.

### Agent permissions

Settings lists hidden custom agents so their files remain editable, renameable, and deletable. Hidden built-in agents stay out of Settings, and all hidden agents stay out of the composer pickers. Duplicate and rename read the stored entry and preserve its `hidden` flag.

OpenCode 2 replaced the v1 `permission` map (`bash`/`task`/`list`/`lsp` keys with
allow/deny/ask per pattern) with an ORDERED list of `{ action, resource, effect }`
rules where the LAST match wins. The user does not think in ordered rules, so
the editor keeps the v1 mental model: one row per tool with inherit / allow /
ask / deny, an arrow showing what OpenCode will actually do for that tool right
now, and resource patterns under an expanded row. `agents/agentPermissionModel.ts`
translates this view to and from the rule list. Because order is part of the
policy, a save edits the stored list in place: changed effects replace their
rule where it stands, removed rows drop theirs, rules the view cannot show (an
`*` action with a resource pattern) pass through untouched, and only new rules
are inserted (agent wildcard first, a tool's wildcard before its patterns, a
pattern last), so decisions for tools the user did not touch never change. The
arrow is computed from OpenCode's built-in defaults
(`OPENCODE_DEFAULT_RULES`), the global `opencode.json` rules and the agent's
own wildcard, in that order. v1-only keys (`LEGACY_ACTIONS`) are neither shown
nor written back.

Below the built-in tools the editor lists one row per MCP server from the
Settings directory's config (`useMcpConfigStore`), keyed `<server>_*`, which
OpenCode matches against every tool the server exposes. Every configured server
is listed, not only the connected ones, so a rule can be set while a server is
disabled or failing; the live status from `useMcpStore` is shown beside the
name as a hint. A single MCP tool (`<server>_<tool>`) is still reachable
through the custom key input.

### The legacy-format note

Config reads report `legacy: true` when the entity's file still uses v1
spellings, and mutations answer with the `path` they wrote.
`shared/SettingsLegacyFormatNote.tsx` turns that into one quiet line at the top
of the page; the file is never moved, so the note has no action.

## The project page

`projects/ProjectSettingsPanel.tsx` is one project's page, shown by Settings →
Projects (`frame="page"`) and by the sidebar's project edit dialog
(`frame="dialog"`). The header holds the icon, colour and name: the icon opens a
popover with the colour (`shared/SettingsColorField.tsx`, the same field the
Agents page uses) and the symbol or image, and the name is edited in place. Below
it a tab strip splits the rest: General (new-chat defaults, the team file, trust,
plans folder), Actions (a card grid with an editor dialog), Worktrees (setup
commands and a link to the worktrees page) and Environment (not in VS Code).
Identity fields autosave through `useProjectIdentityAutoSave` after 450 ms.
Unmounting flushes the pending valid name. Writes run serially and retain the
latest committed edit during a write, including after unmount, with the captured
project and save callback. Pending snapshots are retained per project when the
mounted panel switches projects. A trailing edit reuses a completed icon operation.
Queues for the same project drain in order across editor remounts; other projects
do not wait for them. Queue tails are released after success or failure.
Empty names are never saved. Failed saves show an error toast.

### Why identity saves finish after unmount

Closing the editor accepts its edits, so canceling the debounce or a queued
follow-up would lose the last name typed. The mobile session sheet's separate
editor keeps its explicit Save action. VS Code rejects project metadata writes.

### Why identity queues share a project tail

An upload may finish after its editor closes. A reopened editor waits for that
editor's writes and trailing edit before saving, so an old snapshot cannot
overwrite the newer name. A per-mount saving flag cannot order these writes.

The Settings page also carries Close project in its header. It calls the same
`removeProject` as the sidebar's Close project, after a confirm dialog like the
other removals in Settings: a header button is easier to hit by accident than a
menu item. The edit dialog leaves it out, because the menu that opens the dialog
already holds Close project. VS Code shows no Projects page in Settings: its
projects are the workspace folders VS Code has open.

A project's setup lives in two files: the team's `.openchamber/project.json` in
the repo and the user's own config (`packages/web/server/lib/projects`). The page
shows one list per kind with every entry marked Team or Only me, and
`projects/projectSetupModel.ts` maps each edit onto the file the entry lives in:

- Team entries are edited in place, in the repo file. Nothing is copied into
  the personal file.
- A move between the files writes the destination first, then removes the
  entry from the source. A failed second write leaves the entry in both files;
  the server's merge shows it once. Every edit ends with a fresh read.
- Hiding a team action writes only the personal `hiddenSharedActionIds`.
- When the repo file exists but cannot be parsed, team writes are refused: a
  write replaces the file, so it would drop what could not be read.
- `projects/useProjectSetup.ts` reads with `fetchProjectSetup`, which throws.
  A failed read shows a retry, never an empty list that a later save would
  write back over the files.

The Settings page keeps its tab in `projects/projectSettingsTabs.ts` so a search
result can open the tab that holds its target (`prepareSettingsSearchTarget`).
The dialog keeps its own tab and starts on General every time.

Project colours are six-digit hex from the same presets as agents
(`lib/colorPresets.ts`), and an image icon takes the colour as its background
(`iconBackgroundForProjectColor`). Projects saved by older builds may carry a
theme key; `resolveProjectColor` in `lib/projectMeta.ts` still paints those,
and the colour field shows them as a selected swatch until the user picks again.

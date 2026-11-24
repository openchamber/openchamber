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

The skill page fills its create form from the draft once per draft and editor
(`skills/useDraftFill.ts`). Its details effect also runs on every skill list
refresh, so filling on each run reset a typed name, location and pending files
back to the draft's `new-skill` in User when a list read landed mid-form.

## Providers

Source-control cards whose descriptor carries `auth.login` show its service-owned sign-in hint when that instance has no account. With no PAT method, the instance renders its signed-in user without token, add-account or CLI-switch controls. The service owns sign-in outside the app. Opening that card rechecks status; a failed read keeps the auth store's prior account metadata and reports an error, while only a successful empty result removes the displayed login. The same card is used by the web, desktop and mobile Integrations pages.

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

On the Providers page that location is the project selected in Settings
(`useSettingsDirectory`), the same one `PUT /api/provider` writes a custom
provider's config for; elsewhere it is the chat's project. A provider kept in a
project's own config exists only in that project, so a key sent to the chat's
project answered "Integration not found" on every retry, and a list read there
showed the provider as not connected. The API key form, the OAuth and external
sign-ins and the custom provider form all take that project.

The Settings project may be one OpenCode has not opened yet. Since 2.4 such a
location answers `integration.list` with an empty list until its plugins load,
which showed "Connect provider" with only the custom provider card; the read
first waits for the location's plugins (`requireLocationPlugins`, up to 5 s)
and fails rather than returning an empty catalog.

After saving a custom provider, OpenCode accepts its key only once that location
has loaded the new provider, and a location nobody opened yet first waits for
its plugins to start: 5.6 s with a plugin that takes 5 s, past the old 3.75 s of
retries. `storeKeyAfterConfigWrite` in `providers/provider-key-writes.ts`
retries "Integration not found" for up to 30 s.

### Why retry the key and not wait for an event

The reload announces itself with `config.updated`, `integration.updated` and
`provider.updated`, but for every location at once and without naming the
provider, so a retry after each event is the same as retrying on a timer.

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

The custom-provider form recognizes the bundled OpenCode adapters for its three protocols, including `anthropic-compatible`. An edit keeps the stored bundled provider package while its protocol stays the same. Changing the protocol selects that protocol's default AI SDK package. The live catalog fills missing display fields but never supplies a package to persist; retained model packages belong to the server's merge.

The custom-provider form has a "Client certificate" section (certificate,
private key, passphrase) for gateways that require mutual TLS; "Find models"
presents the same certificate. It is on the custom form only: public APIs
never ask for a client certificate, so on built-in providers the fields would
be noise. Paths are saved as `{file:path}` references and only full paths are
accepted, because OpenCode resolves a relative path beside its config file
while discovery runs elsewhere, so the same path would read two different
files. The server keeps a certificate the form never read
(`packages/web/server/lib/opencode/DOCUMENTATION.md`, `providers.js`).

"Model defaults from" sets the provider's `canonical`: OpenCode then gives each
model whose ID that catalog provider also lists its limits, capabilities, costs
and reasoning levels, under whatever the model row sets itself. The choices are
every provider in the running OpenCode's integration list, connected or not,
without MCP sign-ins, web search and well-known logins, which are keyed by their
origin URL rather than a provider ID (`listCanonicalProviders`), passed in by the
Providers page, which has already read that list. OpenCode copies the source
provider's settings, headers and body into this one, so the server refuses a
source whose config entry sets any of them: a gateway's TLS certificate or
headers would otherwise go to this provider's endpoint. OpenCode copies from its own
provider registry, and the models.dev feed OpenChamber fetches is older and
misses providers OpenCode has, so that feed is not the source. The list has
a few hundred entries, so `CanonicalProviderPicker` is searchable and mounts rows
in steps as its end scrolls into view, with a sheet on the phone; None leads the
unfiltered list. A saved value the list lacks stays as an option, and a list that
fails to load shows a note and keeps the saved value. None sends null to clear
it; a stored entry the page could not read sends nothing, so the server keeps it.
OpenCode cannot unset `canonical` from a higher config layer, so None only removes
the edited layer's value: when a lower layer sets one (`inheritedCanonical` from
the source route, carried on the edit form's initial state), the field says which
provider still applies and in which file, ahead of the note about a list that failed.

Model rows render collapsed (name, id, limits, non-text inputs) so a provider
with dozens of models stays scannable; a row added by hand opens, and a row
with a validation error opens on submit. Capabilities are written to the
OpenCode config field by field, only those that are known (saved config,
discovery, or the user's edit, `capabilitiesKnown`); the rest are left out so a
save never replaces what OpenCode knows or inherits from the canonical provider
with a text-only default. Turning tools off writes `tools` alone. Discovery
fills each field from the provider first, then the matched catalog model. A field
neither reports stays unset. When editing a stored model, the form shows the
editable categories OpenCode resolved for each missing list. Unchecking one
inherited category keeps the other editable categories, and the list stays out
of the config until changed. Unknown entries survive in lists the model already
stores.

Custom-provider icons are OpenChamber profile preferences, keyed by provider
ID. They are not written into OpenCode config because OpenCode has no provider
icon field. "Default" stores nothing, so the provider's own logo (or the
generic fallback) still shows; `ProviderLogo` reads a chosen icon before trying
provider logos, so Settings, every model picker, the agent status chip, and
the message footer agree. The status chip and footer used to draw the logo
URL themselves, which skipped a chosen icon.

Any provider can also carry an uploaded logo image (`lib/customProviderLogos.ts`,
routes in `packages/web/server/lib/appearance/provider-logo-routes.js`).
`ProviderLogo` draws it first, then a chosen icon, an active extension's logo
(`contributes.providerLogos`, `lib/guests/provider-logos.ts`), the bundled logo,
the models.dev logo and the generic fallback. An upload or an extension's logo
keeps its colours, so it gets no `dark:invert`. While one loads the slot stays
empty at its size, except that a bundled logo stays on screen until an
extension's replaces it, and a failed load or draw falls through to the next
mark. VS Code keeps the guest catalog empty, so extension logos do not reach
it; the phone loads the catalog and draws them like the desktop. A custom provider sets the image in its edit form, beside the icon
picker, and Save applies what the user did there after the provider itself is
saved: a picked file is uploaded, Remove deletes the stored image, and an
untouched field keeps whatever is stored (a logo kept from when the provider
was last configured, or one another client just uploaded). A failed image write
is its own toast and does not reopen the form, whose next Save would store the
key again. Every other provider, and a custom one while
enterprise mode hides its form, sets it in a Logo section on its page, applied
at once. The chosen icon stays the fallback. VS Code runs no OpenChamber server,
so it neither offers the upload nor draws an uploaded logo; it shows the icon.

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

A provider OpenCode lists with no model at all keeps a card on the grid while
its integration holds a stored login (Copilot Free or Student): the login keeps
it off the connect page, so this card is the only way to sign out or switch
accounts. Its page is the usual provider page. Building such a provider from the
integration list was rejected, because OpenCode reports the provider itself and
the page then acts on OpenCode's record. A provider with no model and no stored
login, such as a config entry with an empty model list, has no account to
manage and stays off the grid.

The integration list is kept for the app session by
`lib/opencode/integration-catalog.ts`, so the page opens on it without a
loading state. The desktop/web/VS Code app reads it once at startup when the
browser is idle (`hooks/useIntegrationCatalogPrefetch.ts`); the phone layout
and relay connections skip that read, because relay bytes are paid, and read
it when Settings opens. The snapshot is only a starting point: the page reads
the list again on every visit and after every credential write, a read
started earlier never replaces a later one, and a snapshot from another
runtime is ignored.

### Why an edit keeps the stored provider adapter

Two adapters can implement the same API protocol and still load through different OpenCode paths. Replacing a bundled adapter with the form's AI SDK default during an unrelated edit changes the provider the user configured.

### Why runtime-only MCP rows wait for the config read

The MCP grid adds runtime-reported servers only after the directory's first
successful config read, matching configured servers by name so they never appear
twice. Showing runtime rows earlier would make configured servers flash as
read-only while their config loads; a failed initial read therefore keeps
runtime-only rows hidden until a read succeeds. These rows expose neither open
nor delete because no config entry backs them.

### MCP OAuth

A remote MCP server with OAuth enabled is registered by OpenCode as an
integration (`mcp_<hash>`, `metadata.source: "mcp"`, named after the server)
with `oauth` methods, so signing in is the same connect / status /
complete flow the Providers page runs. `mcp/McpOAuthSignIn.tsx` looks the
integration up by server name in the server's directory (the registration is
per Location) and mounts the shared `providers/ProviderOAuthMethods.tsx`
with that directory. It renders nothing until the integration shows up; a
caller with nothing else on screen passes `onUnavailable` to hear when the
lookup gives up. While the server reports `needs_auth`, the status card
shows its sign-in row, whose button reads "Sign in" so it is not confused with
the header's Connect, which only retries the connection. Once the credential
is stored, the page connects the server again, which is what moves it out of
`needs_auth` or `failed`. The Work status panel's MCP rows start the same
sign-in from their Sign in pill (`chat/work-status/DOCUMENTATION.md`).

A started sign-in keeps its row until it completes or fails, whatever the
status says (`onActiveChange`). A failed one stays only while the status
itself offers a sign-in, so its error never lingers on a connected server.
A sign-in from another machine writes the server's redirect first
(`packages/web/server/lib/opencode/mcp-oauth.js`), OpenCode reconnects the
server and reports `pending` for about a second, and
unmounting the row then cancelled the attempt: the first Connect did nothing
visible and only the second one opened the consent page. The Integrations
catalog keeps its sign-in row the same way.

The detail page looks up the integration for a failed server or a configured
remote server with `oauth !== false`. An absent `oauth` field is included:
OpenCode can discover OAuth without an explicit config entry. The lookup is
scoped to the selected server's directory and stops after 9 reads spaced
750 ms apart, including when a header/token-auth remote server has no OAuth
integration. Leaving the selection discards the result.

### Why opening an OAuth server can retry the connection

A separate OpenCode process can save an OAuth credential without updating
the running app's MCP status. The detail page retries once per selection
when an enabled remote reports `failed` or `needs_auth` and its matching
integration has a saved OAuth credential. It waits for the directory's
policy and checks live status again before reconnecting, so a cached
failure cannot restart a disconnected server. Switching the server off, or
any other change that makes it ineligible, while that status read is
pending cancels the attempt. Sign-in and manual retry
remain available if the connection still fails. The grid and other
directories do not retry.

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
a fresh `McpOAuthSignIn` with `autoStart`. A single method starts immediately
with its start button hidden; multiple methods keep their start controls so
the user can choose one. Test connection stays on the status line for
the other cause of `failed`, a server that was down; it retries with the
stored credential. A `failed` server without OAuth keeps Connect.

The Integrations catalog keeps its sign-in row and labels its button "Sign in
again" for `failed`, gated on the entry's `auth: 'oauth'` so a failed
token-based entry gets no sign-in block. It starts the sign-in by itself after
an install only for `needs_auth`: a first connect that failed for another
reason waits for a click.

### Why a connected OAuth server offers Authorize

A connected transport can expose tools that still require user consent. When
an OAuth integration exists, the detail header offers Authorize unless the
server is `needs_auth`, `blocked`, or already offers Sign in again. Authorize
mounts the status card and the same sign-in flow, even while connected;
completion reconnects the server. Only one sign-in panel is mounted if the
runtime changes to `needs_auth` during that flow.

The Integrations catalog also offers sign-in for connected entries with
`auth: 'oauth'`, labeled Authorize. Its view is mounted by `MainLayout` on web
and desktop, not by mobile or VS Code; those use the shared MCP Settings page.

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

OpenCode drops an MCP server or skill an `mcp.use` or `skill.use` deny names
(the server name or skill id, wildcards allowed) from its own lists, while the
MCP and Skills pages list what the config files and the disk hold.
`shared/useIntegrationPolicyBlock.ts` reads the statements from
`/api/config` (`readIntegrationPolicies`, decided like OpenCode: documents
reversed, last match wins) as `mcp:<name>` and `skill:<id>` resources. It also
takes the legacy `integration.use` statement with that prefix, which OpenCode
decodes into the new actions (since 2.2.3 `/api/config` serves only those), and
no other `integration.use`, which decides providers and accounts. The MCP page marks such a row "Blocked by
policy" and disables Connect and Test. Statements from a connected OpenCode
Console workspace are not in `/api/config`, so a server blocked only there is
not marked.

The Skills page reads the same statements from the skills store. One choice,
"Agents use it" (`skills/SkillUseField.tsx`), answers when agents get a skill:
Automatically, When called (the skill file's `disable-model-invocation` flag)
or Off. A skill's id is its `SKILL.md` folder name, not its display name. Off
writes an exact `skill.use` deny for the id where the skill lives (project config for a
project skill, global config otherwise) and leaves the file's flag alone;
leaving Off removes the exact deny, in either spelling (`skill.use` `<id>` or
the legacy `integration.use` `skill:<id>` an older OpenChamber wrote), from
every config file OpenCode reads for the directory, hand-written ones included. A skill an exact deny turns off
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

### Switching a plugin off

The Plugins list is the only place a plugin is switched on or off; the detail
page carries no control. The switch records the entry's `plugin:` resource in
OpenChamber's own store, and the config layer of the OpenCode OpenChamber starts
denies it there. The user's OpenCode config is not written, so the TUI and any
external server keep loading the plugin. A switched-off plugin reports what
OpenCode reports for any plugin that does not load: `Not loaded` on the card's
status pill. The pill keeps that wording, and the card never adds a "Disabled"
pill, because the switch beside it already says who turned it off.

The switch belongs to OpenChamber and covers every project of the OpenCode it
starts, while web and VS Code each keep their own. The page description says
that plainly, because a project-scope card suggests otherwise.

When a deny the user wrote themselves blocks the entry, the switch is disabled
and the detail page says under the status banner that a rule in the config
blocks it. The switch also stays disabled until the policy read succeeds, and
while it is failing, because a denied plugin and an enabled one look the same
before the config is read. A runtime OpenChamber did not start, or a store it
cannot read, reports `unavailable`: the switch stays disabled and says the switch
applies only to the OpenCode OpenChamber starts. VS Code renders the same switch
through its bridge; an external OpenCode server (`openchamber.apiUrl`) reports
every row as unavailable because the extension applies a switch only to the
OpenCode it starts.

An allow that OpenCode ranks above the denial makes the denial do nothing, so the
row shows the plugin as on, with the switch disabled and the reason beside it.
The server reports this as `overridden` from the config files it reads and
refuses the change. The grid also treats a stored off as overridden when a real
allow statement decides the plugin in `/api/config`, which is the only view of
system and Console policies. The absence of a deny proves nothing there: OpenCode
applies a rewritten managed file a moment after the write, and the
`OPENCODE_CONFIG_CONTENT` path only at the next launch.

The same delay keeps OpenChamber's own deny in `/api/config` after a plugin is
switched back on. A row switched on ignores an exact deny from that layer
(`opencode.managed.json`, or the pathless `OPENCODE_CONFIG_CONTENT` document),
so the page never tells the user to remove a rule that is ours. `config.updated`
and `plugin.updated` re-read the policies with the plugin list, which also
carries a switch flipped in another client.

Every disabled reason sits in a `SettingsInfoHint` beside the switch. A disabled
switch takes no tap and a native title never shows on touch.

### Why the switch layer is told apart by its document

The page could remember which plugins it just switched on, but that memory is
gone after a reload, and the `OPENCODE_CONFIG_CONTENT` deny lasts until the next
launch. The document a statement came from is in every read. The cost is that a
user's exact deny written into `OPENCODE_CONFIG_CONTENT` by hand reads as ours.

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
(`sourceControlProviderSettings.ts`). Gerrit signs in this way. A settings field
with the id `sshUrl` adds an instance-level SSH address row, saved through
`authSetSshUrl`; Gitea and Forgejo use it when `SSH_DOMAIN` differs from the
web address. Its published kind stays `instance-url` so older clients, which
ignore field ids they do not know, still draw the card.
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

A tracker an extension serves (`ext-<guest id>`, `lib/trackers/extension.ts`)
gets the same card, drawn by `integrations/GuestIntegrationsSection.tsx` under
"Extension accounts" beside the extension's notification channel, and
`IntegrationsPage.tsx` leaves it out of the built-in list. The card takes the
installed extension and its public tracker contribution (`extension` prop) and
reads the connect form from the auth status's `connect` block, never from the
manifest alone: a `user` instance asks for the server address until an account
lives on one (the first connect fixes it, a saved client alone does not, so a
mistyped address is corrected by typing again; `INSTANCE_MISMATCH` says a
second account must be on the same server); `token` auth shows the token form
with the scopes and "Create token" link the contribution names, and a username
where its scheme is `basic`; `oauth` auth shows the client id and secret form
with the redirect URL to copy until the server holds a client (`hasClient`),
then the browser sign-in. A tracker that takes both shows one form at a time
behind a "Browser sign-in / API token" chip group, with one Connect button.
While an account is connected the forms stay closed: Add account (where
`multipleAccounts` is set) opens them with a Cancel beside, or starts the
browser sign-in at once when that is the only step left. An extension's
account name is the person, so the card names it once. Each failure code the connect routes answer
(`TOKEN_REQUIRED`, `TOKEN_REFUSED`, `USERNAME_REQUIRED`, `USERNAME_INVALID`,
`INSTANCE_REQUIRED`, `INSTANCE_MISMATCH`, `UNSUPPORTED_INSTANCE`,
`CLIENT_MISSING`, `TRACKER_UNAVAILABLE`, `CONNECT_SUPERSEDED`) has its own
toast (`settings.integrations.tracker.toast.*`), so a refused token is said in
the tracker's name and never as "something went wrong"; a code the card does
not know (`ACCOUNTS_FULL`, a route's `INVALID`) shows the server's own
sentence. `trackerSettings.i18n.test.ts` holds every key these files name to
the English dictionary. A written-off account
arrives as `connected: false` with the account in `accounts` (`status:
'invalid'`): the card shows the attention line, the server it was on, the
connect form again and Disconnect, which removes it and frees the server. The
card's description names the extension; its title is the tracker's label. Hosted and Capacitor mobile show
no extension-account cards, as for channels: accounts are connected from web
or desktop, and the phone shows the tracker's items once they are.

### Why the extension tracker card sits under Extension accounts

The maintainer placed it beside the extension's notification channel rather
than among the built-in integrations: everything one extension owns is in one
place, and "Built-in integrations" stays what ships with OpenChamber. The card
itself is `TrackerSettings`, so mapping and session comments read the same.

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
A discovered package card is hidden when a declaration reaches the same
normalized target through the same switch resource (`policyResource`). A link
to that directory under another discovery path keeps its card even when the
real directory is declared, because its status and switch are its own. Two
discovery records that resolve to the same
directory (a link in `plugin/` to a package in `plugins/`) keep separate cards,
because OpenCode reports status and applies switches by discovery path, so one
card could not show or switch the other. Distinct declarations
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
| Provider | `package` with `aisdk:` for AI SDK adapters or a bare bundled OpenCode package, `settings.baseURL`, `headers`, `body`, models keyed by id with `modelID`, `capabilities`, `variants`, `cost.cache.read/write`, `disabled` |
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

## Appearance: color mode and theme list

`openchamber/ThemeAppearancePicker.tsx` owns the color mode cards and the
theme list; `openchamber/ThemeSchematic.tsx` draws the app on the cards.

- The schematic paints each part with the token the real component uses, with
  `cssGenerator`'s fallback chain and the opacity the component puts on top
  (message text at 90%, the selected session row at 70%, the effort label at
  75%, inline code and its background). A component that changes its token or
  opacity changes the schematic in the same change, or the cards stop showing
  what the theme looks like.
- Colours come from the `Theme` object, never from CSS variables: the cards
  show themes that are not active.
- The drawing follows the device: the phone layout under `isMobile`, the
  desktop layout elsewhere.
- Hovering a theme previews it on the cards and applies nothing. Touch has no
  hover, so a tap selects at once.
- The list keeps the chosen theme in view when it opens, when the tab changes
  and when its column count changes; a scroll that reaches its end goes on to
  the page.
- Imported themes show their delete action in the list at rest, so it is
  clear which themes are imported.

### Why one variant at a time and not both swatches per row

Each row once held a light and a dark swatch with four status dots each; at
thirty themes the list became a wall of dots. A Light / Dark switch shows one
column of choices, the cards above carry the preview, and each row needs only
the theme's canvas and accent.

### Why the list scrolls on its own

Imported themes add up quickly (the catalog, a themes folder). Without a cap
the page below the list moves further down with every import.

## About: the Android app's own update

On the Android app, About shows the app's version with a "Download app
{version}" button while the app's update check offers a newer APK, the same
link as the update toast (`openchamber/AboutSettings.tsx`,
`MobileAppUpdateToast.tsx`). The check button there checks the app build too.
Closing the toast skips that version for the toast only; the button stays
until the version is installed. iOS updates through the App Store and gets no
button. The server's update buttons on the same page name the server or the
desktop app they replace, never the phone app.

### Why the button lives in About and the toast is not shown again

A user who closed the toast already said no to it, so About is a quiet place
to find the update instead of a toast that comes back. A second update item
in the sessions footer was rejected: that item belongs to server updates in
the browser, and a second meaning there confuses both.

## Invariants

### Drafts, selection and policies

- Settings project selection leaves the chat, session list and file tree in place. Provider detail selection is page-local because the chat's provider selection records a manual model choice.
- An agent override without a stored mode keeps its resolved mode, so an unrelated edit cannot turn a built-in agent into a subagent. Duplicating carries the stored permission rules into creation.
- The last agent available to a chat cannot be switched off. Disabled custom agents remain manageable while OpenCode removes them from its runtime list.
- Policy re-reads keep the last successful rules for the same directory. Changing directories clears them before reading, so failure cannot apply another project's rules. Policy-changing controls wait for a successful read.
- A selected skill is discarded as missing only after its list loads, since VS Code can select it before that read. Renaming moves the directory in place to preserve supporting files.
- Snippet editors reset for a different snippet or draft, including a new draft reusing a discarded draft's name. Refreshing the same file preserves edits; an async create selects its result only while that draft remains selected.
- Routing saves serialize against the runtime where the edit starts. Runtime switches drop pending saves; responses replace only idle drafts, and a response that merely trims the current draft leaves typed whitespace intact.
- Routing prefills its initial fallback only from a concrete session-default model. Auto cannot prefill the fallback that resolves Auto.
- Existing `AGENTS.md` content, including an empty file, is authoritative. The stored behavior prompt is a fallback only for a missing file or failed read. Window focus re-reads the file, preserves dirty drafts and carries the exact read content into writes so external edits can be rejected.

### Provider configuration and authentication

- Custom-provider edits start from stored config. Resolved environment variables, headers, generated reasoning levels and certificate PEM text cannot become explicit configuration through an unrelated edit.
- Provider creation writes the user layer; editing writes the winning existing layer in custom, project, user precedence. Catalog-only providers cannot acquire config editing from matching package or URL metadata alone.
- Custom-provider config precedes key storage. OpenCode's watcher registers the integration asynchronously, so key storage briefly retries only "Integration not found".
- Clearing saved reasoning levels sends an empty list; new rows without levels omit the key. Protocol changes rebuild levels because request overlays use protocol-specific spellings.
- Unchecking an image model writes `chat` explicitly because the server merges over the saved `image` type.
- Certificate and private key are submitted together. Passphrases retain exact bytes, and an unknown stored certificate stays untouched until the user edits its fields.
- The custom-provider form hydrates once per provider ID, so parent refreshes preserve in-progress edits.
- OAuth status, completion and cancellation keep the location client that starts the attempt, even when the app changes project.
- OAuth runs one method at a time and cancels abandoned attempts, including starts that complete after unmount. Auto-start runs once per mount so renders cannot restart a cancelled sign-in.
- A pasted redirect URL settles an auto attempt through its existing status poll. A rejected URL leaves the attempt waiting for another paste.
- Claude Code's CLI opens its own sign-in browser. Its integration URL is informational, so opening it again adds an unrelated documentation tab.
- Integration forms evaluate conditions in declaration order against active preceding answers. Hidden answers cannot reveal later fields, and hidden fields and blank optional fields stay out of the payload. Methods without a form receive no answer object.
- Integration defaults fill fields the user has not edited after catalog refreshes. The custom-value sentinel uses a NUL prefix to stay distinct from integration options.
- Successful credential writes may temporarily mark a provider connected until authoritative integrations arrive. Account switching waits for the server because it owns the active credential.
- A provider routes through one integration. Credentials under another integration stay removable but cannot be selected for that provider; environment-backed credentials cannot be removed here.
- A single usable account has no Use action. Its Active mark still distinguishes it from other unusable stored accounts.
- Automatic account switching is opt-in per provider because another account can intentionally belong to work. Updates start from the latest stored list to preserve other providers' choices.
- Provider-policy warnings require known config and Console status. Console workspace policies are absent from config reads, so a connected Console prevents a definite claim that policy is missing.
- Disabled providers remain reachable because OpenCode omits them from its live list. Source-read failure removes only the Project chip, and uncertain credentials never hide a configured custom provider's model editor.

### MCP and source control

- MCP saves carry OAuth fields without editors unchanged because the store rebuilds the entire block. Snippet import accepts v1 and v2 and emits v2; a v1 timeout becomes execution timeout, while startup applies only to local servers.
- Command import uses paste events because direct clipboard reads can be denied. Only a whole-field single-command paste is split into arguments; partial pastes remain ordinary editing.
- MCP integration matching uses source and server name because OpenCode owns its registration hash. Lookup retries cover registration completing after the first list read.
- Runtime MCP status outranks store diagnostics. Policy-blocked servers use the page's blocked state because earlier runtime status is stale.
- Web-search choice is locked when project configuration overrides the file Settings writes, since a write would immediately appear to revert. Configured providers no longer offered remain named so a missing plugin or typo stays visible.
- Failed account-list reads preserve an identity's stored account. Only explicit selection changes it; public author writes leave private migration fields to the server.
- Managed SSH references stay opaque and display only safe labels. Mounting preserves the saved key; a runtime switch clears a reference belonging to another machine.
- SSH key fields are omitted for other transports. Transport authentication and commit signing remain independent.
- Re-authentication adds a credential because existing bindings must keep their original credential. Short handles appear only when otherwise identical rows need distinguishing.
- Stale-address and questionable-account grants remain unresolved in the endpoint editor. The System identity uses effective bindings and reaches every remote through machine Git.
- Submodule and LFS grants require an identity with an account and transport, excluding legacy identities without them. The repository identity is proposed only for its own instance, including a separate SSH host; another host requires an explicit choice.
- Instance capabilities reload when descriptor identity changes. Account summaries prefer the acting account because the first account is arbitrary across instances.
- CLI accounts apply only after an explicit switch. A saved CLI switch with no available account row remains reachable separately.
- Tracker mappings reload on account change because containers belong to the account. Browser sign-in waits end on leaving the card, so a first successful status read cannot cancel a running wait.
- Tracker session comments start off because they publish to other people. The server applies the switch to completion and failure comments too.
- Extension-channel read failure preserves the last list. Approval and pause changes re-read it because they change which channels exist.

### Desktop, models and status

- Either desktop Save + restart action writes every pending restart draft together. Invalid network drafts block restart so another section's restart cannot discard them.
- The network password is write-only and omitted when unchanged. LAN access requires a valid password draft, and enterprise restrictions remain server-enforced.
- Global Mini Chat and Quake combos participate in in-app conflict checks. Replacement releases an in-app binding only after the global combo is stored, preserving the working action on failure.
- Releasing a global combo stores it as unassigned because clearing the setting restores its default and takes the combo back.
- Shortcut recording suspends the registry and cancels armed sequences because window capture dispatches before field handlers. Recorded Escape stays in the recorder rather than closing Settings.
- Global shortcuts allow one chord with all 4 modifiers and a key. In-app shortcuts allow sequences with a smaller simultaneous-key limit. macOS Control and Command remain distinct; `mod` means Command there and Control elsewhere, while non-macOS Meta is `super`.
- The reset dialog stays mounted when its trigger disappears after reset so it can finish closing.
- Binary selection owns OpenCode restart because other configuration is watched live. Process environment changes reach OpenCode on restart and Git, terminals and project actions on their next run.
- Project environment never reaches shared managed OpenCode because it serves every project. A changed environment command runs immediately to expose its result.
- Passkeys are web-only because the other shells do not display the login screen. Capacitor uses native notification permission, suppresses focused notifications and uses generic notification text.
- Classification, goal automation and per-session warming require an OpenChamber server. VS Code offers OpenCode's global warming and renders existing goal state.
- Unavailable classification shows the server's effective safety-mode and goal-checker fallback without erasing the saved choice. Administrator-pinned endpoints remain read-only; empty custom-endpoint keys keep the saved key, including draft tests.
- Server-persisted language survives lost browser storage and reaches other clients. Enterprise font previews show the effective system font where a stored font needs a CDN.
- Session defaults preserve a chat's manual model and an explicitly selected agent's pinned model. Offered choices require verified credentials and the live catalog.
- Thinking levels belong to their model and reset on model change. Clearing the goal-model picker explicitly returns to the small model.
- Walkthrough models exclude only an explicit lack of structured output; missing metadata keeps a model eligible because the catalog omits capabilities for working models.
- A memory-organizing model missing from the catalog stays named. A removed browser-provider extension shows the built-in provider because the server already falls back to it.
- Memory refresh follows the persisted setting write; refreshing on the optimistic toggle can read the earlier disabled state and leave the tab hidden.
- Compaction rollback restores only fields untouched by newer writes. Hand-written values outside the offered steps stay selectable so the saved choice remains visible.
- Retention fields remain editable with automatic cleanup off because manual cleanup uses them too. The In work block never includes archived sessions.
- Message-search status reads continue beyond an initially settled answer after a switch because the debounced save can start indexing later.
- Voice keys stay on the server. Dictation cleanup starts off because it sends text to the small-model provider, and without that model the server retains the transcription. Voice pickers share install state and list installed models plus the default; dictation displays the server's choice when no saved model is available.
- A custom speech server that lists its voices gets a voice dropdown ending in Custom…; a server without a list keeps the text field. The saved voice changes only when the user picks or types one, so a voice missing from the list shows as Custom… with its value. Typing in the field keeps it in Custom mode until a listed voice is picked, and a list that arrives while the cursor is in the field keeps the field, its text and the focus; the dropdown appears beside it. A failed read names its reason in the line reserved under the field, and a Retry that clears the line hands focus to the voice control. The list is read for a finished address only (on open, when the URL field loses focus, on Enter); whether the stored key goes along is the server's decision (`packages/web/server/lib/tts/DOCUMENTATION.md`). A list longer than 100 voices uses `LongVoicePicker`, with search and rows mounted as it scrolls; its Custom… item stays in view.
- Usage panels show only their provider's error, so Console budgets survive a failed Go usage read. Balance-only windows omit percentage bars and used captions because they report no usage share.
- Settings names the Go credential next to its meters and the Console workspace next to its budgets. The two reads can use different accounts when the Go reader falls back to a key.
- About separates app, connected-server and OpenCode updates. A latest-version toast waits for every relevant check; failed checks keep prior status, and authoritative running versions replace temporary installed-but-not-running state.
- About offers upgrade commands only for package-manager installations. Update notes cover the offered release range; a stable release offered to Canary has only that release's notes.

### Extensions, plugins and catalogs

- Only local desktop extension installation hands the server a path. Web and remote desktop upload archives; file drops suppress browser navigation.
- Extension updates serialize so failures leave completed updates intact. A runtime switch ends the batch, and increased capability requests wait for review.
- Declining a new extension removes it; existing extensions may stay pending. Changed credential grants require approval again, and approval cannot override enterprise refusal.
- Plugin pending state is per row so one response cannot enable another writing row. Control entries cannot acquire package options or file actions; discovered package directories remain OpenCode-owned.
- Exact plugin pins update through npm; reinstallable names, ranges, tags and Git targets update through OpenCode. Runtime matching keeps package strings verbatim and resolves relative local paths against their declaring config file.
- A failed plugin revision outranks a still-active older revision so its failed update remains visible.
- Failed catalog-list reads disable mutations because an assumed empty list would overwrite other sources. Only identities with their own credential change cloning; System transport uses ordinary Git setup.
- Catalog skill paths already include their source subpath; prepending it again breaks repository links.

### Isolated spaces and remote connections

- The host owns the isolated-space switch and idle timeout. Timeout fields commit whole edits because each digit would otherwise broadcast an intermediate value to running spaces.
- Switching isolated spaces off retains files and asks first when spaces run or their count is unknown. Unregistered-project spaces stay reachable; failed reads cannot claim there are none.
- Unreachable places retain last-seen spaces without reporting zero. Changing the configured machine re-reads places because routing changes with it.
- Place disk polling runs around observed image downloads and stops on read failure. Bounded settling reads after completion let Docker's disk inventory learn the image size.
- Place cleanup is unavailable during image download because the host refuses it. Failed download-status reads stop polling and expose the failure rather than leaving a spinner running.
- Opening SSH switches the runtime to the forwarded URL. Navigating to the remote UI changes the trusted origin and prevents the desktop shell from reconnecting a dropped tunnel.
- SSH confirmation stays in the page's dialog focus tree because native confirmation can leave Electron on Windows unable to accept text. Leaving the form abandons the operation, including unresolved password persistence.
- Pairing uses identical device metadata across transports and deduplicates re-pairing by install ID. Direct candidates precede relay in payload order to avoid relay cost where direct access works.
- Relay redemption uses a temporary tunnel and never persists its admission grant. Saved hosts keep every offered transport and the shared token so home-network access can fall back to relay elsewhere.
- Re-importing pairing updates the matching server record. Renaming preserves relay credentials and learned addresses; relay-only transport changes require fresh pairing.
- Pairing auto-close requires successful reads that first see the session and later see it disappear. Failure retains the list; only a matching redeemed client produces a success notification.
- Device labels name this server's device-list entry; exported connection labels name the issuing server. Dense pairing payloads use high-resolution QR output with low error correction.
- LAN availability comes from the server bind address, with browser-origin guessing only after read failure. Publishing a remote server to its network requires its UI password.
- Only reconnecting SSH status runs the stuck-state clock. Saved-host probes run per list identity, hidden pages pause polling and relay-conflict failures retain the last state.
- A running tunnel's port belongs to its identity, so changing the configured port requires a different tunnel even if its mode is unchanged.

### Shared controls and project editing

- Card menus and switches are siblings of the navigation button to avoid nested interactive controls. Checkbox descriptions with links remain outside the clickable row.
- Header actions wrap before starving the title. The first rendered section has no leading gap or rule even when earlier platform-specific sections render nothing.
- Select caps use the scaled control font in `ch` because typography scaling leaves root `rem` unchanged. Number steppers also reserve button space and keep intrinsic width so increment buttons cannot stretch unevenly.
- Full-width field rows stay in full-width sections; half-width columns use stacked labels because a fixed label column overflows them.
- Disabled-row explanations stay readable because they say how to enable the option. Required warnings stay visible because touch users cannot be expected to long-press.
- Info hints and disabled-option tooltips own trigger click handling so Base UI's trigger-press close cannot undo a touch opening. Disabled buttons use wrapper triggers, and popup links retain their clicks.
- Dragging closes row tooltips because they can consume Escape needed to cancel keyboard dragging. Mobile project selection uses the bottom sheet because select popups cannot scroll long lists within the viewport.
- Theme preview controls use divs because the app's button SVG rule clears shape fills. Light-theme selected options use canvas color because elevated colors are darker there.
- Theme list padding and scroll padding match edge fades so focused edge rows remain readable. Keyboard navigation has one tab stop and transfers focus after deletion; a missing stored theme uses the app's first-theme fallback.
- Theme search ranks substring matches by prefix and word prefix because fuzzy matching returns unrelated names. Theme import reserves a partial-result line to keep its footer in place.
- Project icon popups portal into Settings dialogs to remain inside their focus trap and stacking context. System file pickers sit outside popups because opening them closes the popup.
- Project identity refresh follows the store only while clean. Selecting a symbol removes an image because the sidebar gives images precedence.
- Custom worktree creation commands stay personal because they name machine-local tools. Worktree mutation lists are invalidation signals; the panel re-reads its authoritative list from the server.
- New-setting badges use the Settings device context and stay hidden outside it so navigation cannot announce unavailable controls.
- Disabled subcontrols retain layout space so toggling them cannot resize dialogs or move neighboring rows.
- Project setup's personal-only mode omits team setup commands but retains team teardown commands. Moving notes and todos between local and repository storage delegates entry migration to the server.
- Model-picker Auto appears only for selections processed by routing. Routing categories and fallback selections require concrete models, and compact model triggers retain an accessible name when their visible name is hidden.
- The phone's workspace tabs are device-local and keep at least one visible tab. A Settings page's plain title remains a screen-reader and focus target when the phone header already names it.
- The floating Settings close button reserves clearance in the content scrollbar so scrollbar interaction remains reachable.

### Why Jev has a dedicated page and not an OpenCode provider editor

Jev answers OpenChamber classification requests and the server owns its selection and keys. A dedicated Gemini key enables Jev without enabling Gemini chat models.

### Why settings links use text color and not the accent

Underlining identifies links while the accent remains reserved for primary actions. Hover and focus strengthen the underline.

### Why a custom voice is a Custom… item and not a combobox

No combobox primitive exists. A Custom… item keeps blends like `af_bella+af_sky`, voice profiles and servers without a list working, beside a plain dropdown for everyone else.

### Why the voice-list line wraps instead of truncating

The line has a reserved one-line slot, so the common messages move nothing below it. It wraps because a phone has no tooltips and two of its messages are the fix itself (an environment variable, the address form); a longer message appears only after the user typed that address, below the field they typed into.

# Chat composition

## Ownership

This module connects chat columns, message rows, composer controls, discovery
pickers and session feedback. The nested column, composer, message, Markdown
and timeline modules own their respective contracts. Sync owns authoritative
session records and execution state; runtime adapters own filesystem and
OpenCode access.

## Invariants

- A column's composer and transcript follow the same shown session. Pinned
  columns keep navigation, selection, draft input and focus local; app-wide
  pending input belongs to the main chat unless explicitly addressed.
- A nested BTW transcript can read another directory's store while its actions
  still belong to the containing column. Store directory and action target
  remain separate concepts.
- A pinned column follows a moved session's authoritative directory. Restoring
  a pin cannot admit an unknown folder; live session admission owns that step.
- Deferred selection takes an empty origin and a same-session directory change
  immediately. Deferring either can remount the composer or read a moved session
  back into the store it left.
- Review-session metadata determines independence even when an older record
  retains a parent ID. Only its presentation can make a review read-only.
- Chat text-size variables stay scoped to the column so interface text outside
  the chat retains its configured size.
- Message search mounts under a session key so an old hit cannot focus a
  message under a new session ID. Search reads the server index, including
  unloaded history, and navigation uses message links to load the target.
- Hidden reasoning is excluded from search. A reasoning target opens both its
  activity and reasoning folds before navigation; only the latest target stays
  active, and non-reasoning navigation clears it.
- Search highlights leave Markdown unchanged and repaint remounted rows.
  Matches stay within text nodes, and lowercasing that changes string length
  cannot supply source offsets.
- Timeline actions apply only to user prompts. Injected context folds back onto
  its prompt so a quote-only prompt has a searchable title; background reports
  remain independent entries.
- The timeline dialog keeps loaded prompts from being trimmed while open. Its
  initial selection agrees with its opening scroll so a second scroll cannot
  jump back to the first row.
- Dialog shells keep queries across opens, but message and goal subscriptions
  mount only while their bodies are visible or closing. Closed dialogs add no
  work to streaming session updates.
- Non-active message rows avoid context-store updates. Extension actions read
  their record at click time so part updates do not rebuild action lists.
- Long-answer slices share their message identity for search and quoting while
  only the first slice owns the navigation anchor. Turn-level copy includes the
  earlier assistant steps before the final answer.
- A recovered assistant step can carry a connection error while the turn
  continues in another step. That superseded step error cannot label the whole
  turn as failed.
- An error boundary recovers only a fallback that already exists when the
  session changes, preserving an error first caught in the new session.
- Session error feedback waits for a successful status snapshot before treating
  an absent status as idle. Synthetic and switch records cannot hide an
  unanswered conversation prompt, and an inline assistant error is not repeated.
- No-reply verification rereads the session before showing its notice and keeps
  a bounded schedule of later reads. A failed read still settles verification;
  cancellation prevents an old prompt's result from affecting the current one.
- Assistant completion stamps finish turns; other roles use creation stamps.
  Applying assistant completion semantics to a prompt can make a fresh send
  appear unanswered since the epoch.
- Long errors mount only their preview until expanded. Expansion belongs to the
  specific error, and its full text has `aria-live="off"` to avoid announcing
  an entire provider response inside a status region.
- Goal creation requires an available progress-checking model and the web
  server's loop; managing an existing goal remains available without that model.
  VS Code does not offer arming because its extension cannot drive the loop.
- Goal dialog updates seed only untouched input, including an asynchronously
  loaded file objective. Completed goals remain read-only because saving over
  the outcome would create another active goal.
- Goal usage stays absent until accounting supplies a number or a budget makes
  it useful. The goal's audit can continue after the agent becomes idle.
- Review offers inspect the whole working tree because sessions sharing a
  directory cannot separate their changes. A finished or disputed review stays
  visible until dismissed so its outcome remains available.
- Pointer interaction with mobile agent, model, effort and goal-arm controls
  preserves editor focus. A blur can close the keyboard and move the tapped
  control before its click; opening a management sheet intentionally releases
  that focus, and the opening finger cannot select a sheet item.
- Model and agent catalogs belong to the directory the composer sends to.
  Controlled selections never restore from the main chat's catalog or history.
  Loading catalogs establish neither absence nor invalid effort.
- Display-only model and agent metadata can come from another known catalog
  while the active catalog loads. Validation and sends still use the target
  directory's catalog.
- The model and effort shown describe the next send. Effort has 3 distinct
  states: a named level, `null` for explicit Default, and `undefined` for
  inheritance. OpenCode's stored `"default"` also means explicit Default.
- Session records determine current model and agent; assistant history is a
  fallback only after the transcript has loaded and the record lacks a choice.
  Message labels prefer the message's agent and variant, with the first
  assistant step supplying a turn-wide variant fallback.
- Unreconciled session-record switches supersede saved selections. An unsent
  local agent pick survives an unchanged record until its send; an agent-only
  record switch cannot restore a model previously used with that agent.
- Persisted selections hydrate once. History reloads cannot replace a newer
  saved pick or turn inherited effort into an explicit choice. A record that
  supplies no effort leaves the saved choice intact.
- Saved Auto remains authoritative over the routed model in history because the
  server replaces the sentinel before storing a message. Restore waits for
  routing availability, and live router model changes leave Auto displayed.
- The main chat reconciles its app-wide send agent with the session's displayed
  agent. A controlled chat changes only its own selection, carrying its current
  effort when a newly chosen agent has no saved level for that model.
- Variant-array identity follows content so unrelated store updates cannot
  rerun effort restoration and flash inherited effort over a local pick.
  Missing discovery data preserves a choice; a genuinely unsupported level
  clears to inheritance, without creating an explicit Default.
- Only user model picks write the fallback model for new sessions. Restores
  cannot change that default, and BTW effort changes cannot change the main
  chat's remembered level.
- Mobile sheets and composer layout use the same UI-store mobile flag, including
  Capacitor tablets. VS Code compact controls keep desktop sizing and menus.
  Auto hides agent controls and also disables agent-changing shortcuts.
- Autocomplete registries update independently of query ranking. Commands use
  case-sensitive built-in precedence over plugin commands; skills match exact
  registry casing because their names reach the model.
- Mention searches keep results paired with their query. Session ranking uses a
  snapshot per query so live session updates cannot move the keyboard target.
  Extension and extended filesystem searches settle independently, and one
  failed search kind cannot discard another kind's hits.
- While a new query searches, settled rows retain popup geometry and selection.
  A new answer selects its best match before paint; additions to the same
  query preserve the selected row. Closing or replacing a query cancels its
  filesystem walk.
- Spaces continue mentions only for session titles. Session matches require
  literal title matches to avoid near-matches across many chats; the current
  session and subagent runs are excluded. File search sends the longest token
  and filters remaining tokens locally because its upstream query is single-term.
- File paths retain left-to-right layout in every locale because their marquee
  and fade geometry use that direction. Extension results follow file results
  so an existing Enter choice remains stable.
- Autocomplete height clamps apply only to fixed-bottom popups. Caret placement
  already supplies bounds, and downward-growing lists would feed their changed
  bottom back into measurement. Bounds include visual-viewport panning, with a
  minimum visible height during transient keyboard geometry.
- Snippet creation always opens its dialog before writing. An unmatched token
  such as `#42` cannot save a snippet through an accidental Enter.
- Starter fit sums fractional rendered widths without rounding individual chips.
  Its available width comes from the container independently of visible chips,
  and changes in fonts or column width trigger remeasurement.
- Hidden starter chips stay mounted for measurement but cannot be drag sources
  or targets because their boxes overlap the visible row. Drag translation
  preserves item size, groups share a context for the mobile trash target, and
  droppable measurement includes the target mounted at drag start.
- Shared project starters stay first and leave only through the repository file;
  personal edits write only personal starters. Sharing writes the repository
  copy before removing the personal copy, and removal markers keep built-ins
  from reappearing during bootstrap.
- Starter-management buttons stop Enter and Space propagation while preserving
  native activation, so managing a starter cannot run its enclosing row.
- Draft headings remain shared for one visit to the new-session screen, including
  changes of draft ID. Their index is reactive state, and project-name
  substitution treats replacement metacharacters literally.
- File reference ranges parse before single-line suffixes so `:10-20` cannot
  truncate to `:10`. Fenced-output matching requires an extension-bearing path
  and does not recognize backslash-separated Windows paths; inline-code
  resolution reads the complete literal path and has no such limitation.
- Stat requests carry the session's directory header because the server's last
  browsed directory can differ. Directory-qualified cache keys use NUL to avoid
  path collisions; ambiguous basename matches remain plain text.
- Saved image citations use plain Markdown links because a leading `!` enters
  shell mode. Windows paths use forward slashes, and spaces and parentheses
  require angle-bracket destinations. Unconvertible HEIC stays a linked file
  because providers reject it as an image attachment.
- Modified web-session clicks retain browser navigation. Commit existence is
  checked asynchronously only on desktop, whose bridge can open a fallback
  after the click gesture; a web popup after that read can be blocked.
- Permission shortcuts run in capture so the composer cannot consume Alt+Enter
  as a newline. The newest pending request owns its column's keys, and Always
  requires save patterns because an unsavable rule behaves like Allow once.
- Form resets compare content, not object identity, so pending-list rebuilds
  cannot discard answers. A fading-out dock retains its mounted runtime key
  and cannot save old answers under a newly selected runtime.
- Form exports omit local routing IDs, while a recovered question's new-turn
  context includes only answered fields and preserves their typed values.
- Status-label width uses horizontal clipping so subpixel overflow cannot create
  a scrollbar and vertical clipping cannot cut descenders. Working-status
  presentation stays separate from the composer's own status bar.

## Decisions

### Why composer highlighting uses positional emphasis and not every delimiter

Emphasis requires word boundaries so ordinary arithmetic and identifiers stay
literal. Weight and slant add to the winning construct's color; decoration
classes preserve font family and size so editor geometry remains coherent.

### Why highlight resolution sweeps boundaries and not every range per segment

Only active ranges compete at each boundary, with equal priorities preserving
input order. Adjacent identical segments merge once for all renderers to reduce
overlay spans and editor decorations without changing source offsets.

### Why fenced highlighting bounds synchronous parsing and not all languages

Only synchronously available language parsers color a bounded block; large,
unknown or failed parses retain the neutral base so typing cannot wait on a
language load or an unbounded parse. Container tags stay out of token colors
because they would tint ordinary prose across their entire subtree.

### Why diff highlighting retains line geometry and not an initial plain paint

The worker tokenizes the flattened diff once, and unchanged lines retain their
ready colors while updates finish. Cold lines reserve their layout until ready,
avoiding a visible plain-to-colored flash unless highlighting fails.

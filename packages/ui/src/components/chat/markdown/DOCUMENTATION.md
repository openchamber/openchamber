# Shared Markdown rendering

## Ownership

Streamdown and React own the Markdown tree. `MarkdownRendererImpl` supplies
the component map, media and presentation context. Code, Mermaid, links,
tables and media keep their application-owned behavior in this directory.
Message synchronization and model transport stay outside the renderer.

OpenUI is an explicitly allowed assistant-text code renderer. The same
official OpenUI runtime also renders the managed waiting tool through its
controlled tool mount. `chat/openui/` owns the catalog and component adapters;
the HTML frame owns sandboxed documents and the server owns active waits.

## Invariants

- Ordinary callers, reasoning, user text, documents and exports do not grant
  permission to execute OpenUI. A visual variant or HTML language class grants
  no permission.
- A real `openui-lang` fence with no metadata can show an inert native preview
  while its part streams. `openui-lang literal` and unknown metadata stay source.
- Interaction requires complete-program inspection and a real closing marker
  whose line has ended in canonical text, or a finalized part. A marker at an
  active EOF is provisional. A stopped, unclosed fence stays source-only.
- Micromark tokens from the existing remark parser prove raw closure.
  Streamdown's incomplete flag, remend repairs and a stopped turn do not.
- Display-node offsets are relative to their actual Streamdown block. The
  public splitter remains unchanged. Its processed-node receipt is separate
  from the original displayed fences, whose parser-extracted code is the
  Renderer input. Matching requires the unchanged processed prefix and the
  original occurrence; a shortened processed EOF must end inside the original
  fence span. Interior repairs and shifted positions remain source-only.
- Display receipts survive canonical-only updates and permission toggles.
  Admission uses current permissions. Legal growth of a provisional closing
  line keeps the preview mounted; its end offset is not its identity.
- Assistant reveal passes its parsed display fences to the Markdown owner.
  Equal canonical/display text shares those fences. The processed receipt stays
  tied to displayed text even if a fresh analysis object arrives; Streamdown may
  skip its splitter on that render. Changed canonical and repaired text still
  receive independent source checks.
- Fence collection and display reveal use normalized LF/BOM-free coordinates.
  An offset from normalized text never slices unnormalized text.
- Canonical text remains separate from throttled display text. Replacement or
  removal revokes old actions before a later displayed update can catch up.
- Identical code at different canonical positions has separate identity.
  Reference-definition regrouping cannot merge its state with another fence.
- Ordinary appends preserve the Renderer under stable Markdown parents.
  Streamdown regrouping can remount it. The resolved OpenUI module is reused
  synchronously and existing session retention restores supported fields;
  focus, component-local navigation and iframe state are not retained.
- Copy and image rendering remain source-only. A detached live clone replaces
  generated controls with DSL source and excludes unsubmitted fields.
- The OpenUI runtime loads only after an authorized fence or tool actually
  needs it. Ordinary Markdown retains its existing highlight and media paths.
- Native drafts belong to each retained timeline's session owner, above
  virtual rows and folds and inside its session-specific KeepAlive subtree.
  An Activity hide disconnects observation and retires the owner; showing it
  again replaces a disposed owner before rendering its descendants, so the
  first restored commit keeps the UI instead of briefly showing source.
  Layout setup reconnects source observation before paint.
  The program also refreshes its interaction gate in layout setup, because
  retained controls can render while their previous mount is still inactive.
  Only directory-store reconciliation changes an
  observed source lineage; a stale render cannot rewind it.
- Field snapshots are opaque vendor values, cloned without changing Dates.
  Retention is limited to 100 idle entries, 64 KiB per draft and a 1 MiB
  snapshot/source budget. A draft that cannot be retained keeps working while
  mounted and shows a warning instead of silently restoring an older value.
- Local actions use the official store. An explicit submission is either one
  normal user turn or the answer to its original active tool call, never both.
- The Markdown and tool mounts each supply the submission function and repeat
  policy explicitly. The shared program owns pending/error presentation and
  source admission; it does not infer a destination from an optional callback.
- Draft handles read snapshots during render. Layout effects retain committed
  consumers and release them synchronously on cleanup, including StrictMode
  replay. Uncommitted handles cannot save data or consume the draft budget.
  Both entries use `useOpenUIDraft`; key construction, source tracking, snapshot
  callbacks and retention warnings belong to the session module.
- Embedded component text shares this renderer while inheriting its parent's
  type. It uses validated external screen links, renders code as source, and
  cannot activate file references, media or nested OpenUI. It does not reuse
  the copy/export presentation mode.
- Native OpenUI images reuse the assistant media owner, source budget, loading
  failures and message gallery. Their optional image presentation sets ratio
  and crop without changing source resolution or permission checks.
- Media uses existing stat/raw file access; VS Code remains workspace-only.
  Failed files are independent. Native media uses authenticated URLs; HtmlView
  and VS Code validate bytes before embedding. HtmlView owns its page budget.
  Preparation is cached by runtime, session, message, directory and sources.
  Gallery opens and retries refresh it. Outside results expire after 10 minutes,
  partial results after 30 seconds; aborted or superseded reads cannot replace
  fresh results.

## Decisions

### Why code delegation stays inside Streamdown

The existing parser owns ordering, nested Markdown, disclosures and references.
A separate assistant-text splitter would duplicate those rules and give screen
and export different trees. `MarkdownCode` delegates only the authorized
language through Streamdown's public renderer extension.

### Why canonical source accompanies display text

Throttling and incomplete-Markdown repair can produce a useful preview without
an authored closing fence. Execution checks need the original part while prose
keeps its existing reveal behavior.

### Why display receipts outlive authority updates

Streamdown can skip its splitter when displayed text is unchanged, while a
context consumer still updates. Keeping the existing receipt prevents normal
canonical deltas or a permission re-enable from sending an admitted UI back to
source. The splitter replaces the receipt when its processed input changes;
current canonical checks independently revoke replaced or deleted sources.

### Why a closing line must finish before interaction

The Markdown parser accepts a closing marker at EOF, but the next streamed
character can invalidate that line. Waiting for its newline or authoritative
part finalization prevents scripts, submissions and timers from starting on
provisional syntax. Native preview continues through the official Renderer.

### Why copy uses source

Generated forms contain values the user has not submitted. Message-level copy
and image export preserve the authored program without turning a screen clone
into an implicit data submission. Native copying inside a field stays native.

### Why drafts observe the existing directory store

Virtual rows cannot see replacements that happen while they are unmounted.
The session owner observes only tracked parts through the existing message
subscription. It does not create another message cache or synchronization
protocol, and a runtime switch or observation gap invalidates the old lineage.

### Why Activity recovery precedes paint

Activity retains the component tree but disconnects its effects. The source
owner is disposed during that observation gap. Recreating it in a passive
effect first committed DSL source on return and only then restored the UI.
The provider replaces disposed owners during render, with layout recovery for
effect-only reconnections. The program refreshes its mount gate in layout too,
so retained controls do not stay disabled after their effects reconnect.

### Why code-block checks stay with Markdown

`openuiFences.ts` uses remark closure tokens and the existing `remarkDisclosures`
plugin to locate authored OpenUI blocks. Both rendering and source checks use
the same disclosure parser. The server does not parse message Markdown.

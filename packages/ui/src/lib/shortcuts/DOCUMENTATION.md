# Registration boundary

Application commands use `useKeybind(actionId, handler)` or `useKeybinds(bindings)`. Both accept only action IDs derived from `SHORTCUT_SCHEMA`. Batch registration also rejects undeclared keys in prebuilt objects, including objects that mix valid and misspelled IDs. Both hooks use the shared `shortcutRegistry`, so components never receive a registry. The first registration for an action ID wins until it unregisters, then the next mounted registration takes over. A component-local interaction, such as editor navigation or an open menu, remains local event handling rather than a registered application command.

Do not add a component-level `window` or `document` keydown listener for an application command. Declare the action in `config.ts`, then register its handler near the state or UI it owns. This keeps definitions and dispatch centralized without lifting component state or passing callbacks through unrelated components.

# Schema contract

`config.ts` is the declaration-only source for application commands. It organizes entries into `session`, `models`, `panels`, `navigation`, and `application` groups, then explicitly concatenates them into `SHORTCUT_SCHEMA`. Every entry declares an ID, default binding, and whether users can customize it. Customizable entries also declare their Settings translation key, so Settings must not maintain an action-ID switch or English fallback labels.

Configuration must not contain lookup functions, override resolution, event matching, registry state, or runtime handlers. Those concerns belong to the owning modules below. Keeping configuration declarative makes the complete shortcut inventory reviewable without reading execution code.

Component interaction keys that are not application commands, such as list navigation or text editing, do not belong in the schema. Contextual application commands do belong there even when they are not customizable; `save_file` and `find_in_file` are examples.

# Module roles

- `index.ts` is the only public import surface, exposed as `@/lib/shortcuts`.
- `config.ts` owns grouped declarations and the final `SHORTCUT_SCHEMA`.
- `schema.ts` derives action and category types and provides schema lookup and effective binding resolution.
- `bindings.ts` owns chord parsing, normalization, display, browser-risk checks, and conflict rules.
- `registry.ts` owns the active handler for each action ID and stack-safe temporary suspension of all application handlers.
- `dispatcher.ts` resolves current bindings and turns keyboard events into registered command calls.
- `useKeybind.ts` ties registrations to React component lifetimes while keeping handlers current without re-registering after every render.
- Runtime hooks install one dispatcher listener for their window. The main application and Mini Chat have separate windows but use the same contracts.

# Binding rules

Bindings remain persisted as `Record<string, string>`. Each binding has one chord or at most two space-separated chords, such as `mod+k p`. `mod` is the platform-neutral primary modifier (Command on macOS, Control elsewhere), while `alt` is the platform-neutral alternate modifier (Option on macOS, Alt elsewhere); `command`, `cmd`, `meta`, and `option` are accepted input aliases but normalize to those canonical tokens. `normalizeCombo`, `parseShortcut`, `formatShortcutForDisplay`, and `getShortcutConflict` provide the shared parsing and validation behavior. Display formatting uses macOS keyboard symbols (`⌘`, `⌥`, `⌃`, `⇧`) on macOS and named modifiers (`Ctrl`, `Alt`, `Shift`) elsewhere, including tooltip and accessible text consumers. A single chord conflicts with a sequence sharing its first chord; sibling sequences are valid.

The default layout follows three modes: single chords for everyday actions, the `mod+k` leader for open/go actions (`mod+k p`, `mod+k g`, `mod+k l`, `mod+k t`, `mod+k n`, `mod+k i`, `mod+k h`), and held digit prefixes — held `mod` + digit switches header session tabs, held `mod+alt` + digit switches context panel surfaces. Every schema action ships with a default binding; palette-only commands (context surfaces, OpenCode status, memory debug) live outside the schema and the palette invokes their owning modules directly. Single-chord handlers still get the first chance at a leader's chord; returning `false` lets the dispatcher arm the sequence.

The internal `switch_tab_*` bindings remain available to mobile handlers. Desktop numeric context-surface switching is resolved by the configurable `switch_context_surface` prefix before normal dispatcher matching and falls through on mobile.

Both digit prefixes yield when the event target is editable: an input, textarea, select, or contenteditable element. `switch_session_tab` defaults to a bare `mod` prefix, so without that guard plain ctrl/cmd+digit would switch tabs while the user is typing in the composer.

The settings recorder captures up to two chords with at most three simultaneous physical keys per chord and checks the complete schema, not only customizable actions. After the first chord it waits up to 3000ms for a second; conflict and browser-risk feedback appears only when the second chord, timeout, or Confirm settles the recording. It keeps the recording local until the user clicks Confirm, allows an exact customizable conflict to replace the previous assignment, and blocks prefix conflicts unless the single-chord action explicitly allows sequence fallback. Those contextual prefixes remain saveable with a warning because their handler yields outside its owning context. Internal bindings are authoritative: persisted overrides cannot change or unassign them, and recorder conflicts with them cannot be replaced.

`add_selection_to_chat` is contextual. A visible text-selection toolbar publishes its Add to chat and dismiss actions, suspends the shared application registry, and clears both synchronously when hidden or unmounted. The main application route also gates directly on active toolbar ownership before global dispatch, so unrelated shortcuts cannot escape the scoped interaction even if runtime bundling isolates registry state. The newest visible toolbar owns a dedicated scoped dispatcher; it ignores IME composition, stops IME Escape before the global Escape route without preventing its native default, handles non-IME Escape and the configured Add to chat binding (including a two-chord binding), and lets native input continue for unrelated keys. The application handler returns `false` when no toolbar action is active, so an unselected or stale DOM range can instead become a sequence leader. Opening, closing, or replacing a toolbar invalidates any pending scoped or global prefix.

# Dispatching

`ShortcutDispatcher` is DOM-independent. It invokes only currently registered handlers, resolves bindings when dispatching, and holds an active sequence prefix for 3000ms. The application keydown route clears that prefix on window blur and consumes Escape only when it cancels a prefix. A handler returns `false` to leave the completed binding unconsumed. When a sequence prefix is active, only its second key is dispatched during window capture so local input handlers cannot block it; an exact second key remains eligible during IME composition and is prevented when handled, while an IME mismatch clears the prefix and retains normal composition input. Normal application shortcuts remain window-bubble listeners.

`shortcutRegistry.suspend()` disables all application handlers and returns an idempotent cleanup. Suspensions nest; handlers resume only after the final cleanup. Starting or ending a suspension invalidates every pending global dispatcher prefix, so stale second keys and Escape cannot consume it. Interaction surfaces that need shortcuts while suspended must own a dedicated scoped dispatcher and process it before the global route.

Shared `DropdownMenu` and `Select` can opt into this boundary with `disableGlobalShortcuts`; they suspend while open for both controlled and uncontrolled popups and resume on close or unmount. Exact `Ctrl+N` and `Ctrl+P` chords are translated to menu navigation even when the native event reports IME composition; no other composing key is intercepted. Window capture stops an IME Escape before Base UI's document-level dismiss listener without preventing the native IME action. Controlled draft project and worktree pickers close on non-IME Escape from either the trigger or portaled popup.

Terminal capture, Escape abort priming, and the shifted reverse-agent chord are input-boundary exceptions. They preserve their target-specific semantics and invoke the registered application handler rather than duplicating command behavior.

Local key handling remains appropriate for text editing, IME composition, menu and list navigation, dialog confirmation, terminal input, and other interactions that do not represent configurable application commands. The settings recorder treats Enter and Escape as recordable keys; only its explicit Confirm and Cancel buttons apply or discard a recording.

# Adding shortcuts

1. Add the command to the matching group in `config.ts`. Use a stable action ID and a normalized default binding. Keep sequences to at most two chords.
2. Mark the command `customizable: true` only when it should appear in Settings. Add its `settingsLabelKey` and provide that key in every locale in the same change.
3. Register the handler with `useKeybind` or `useKeybinds` near the state or UI that owns the behavior. Do not pass shortcut callbacks through unrelated components or move local UI state into a global store.
4. Return `false` when the mounted handler is not applicable in the current runtime or focus context. This lets another command sharing the binding or prefix continue dispatching.
5. Add or update schema, binding, registry, or dispatcher tests for the changed contract. Update Help Dialog metadata when the command should be discoverable there.

# Best practices

- Import production APIs only from `@/lib/shortcuts`; deep imports are reserved for files and tests inside this module.
- Keep `config.ts` declarative and grouped. Do not add helpers there for querying state or executing behavior.
- Every application command must appear exactly once in `SHORTCUT_SCHEMA`, including internal and debug commands. Component-only editing and navigation keys stay local and out of the schema.
- Avoid exact default-binding conflicts. When runtime-exclusive commands intentionally share one, document the reason beside both declarations and make each handler return `false` outside its runtime.
- Persist bindings as normalized strings. Never change the `Record<string, string>` override contract without an explicit migration and compatibility tests.
- Preserve the two-chord maximum in configuration, recording UI, parsing, conflict detection, display, and tests.

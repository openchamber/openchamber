# VS Code and mobile application roots

## Ownership

`VSCodeApp` composes the shared runtime, theme and sync contexts for VS Code webviews. The extension host selects the root's `panelType` in its bootstrap document. `VSCodeLayout` owns chat/session navigation; `SettingsView` owns Settings pages and responsive navigation. The native panel lifecycle belongs to `packages/vscode/src`, documented there.

`MobileShell` in `MobileApp` owns the phone and tablet surfaces, Settings among them.

## Invariants

- Chat-side Settings entry points request the native Settings tab through `RuntimeAPIs.vscode`. They preserve chat selection, drafts and the current layout. The source's in-page dialog flag is cleared so it cannot block chat shortcuts.
- Only the Settings root receives page navigation. The bridge parses it before applying it to stores, and the mounted root signals readiness before the host consumes pending navigation.
- The Settings root supplies no selected directory to the shared sync provider. It does not start global session polling, selected-directory session bootstrap or background queue delivery/cleanup, and seeing it never marks a chat as viewed. Settings pages resolve their own project through `useSettingsDirectory`; catalog updates still use the shared sync context.
- Its runtime shortcut hook registers Settings actions only and requires no chat sync context. Chat, model and session shortcuts remain with chat roots, so a key pressed in Settings cannot create an unseen draft or change a session selection there. Escape reaches an input or menu before the tab's close handler.
- On mobile, a request for the Settings dialog opens the fullscreen Settings surface and clears the dialog flag (`mobileSettingsNavigation.ts`). It lands on the requested page when the phone shows that page, otherwise on the page list. Entry points keep calling `setSettingsDialogOpen` and need no mobile branch.
- Settings uses the existing persistence and broadcast protocol. Moving its host changes no stored format, registry key or runtime availability.

## Decisions

### Why navigation carries intent and not the source's stores

Each webview owns its own stores. A small parsed request preserves the originating Settings directory, page links, provider-connect action and new-snippet action without transferring chat state or overwriting the tab's independently edited settings.

### Why mobile listens for the dialog flag and not a mobile branch at every entry point

About twenty shared entry points open Settings through `setSettingsDialogOpen`. The phone renders no dialog, so each one did nothing there and left the flag set, which blocks chat shortcuts. One bridge in the shell covers every entry point, the same way the VS Code bridge does.

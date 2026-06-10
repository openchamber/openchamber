# Settings Item Search Plan

## Goal

Add Settings search that finds individual settings items, not only top-level pages.

The search should behave like this:

- User types a query in the Settings navigation area.
- Results show matching concrete settings, grouped or labeled by their Settings page.
- Each result shows the item title and, when available, its description.
- Clicking a result opens the correct Settings page.
- After the page renders, the matching row/card/section scrolls into view.
- The matched item gets a short visual highlight so the user can see where they landed.

## Current Architecture Notes

- Settings shell lives in `packages/ui/src/components/views/SettingsView.tsx`.
- Page metadata and slugs live in `packages/ui/src/lib/settings/metadata.ts`.
- Settings localization lives in `packages/ui/src/lib/i18n/messages/*.settings.ts`.
- Settings UI text is read through `useI18n()` and `t(key)`.
- Standard page wrappers live in `packages/ui/src/components/sections/shared/`.

## Proposed Architecture

Use an explicit searchable item registry instead of scraping React or the DOM.

Each searchable item should contain:

- `id`: stable item id, for example `appearance.language`.
- `page`: target `SettingsPageSlug`, for example `appearance`.
- `titleKey`: localized title key.
- `descriptionKey`: optional localized description key.
- `keywords`: optional non-visible search helpers.
- `isAvailable`: optional runtime/mobile guard for item-level availability.

Example:

```ts
{
  id: 'appearance.language',
  page: 'appearance',
  titleKey: 'settings.appearance.language.label',
  descriptionKey: 'settings.appearance.language.description',
  keywords: ['locale', 'translation', 'ui language'],
}
```

## Implementation Steps

1. Create `packages/ui/src/lib/settings/search.ts`.
   - Export `SETTINGS_SEARCH_ITEMS`.
   - Export a helper to build localized search results from `t()`.
   - Filter by page availability and `visiblePageSlugs`.

2. Add search UI to `SettingsView.tsx`.
   - Search input should live in the left Settings navigation area on desktop.
   - On mobile, keep behavior simple: show results in the nav stage and open target page on select.
   - When query is empty, keep the existing navigation list.
   - When query has text, replace the normal nav list with concrete search results.

3. Add click behavior for a search result.
   - Set `settingsPage` to the result page.
   - Store pending target item id in component state/ref.
   - After content renders, find `[data-settings-item="<id>"]`.
   - Scroll it into view.
   - Add a temporary highlight using a data attribute or CSS class.

4. Add a tiny shared anchor/highlight pattern.
   - Prefer adding `data-settings-item="..."` to existing row/card containers.
   - Avoid wrappers that change layout.
   - Keep highlight styling generic, for example a short ring/background transition.

5. Add initial searchable coverage.
   - Start with high-value pages that already use many localized strings:
     - `appearance`
     - `chat`
     - `sessions`
     - `notifications`
     - `git`
     - `providers`
     - `agents`
   - Add more pages incrementally.

6. Validation.
   - Run `bun run type-check`.
   - Run `bun run lint`.
    - Manually verify search result navigation for at least one single page and one split page.

## Current Implementation Status

Done:

- `packages/ui/src/lib/settings/search.ts` exists and exports the explicit registry plus localized result builder.
- Search input is wired into `SettingsView.tsx`.
- Results are grouped by page header.
- ArrowUp, ArrowDown, Enter, and Escape work while the search input is focused.
- Result click opens the target page and scrolls to `[data-settings-item="..."]`.
- Matching target gets a temporary highlight via `data-settings-search-highlight`.
- Search respects page availability, `visiblePageSlugs`, and item-level platform/runtime/mobile guards.
- Initial anchors exist for `appearance`, `chat`, `sessions`, `notifications`, `git`, and `usage`.

Covered pages/items so far:

- `appearance`: themes, localization, PWA/mobile-only controls, layout controls, navigation controls, usage reports.
- `chat`: render mode, transport, reasoning, layout/message toggles, mobile status bar, dotfiles, queue/draft/spellcheck.
- `sessions`: defaults, retention, desktop network controls, OpenCode CLI controls.
- `notifications`: delivery, events, background push.
- `git`: GitHub account, identities, changes view, Gitmoji, gitignored files.
- `usage`: header menu visibility, model quotas section.
- `agents`: create action plus static editor fields for name, mode, model, temperature, Top P, system prompt, and permissions.
- `commands`: create action plus static editor fields for name, agent, model, and template.
- `mcp`: create action plus static editor sections for server, command/URL, environment variables, and advanced remote options.
- `plugins`: add action plus static editor fields for spec, options JSON, and file content.
- `snippets`: create action plus snippet content editor.
- `providers`: connect action plus auth, connection details, and models sections.
- `skills.installed`: create action plus basic information, instructions, and supporting files sections.
- `behavior`: global AGENTS.md and response style sections.
- `projects`: static project metadata fields and worktree section, excluding individual projects.
- `skills.catalog`: source repository, catalog search, and add catalog action, excluding individual catalog skills/sources.
- `magic-prompts`: visible prompt, instructions, and reset-all action, excluding individual prompt result generation beyond the selected editor page.
- `shortcuts`: keyboard shortcut editor section.
- `voice`: voice setup, speech recognition, and playback sections.
- `tunnel`: provider, tunnel type, TTLs, managed remote/local configuration, and start/connect link sections.
- `remote-instances`: client auth/pairing and desktop direct-host sections; SSH instance dialog fields stay out of search because they require selected-instance state.

Still pending:

- Add state-aware filtering for settings that are hidden based on current settings values, not just platform. Examples: `chat.activity-default-mode`, `chat.collapsible-reasoning`.
- Add focused tests for `buildSettingsSearchResults`, especially runtime/mobile filtering.

Out of scope by decision:

- Do not generate search results from dynamic store entities such as individual agents, commands, MCP servers, snippets, plugins, skills, providers, or projects.
- For split pages, search should cover predictable static create actions, editor fields, and sections only.

## Important Constraints

- Do not rely on localized key naming alone for navigation. The registry is the source of truth.
- Do not parse JSX or scrape the DOM to discover settings automatically.
- Search should use current locale strings, with English fallback already handled by i18n.
- Do not introduce broad Zustand state for transient search query/highlight state. Keep it local to `SettingsView` unless another surface needs it.
- Keep page behavior unchanged when the query is empty.
- If a page is unavailable in the current runtime, its search items must not appear.

## Future Improvements

- Add fuzzy ranking instead of simple substring matching.
- Support deep-linking to settings items from URLs or app commands.
- Add complete registry coverage for all Settings pages.

# Settings Search

Settings search uses an explicit registry; it does not scrape JSX.

## Required Integration

- Add/update items in `packages/ui/src/lib/settings/search.ts`.
- Add a matching `data-settings-item="..."` anchor to the rendered setting.
- Use localized labels/descriptions from every `packages/ui/src/lib/i18n/messages/*.settings.ts` dictionary.
- For a new top-level page, add metadata in `packages/ui/src/lib/settings/metadata.ts` and searchable content unless the page is purely navigational.

## Registry Rules

- Index stable controls, section headers, and static create/connect actions.
- Use IDs matching page and target, such as `appearance.language`.
- Prefer the visible label key as `titleKey`.
- Add `descriptionKey` only when it improves context.
- Add useful synonyms/acronyms as keywords.
- Do not generate items for dynamic entities such as individual agents, providers, projects, skills, hosts, or sessions.

## Conditional Targets

- Do not index a target hidden behind selected-entity state unless search selection prepares that state first.
- Keep item `isAvailable` identical to actual render visibility.
- Put page-level availability in `metadata.ts` and item-specific guards in `search.ts`.
- Distinguish desktop shell from local desktop origin when the feature requires local privileges.
- For split pages, index predictable static surfaces and update `prepareSettingsSearchTarget` when a result must open a draft/editor before highlighting.

## Highlight Anchor

- Put `data-settings-item` on the smallest stable container that visually owns the setting.
- Do not add layout-only wrappers solely for search.
- Keep highlight styling token-based and subtle; it lives under `[data-settings-search-highlight="true"]` in `packages/ui/src/index.css`.

## Audit

- Every registry ID has a matching anchor.
- Every title/description key exists in every Settings locale.
- Every non-navigational page has appropriate coverage.
- Search visibility matches platform/runtime/mobile rendering.
- Conditional state is prepared before highlight.
- Empty-query Settings navigation remains unchanged.

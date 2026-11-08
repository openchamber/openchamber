# Settings Layout

All primitives and class constants below live in
`packages/ui/src/components/sections/shared/SettingsSection.tsx` and
`SettingsPageLayout.tsx`. Import them; never re-declare local equivalents.

## Page Skeleton

```tsx
<SettingsPageLayout
  title={t('settings.page.x.title')}
  description={t('settings.page.x.description')}
  showSaveStatus
>
  <SettingsSection title={t('...sectionA')} divider={false}>…</SettingsSection>
  <SettingsSection title={t('...sectionB')}>…</SettingsSection>
</SettingsPageLayout>
```

- `SettingsPageLayout` owns scrolling, page padding, the `@container` context, and the quiet save indicator (`showSaveStatus`).
- Sections separate with a top border (`divider`, default true); the first section under the page header passes `divider={false}`.
- Section titles are real headers (L2). Do not nest an umbrella section around a list of `SettingsControlGroup`s when each group deserves its own header — promote groups to sections instead (see the Chat page precedent).

## Hierarchy Levels

| Level | Component / class | Use |
|---|---|---|
| L1 | `SETTINGS_PAGE_TITLE_CLASS` (via `SettingsPageLayout`) | Page title |
| L2 | `SettingsSection` title (`SETTINGS_SECTION_TITLE_CLASS`) | Section |
| L3 | `SettingsControlGroup` title (`SETTINGS_GROUP_TITLE_CLASS`) | Sub-cluster inside a section |
| L4 | `SETTINGS_FIELD_LABEL_CLASS` | Field / control labels |
| Helper | `SETTINGS_HELPER_CLASS`, `SETTINGS_DESCRIPTION_CLASS` | Rare visible helper text (most goes behind `info`; see the skill's Description Policy) |

## Navigation Placement

Sidebar groups are defined in `packages/ui/src/lib/settings/metadata.ts`; `pageOrder` in `SettingsView.tsx` sets their order.

Placement rules:

- **General** hosts app-level settings that don't belong to a feature page, in this order: desktop app (startup, menu bar, tray, keep awake) and quick access (the system-wide Mini Chat and Quake shortcuts), files and editor, terminal, panels and links, password and network access, passkeys, trusted app links, OpenCode CLI binary, environment, agent tools, message stream transport, privacy.
- Feature pages (Appearance, Chat, Sessions…) keep only settings about that feature. If a setting reads awkwardly on its page, move it to General rather than inventing a new page.
- New pages need metadata, `pageOrder`, nav icon, `settings.page.<slug>.title/description` in every locale, and mobile whitelist (`MOBILE_SETTINGS_PAGES` in `MobileApp.tsx`) when relevant.

## Pages With Tabs

A page whose sections no longer read as one list splits into tabs under the
page header: an active-pill `SortableTabsStrip` with `pillSize="form"` and
`h-8`, then the tab's sections, the first without a divider. Chat (Messages,
Composer, Assistance) and a project's page are the precedents. The tab lives in
a small store outside the page (`chatSettingsTabs.ts`,
`projectSettingsTabs.ts`) with a map from search item ids to tabs, and
`SettingsView` opens the right tab before it highlights a search result or a
Settings link target. A new searchable control on such a page gets an entry in
that map; `ChatSettings.test.tsx` fails for a Chat item without one.

## Browse Pages: Card Grid vs List

A page that browses things with a glanceable state (Providers, MCP, Plugins, Extensions)
opens on a card grid from `shared/SettingsCards.tsx`: a dashed add card leads
the grid, each card opens a detail screen with `SettingsBackButton`, and the
page kind is `single`. The shown item is page-local or cleared on unmount, so
every visit starts at the grid. Pages that edit long text (Agents, Commands,
Skills, Snippets, Magic Prompts) keep the `split` list-plus-editor layout; a list
that can grow long filters with `SettingsSidebarSearch`. Card chrome lives only in the shared
card components; section content inside a detail screen stays flat.

## Responsiveness: Container Queries

The settings pane is far narrower than the viewport (3-pane dialog). All
pane content responds to the pane via container queries — `@xl:` (36rem) and
`@3xl:` (48rem) — never viewport `sm:`/`lg:`. `SettingsPageLayout` provides
the `@container` scope; `SettingsFieldRow`, `SettingsTwoColumn`, and the
trigger-width constants already carry the right variants.

Exception: `SettingsView` navigation chrome (outside the pane) uses viewport
`sm:` to give phones 44px touch rows and plain `bg-background`; keep that
pattern when touching nav.

## Spacing

- Sections own vertical rhythm: divider + `py-8` come from `SettingsSection`.
- Field rows stack with no spacing of their own: `SettingsFieldRow` carries its padding, so rows of 32px controls sit 8px apart and every label keeps one rhythm. Wrap a run of field rows in a plain `<div>`; never put a checkbox between them (a choice among a few is chips in a field row, see `controls.md`).
- Inside a section, a run of field rows and a run of checkboxes are separate blocks with `space-y-3` (or `space-y-4`) between them.
- Stacked fields inside a column: `SETTINGS_FIELDS_STACK_CLASS` (`space-y-4`).
- Checkbox/radio lists: `SETTINGS_OPTION_STACK_CLASS` (`space-y-1.5`).
- Groups requiring a title and visible description: separate them from preceding controls with `space-y-6` on the parent. Keep simple checkbox/radio lists compact. The title sits closer to its own description and controls than to the preceding group; use `SettingsControlGroup`'s internal spacing.
- Two-column areas: `SettingsTwoColumn` (`@3xl:grid-cols-2`); use `SettingsStackedField` inside cells (a `SettingsFieldRow` overflows half-width columns).
- No elevated backgrounds, rounded rows, or hover fills without explicit UX value.

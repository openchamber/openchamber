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
| Helper | `SETTINGS_HELPER_CLASS`, `SETTINGS_DESCRIPTION_CLASS` | Rare visible helper text (most goes behind `info`) |

## Navigation Placement

Sidebar groups (`packages/ui/src/lib/settings/metadata.ts`, order in `SettingsView.tsx`):

- **OpenChamber** (`general` group): General, Appearance, Chat, Notifications, Sessions, Shortcuts, Voice, Usage, About.
- **Workspace** (`projects`): Projects, Remote Instances, External Tunnel, Git.
- **OpenCode** (`opencode`): Providers, Agents, Behavior, Commands, MCP, Plugins.
- **Library** (`content`): Magic Prompts, Snippets, Skills, Skills Catalog.

Placement rules:

- **General** hosts app-level settings that don't belong to a feature page: startup/tray/window, network access + UI password, passkeys, OpenCode CLI binary, terminal shell/navigation, message stream transport, privacy.
- Feature pages (Appearance, Chat, Sessions…) keep only settings about that feature. If a setting reads awkwardly on its page, move it to General rather than inventing a new page.
- New pages need metadata, `pageOrder`, nav icon, `settings.page.<slug>.title/description` in every locale, and mobile whitelist (`MOBILE_SETTINGS_PAGES` in `MobileApp.tsx`) when relevant.

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
- Fields inside a column: `SETTINGS_FIELDS_STACK_CLASS` (`space-y-4`).
- Checkbox/radio lists: `SETTINGS_OPTION_STACK_CLASS` (`space-y-1.5`).
- Two-column areas: `SettingsTwoColumn` (`@3xl:grid-cols-2`); use `SettingsStackedField` inside cells (a `SettingsFieldRow` overflows half-width columns).
- No elevated backgrounds, rounded rows, or hover fills without explicit UX value.

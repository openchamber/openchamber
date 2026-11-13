---
name: locale-ui-patterns
description: Use when creating or modifying OpenChamber UI text, labels, buttons, placeholders, aria labels, empty states, toasts, dialogs, settings copy, navigation labels, or any user-facing strings.
---

# Locale UI Patterns

## Core Rule

User-facing UI text must go through `@/lib/i18n`; do not hardcode English strings in components.

## What the text says

UI text tells the person what they get and what to do: what an option gives them, what happened, what fixes it. Engineering reasons (layout jumps, races, what the code avoids) belong in code comments and commit messages. Example: "Shows the model's thinking as it arrives. When off, the block stays folded and opens with a click." An error names the known cause and the action ("reconnect the repository's account in Settings"), never a generic "something went wrong" when the cause is known. An error that hides a known cause is a defect (root AGENTS.md, *Pull Request Handoff*), fixed without asking.

## Translate everything immediately (no English placeholders)

Every key you add to a non-English dictionary MUST contain a real translation in that language — never the English source string as a stand-in. There is NO "leave it in English for now" convention in this project; if an agent told you there was, it was wrong. Copying the English value into `es.ts`/`fr.ts`/`ko.ts`/`pl.ts`/`pt-BR.ts`/`uk.ts`/`zh-CN.ts`/`zh-TW.ts` is a defect, not a deferral. The app ships every locale at once, so an untranslated key is a visible bug for those users.

If you genuinely cannot translate a language, say so explicitly to the user instead of silently pasting English.

## Required Flow

1. Add or reuse a key in `packages/ui/src/lib/i18n/messages/en.ts`.
2. Add the same key — fully translated, not the English text — to every non-English dictionary in `packages/ui/src/lib/i18n/messages/`.
3. In components, call `const { t } = useI18n()` from `@/lib/i18n` and render `t('key')`.
4. For locale names or language picker labels, use `label(locale)` from `useI18n()`.
5. Keep locale state in `packages/ui/src/lib/i18n/*`; do not add locale fields to broad stores like `useUIStore`.
6. Do not remount the app to update language. Components must re-render through `useI18n()`.

## Component Usage Rules

- Import from `@/lib/i18n`, not deep files.
- Keep `t(...)` calls inside React render/hook scope so locale changes re-render text.
- Do not resolve translated text at module scope.
- For static option arrays, store `labelKey` / `descriptionKey`; resolve with `t(...)` inside the component.
- For non-React helpers, pass translated strings in from the component or pass `t` explicitly.

## Key Style

Keys are stable and semantic: location + UI role + meaning (`settings.appearance.language.label`), never the English copy. Extend the naming already used nearby; with none, mirror the UI ownership in a short path.

Good:
```ts
'settings.appearance.language.label': 'Language'
'layout.mainTab.chat': 'Chat'
'chat.input.placeholder': 'Ask OpenChamber...'
```

Bad:
```ts
'Language': 'Language'
'chatLabel': 'Chat'
'askOpenChamberDotDotDot': 'Ask OpenChamber...'
```

Avoid overly generic keys unless the text is truly global and context-independent. Prefer specific keys when button meaning can vary by surface.

## Parameters

Use `{name}` placeholders for dynamic values.

```ts
'toast.language.changed': 'Language changed to {language}'
```

```tsx
t('toast.language.changed', { language: label(locale) })
```

Placeholders carry only real values (`{count}`, `{name}`, `{path}`), never grammar pieces such as `{suffix}`, `{plural}` or `{article}`.

Bad:
```tsx
t('dialog.delete.description', { count, suffix: count === 1 ? '' : 's' })
```

Good:
```tsx
count === 1
  ? t('dialog.delete.descriptionSingle', { count })
  : t('dialog.delete.descriptionPlural', { count })
```

Count-dependent text and optional clauses each get their own complete-message key; never inject one translated phrase into another. Count-dependent text can use one key if all supported locales use one identical complete sentence.

Bad:
```tsx
t('dialog.delete.description', {
  dateLabel: date ? t('dialog.delete.dateSuffix', { date }) : '',
})
```

Good:
```tsx
date
  ? t('dialog.delete.descriptionWithDate', { count, date })
  : t('dialog.delete.description', { count })
```

## Desktop Native Menus

The Electron app menu and the right-click context menu are native, outside `@/lib/i18n`. Their labels live in `packages/electron/menu-locales.mjs` (`MENU_LOCALE_DICTIONARIES`, `CONTEXT_MENU_LABEL_DICTIONARIES`), keyed by the same locale codes as the UI. A new menu item gets its label in every locale there, and a new UI language gets its own entry there in the same change; `menu-locales.test.mjs` checks key parity.

## Adding a UI Language

Russian is not added: a standing maintainer decision (`triage-prs`, template *russian-locale*).

A new locale code lands in all of these in one change:

- `packages/ui/src/lib/i18n/runtime.ts`: the `Locale` union, `LOCALES`, `LOCALE_LABEL_KEYS`, and `normalizeLocale` (include legacy tags the platforms still send, such as `iw` for Hebrew). A right-to-left language also joins `RTL_LOCALES`; the layout side is owned by `rtl-layout`.
- `store.ts` (lazy import), `intl.ts` (Intl tag), `bootstrap.ts` (startup strings), `messages.test.ts`.
- `messages/<locale>.ts` and `messages/<locale>.settings.ts`, a `<locale>` block in every `messages/*.i18n.ts`, and a `common.language.<name>` label in every existing dictionary.
- `packages/electron/menu-locales.mjs` (see above).
- `packages/web/server/lib/opencode/settings-helpers.js` `UI_LOCALE_VALUES`: without it the server drops the saved choice. `packages/web/server/lib/walkthrough/languages.js` names the language for walkthrough prompts.

## Translation Boundary

Translate visible text, placeholders, tooltips, dialogs, toasts, empty/error/loading states, and user-facing `aria-label`, `title`, and `alt` text.

Keep these literal:

- Product names: `OpenChamber`, `OpenCode`, `GitHub`
- Protocol/tool acronyms: `MCP`, `SSE`, `WebSocket`, `API`
- Model/provider names
- File paths, command names, environment variables
- User/generated content

## Completion Criteria

- No new hardcoded user-facing English in changed UI files.
- Every new key exists in all dictionaries with a real translation, including `packages/electron/menu-locales.mjs` for native menu labels.
- All translated values are resolved inside a reactive render/hook boundary.
- No locale state added to broad/shared stores.
- No full app remount for locale changes.
- Locale switch preserves current UI state.

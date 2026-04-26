---
name: locale-ui-patterns
description: Use when creating or modifying OpenChamber UI text, labels, buttons, placeholders, aria labels, empty states, toasts, dialogs, settings copy, navigation labels, or any user-facing strings.
---

# Locale UI Patterns

## Core Rule

User-facing UI text must go through `@/lib/i18n`; do not hardcode English strings in components.

Use this skill for any React UI change that adds or edits visible text, accessible labels, placeholders, tooltips, toasts, dialogs, settings labels, navigation labels, or empty/error states.

## Required Flow

1. Add or reuse a key in `packages/ui/src/lib/i18n/messages/en.ts`.
2. Add the same key to every non-English dictionary in `packages/ui/src/lib/i18n/messages/`.
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

Use stable semantic keys, not English text as keys.

Keys should describe location + UI role + meaning. They should not encode current copy wording.

Use existing nearby naming when extending a surface. If no nearby pattern exists, choose a short path that mirrors the UI ownership.

Namespaces like `layout.*`, `settings.*`, `chat.*`, `git.*`, `session.*`, `toast.*`, and `dialog.*` are examples, not a fixed exhaustive list.

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

Do not pass grammar fragments as params. Never use params like `{suffix}`, `{plural}`, `{article}`, `{prefix}`, `{dateSuffix}`, or pieces of words/sentences.

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

Plural/count-dependent text must use separate complete-message keys unless all supported locales can use one identical complete sentence. Placeholders are only for real values (`{count}`, `{name}`, `{path}`), not grammar.

Optional clauses must also be complete-message keys. Do not build a sentence by injecting a translated phrase into another translated sentence.

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

## What Counts As UI Text

- Button and menu labels
- Settings labels and descriptions
- Placeholder text
- Tooltip content
- Dialog titles/descriptions/actions
- Toast title/description/action labels
- Empty/error/loading states
- `aria-label`, `title`, image `alt` text when user-facing

## Exceptions

Do not translate:

- Product names: `OpenChamber`, `OpenCode`, `GitHub`
- Protocol/tool acronyms: `MCP`, `SSE`, `WebSocket`, `API`
- Model/provider names
- File paths, command names, environment variables
- User/generated content

## Review Checklist

- No new hardcoded user-facing English in changed UI files.
- Every new key exists in all dictionaries.
- No locale state added to broad/shared stores.
- No full app remount for locale changes.
- Locale switch preserves current UI state.

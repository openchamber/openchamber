# i18n — OpenChamber Internationalization

This directory contains the **source of truth** for all user-facing strings in OpenChamber. The system uses [Paraglide JS](https://inlang.com/m/gerre34r/library-inlang-paraglideJs) — a compile-time i18n solution with zero runtime overhead.

## Architecture

```
messages/*.json          ← Source of truth (edit these)
      ↓ paraglide compile
src/paraglide/           ← Generated JS (gitignored)
      ↓ generate-paraglide-compat.mjs
src/lib/i18n/messages.ts ← Compat layer (camelCase wrappers, auto-generated)
```

### Key files

| File | Purpose |
|------|---------|
| `messages/*.json` | Source translations — **edit these** |
| `project.inlang/settings.json` | Paraglide config (locales, plugin) |
| `scripts/generate-paraglide-compat.mjs` | Generates camelCase compat layer |
| `src/lib/i18n/store.ts` | Zustand store for locale state (`useI18nStore`) |
| `src/lib/i18n/runtime.ts` | Locale detection, normalization, `AVAILABLE_LOCALES` |
| `src/lib/i18n/context.tsx` | React `I18nProvider` |
| `src/lib/i18n/messages.ts` | Auto-generated — **do not edit** |

## Current locales

| Code | Language |
|------|----------|
| `en` | English (base) |
| `zh-CN` | 简体中文 |
| `zh-TW` | 繁體中文 |
| `ja` | 日本語 |
| `vi` | Tiếng Việt |

## Usage in components

```tsx
// Import message functions
import { m } from '@/lib/i18n/messages'

// Simple string
<span>{m.chatYou()}</span>

// With parameters (ICU format in JSON)
<span>{m.chatReadAloud({ provider: 'OpenAI' })}</span>

// Access locale state
import { useI18nStore } from '@/lib/i18n/store'
const locale = useI18nStore(s => s.locale)
```

## Adding a new string

1. Add the key to **all** locale files in `messages/` (snake_case):
   ```json
   // en.json
   "chat_new_feature": "New feature"

   // zh-CN.json
   "chat_new_feature": "新功能"
   ```

2. Run `bun run type-check` (triggers `paraglide compile` + compat generation)

3. Use the camelCase function in your component:
   ```tsx
   import { m } from '@/lib/i18n/messages'
   <span>{m.chatNewFeature()}</span>
   ```

### Strings with parameters

Use `{param}` syntax in JSON:
```json
"chat_retry_count": "Retrying ({count}/{total})"
```

```tsx
<span>{m.chatRetryCount({ count: 1, total: 3 })}</span>
```

## Adding a new language

### 1. Register the locale

**`packages/ui/project.inlang/settings.json`** — add to `locales`:
```json
{
  "locales": ["en", "zh-CN", "zh-TW", "vi", "ja", "ko"]
}
```

**`packages/ui/src/lib/i18n/runtime.ts`** — update the type, array, and labels:
```ts
export type Locale = 'en' | 'zh-CN' | 'zh-TW' | 'vi' | 'ja' | 'ko';

export const AVAILABLE_LOCALES: readonly Locale[] = ['en', 'zh-CN', 'zh-TW', 'vi', 'ja', 'ko'] as const;

export const LOCALE_LABELS: Record<Locale, string> = {
  // ...existing entries...
  ko: '한국어',
};
```

### 2. Create the translation file

Copy `messages/en.json` as the starting point:
```sh
cp packages/ui/messages/en.json packages/ui/messages/ko.json
```

Translate all values in the new file. Keep keys identical to `en.json`.

### 3. Add locale normalization (if needed)

In `runtime.ts`, add mapping rules in `normalizeLocale()`:
```ts
if (lower.startsWith('ko')) return 'ko';
```

### 4. Compile and verify

```sh
bun run type-check   # compiles paraglide + regenerates compat layer
bun run build        # full build verification
```

### 5. Done

The language switcher in **Settings → Appearance** will automatically show the new language.

## Naming conventions

| Layer | Convention | Example |
|-------|-----------|---------|
| JSON keys | `snake_case` with area prefix | `chat_permission_allow_once` |
| Compat functions | `camelCase` (auto-generated) | `m.chatPermissionAllowOnce()` |
| Area prefixes | `chat_`, `status_`, `tool_`, `settings_`, `git_`, `sidebar_` | — |

## Rules

- **Do not edit** `src/lib/i18n/messages.ts` or `src/paraglide/` — they are auto-generated
- **Always use camelCase** function calls (`m.chatYou()` not `m.chat_you()`)
- **Keep all locale files in sync** — every key in `en.json` must exist in every locale file
- **Preserve `{param}` syntax** when translating strings with parameters
- **Test with `bun run type-check`** after any JSON changes

# Docs Authoring Guide

This package is docs content source-of-truth for OpenChamber.

## Voice & style

Write for someone trying to get something done — not for an engineer reading a
spec. Assume the reader may be non-technical. A page should feel quick to read,
never like a separate chore just to get through one screen.

These rules describe how we already write the docs. Follow them so the style
stays the same no matter who is writing.

### Who you're writing for

- Assume curiosity, not expertise. The reader knows what they want to do, not
  how OpenChamber works inside.
- One page = one job. If a page is answering two unrelated questions, split it.

### Keep it short

- Lead with the task, not background. The first line should say what the page is
  for ("Use `openchamber tunnel` to expose a running OpenChamber instance.").
- Cut anything that doesn't change what the reader does next.
- A basic page should fit in a screen or two. Long, dense reference pages (like
  Reverse Proxy) are the exception — and they say so in their first line ("Use
  this page if you run OpenChamber behind...").

### Steps

- Number sequential actions; use bullets for options or unordered notes.
- Start each step with a verb: "Run", "Open", "Pick".
- End a procedure by telling the reader what success looks like, so they know
  they did it right.

```mdx
3. Run `openchamber --ui-password be-creative-here`.
4. Open the printed URL (usually `http://localhost:3000`).

You should land on the OpenChamber session list. If you see it, the server is
running.
```

### Plain language

- Explain a term the first time it appears, in parentheses, in everyday words:
  - good: start a tunnel (a public link to your local OpenChamber)
  - bad: start a tunnel — the reader doesn't know what that is yet
- Prefer common words over internal ones. "App", "version", "page" beat
  "surface", "instance", "route" when the meaning is the same. If an internal
  term is unavoidable, define it once.
- Don't reach for `SSE`, `WebSocket`, `buffering`, or header names unless the
  page is explicitly an advanced/operator page.

### Bullets and sentences

- Be consistent within a single list. Either all short fragments (lowercase, no
  period) or all full sentences (capital letter, period) — don't mix the two in
  one list.
- Use fragments for quick option lists; use full sentences for rules, warnings,
  or anything the reader must not misread.

### Link out instead of re-explaining

- Where a step can realistically fail, link to
  [Troubleshooting](/troubleshooting/) right there, not only at the bottom.
- Don't re-document something another page owns — link to it. (Quickstart points
  at Install for the actual install command instead of copying it.)

### Show, don't only tell

- A screenshot beats a paragraph for anything visual (where a button is, what a
  screen looks like). See [Images](#images) for how to add one.
- Always pair a screenshot with one line of text — the image supports the step,
  it isn't the whole step.

### Commands and code

- Make code blocks copy-paste-ready: real, working values. Only use a
  `<placeholder>` when the value is genuinely user-specific, and make that
  obvious (e.g. `app.example.com`, `~/.secrets/cf-token`).
- One command per idea. Don't chain unrelated commands just to look compact.

## Add a new docs page

1. Create a new file in `packages/docs/content/docs/`.
   - Example: `packages/docs/content/docs/remote-access.mdx`
2. Add frontmatter at top:

   ```mdx
   ---
   title: Remote Access
   description: Access OpenChamber from outside your local network.
   ---
   ```

3. Use route-safe naming:
   - `foo.mdx` -> `/foo/`
   - `folder/index.mdx` -> `/folder/`
   - `folder/bar.mdx` -> `/folder/bar/`
4. Add translations for the page — see [Localization](#localization). Translations
   are optional per page (a missing translation falls back to English), but ship
   them together with the page when you can.
5. If the page is linked from the sidebar, add its localized labels too — see
   [Translate the sidebar](#translate-the-sidebar).
6. Run validation:

   ```bash
   bun run docs:validate
   ```

## Add a new sidebar section

Edit `packages/docs/sidebar.config.json`.

Example:

```json
{
  "label": "Advanced",
  "items": [{ "label": "Remote Access", "link": "/remote-access/" }]
}
```

Rules:

- use trailing slash in links (`/page/`)
- every sidebar link must map to an existing MDX file
- keep section labels short and task-oriented

## Images

Images live inside the docs content tree so they sync to the website with the
pages (the sync copies all of `content/docs/`, not just `.mdx`). Reference them
with a **relative path**; Astro optimizes them at build time.

```
content/docs/
  install.mdx          ->  ![Desktop app](./images/desktop.png)
  images/
    desktop.png
```

Rules:

- co-locate images under `content/docs/` (e.g. `content/docs/images/`); a
  relative `./images/...` reference is resolved and optimized at build
- always set meaningful `alt` text (and translate it in localized pages)
- do **not** put docs images in the website repo's `public/` — it is not the
  source of truth and the sync will not pick them up
- keep originals reasonably sized; the build generates responsive variants

For translations, reuse the same shared image when it carries no text. If a
screenshot contains localized UI text, add a per-locale copy under that locale's
folder (e.g. `uk/images/...`) and point the translated page at it.

`docs:validate` only checks `.mdx`, so images never block validation.

### Light / dark variants

To show a different screenshot per theme, add a `-light` / `-dark` pair and tag
each with `oc-light-only` / `oc-dark-only`. The website ships CSS for these
classes (keyed on Starlight's `data-theme`), so the right one shows and follows
the in-page theme toggle.

Use the `<Image>` component so the images stay optimized while taking a class.
Add the imports right under the frontmatter:

```mdx
---
title: Install
description: ...
---

import { Image } from "astro:assets";
import desktopLight from "./images/desktop-light.png";
import desktopDark from "./images/desktop-dark.png";

<Image src={desktopLight} alt="Desktop app" class="oc-light-only" />
<Image src={desktopDark} alt="Desktop app" class="oc-dark-only" />
```

Notes:

- both files live under `content/docs/` like any other image and sync normally
- give both the same `alt` (and translate it in localized pages)
- if you only have one image, just use the normal `![alt](./path.png)` form

## Localization

The docs are translated into the same languages the OpenChamber app ships in.
English is the source of truth and lives at the root of `content/docs/`. Every
other language mirrors the English files under a locale folder.

### Supported locales

| Language | Content folder | Sidebar `translations` key |
| --- | --- | --- |
| English | _(root, no folder)_ | `en` |
| Ukrainian | `uk/` | `uk` |
| Chinese (Simplified) | `zh-cn/` | `zh-CN` |
| Spanish | `es/` | `es` |
| Brazilian Portuguese | `pt-br/` | `pt-BR` |
| Korean | `ko/` | `ko` |
| Polish | `pl/` | `pl` |

> [!IMPORTANT]
> The **content folder** uses the lowercase locale key (`zh-cn`, `pt-br`); the
> **sidebar `translations`** key uses the BCP-47 language tag (`zh-CN`, `pt-BR`).
> They look similar but are not interchangeable — Starlight resolves them with
> different rules. Everything else (`uk`, `es`, `ko`, `pl`, `en`) is identical
> in both columns.

This locale set is mirrored in the website at
`openchamber-website/apps/docs/astro.config.mjs` (`locales`). If a language is
added or removed, update both places.

### Translate a page

Mirror the English file under each locale folder, keeping the **exact same
filename and path**. Starlight matches a translation to its English page by path.

```
content/docs/
  install.mdx              # English (source of truth)
  uk/install.mdx           # Ukrainian
  zh-cn/install.mdx        # Chinese (Simplified)
  es/install.mdx           # Spanish
  pt-br/install.mdx        # Brazilian Portuguese
  ko/install.mdx           # Korean
  pl/install.mdx           # Polish

  guides/tunnels.mdx       # nested English page
  uk/guides/tunnels.mdx    # its Ukrainian translation
```

Each translated file needs its **own translated frontmatter** (`title` and
`description` are required by validation):

```mdx
---
title: Встановлення
description: Встановіть OpenChamber для десктопа, вебу або VS Code.
---
```

You do **not** have to translate every page at once. A page that is missing in a
locale automatically falls back to the English version, so translations can land
incrementally.

### Translate the sidebar

Do **not** create separate sidebar entries per language and do **not** add a
locale prefix to `link` — Starlight prefixes the active locale automatically.
Instead, add a `translations` map (keyed by the BCP-47 tag from the table above)
to each section and item in `sidebar.config.json`:

```json
{
  "label": "Start here",
  "translations": {
    "uk": "Почніть тут",
    "zh-CN": "从这里开始",
    "es": "Empieza aquí",
    "pt-BR": "Comece aqui",
    "ko": "여기서 시작",
    "pl": "Zacznij tutaj"
  },
  "items": [
    {
      "label": "Install",
      "link": "/install/",
      "translations": {
        "uk": "Встановлення",
        "zh-CN": "安装",
        "es": "Instalación",
        "pt-BR": "Instalação",
        "ko": "설치",
        "pl": "Instalacja"
      }
    }
  ]
}
```

A label with no translation for the active locale falls back to the English
`label`.

### What not to translate

- brand and product nouns: OpenChamber, OpenCode, VS Code, PWA, GitHub, Discord,
  macOS, SSH
- code blocks, shell commands, file paths, flags, and config keys
- the page filename and the sidebar `link` (these stay identical across locales)

### Validate

`bun run docs:validate` walks every `.mdx` under `content/docs/` — **including
translations** — and fails if any page is missing `title` or `description`
frontmatter, or if a sidebar `link` does not resolve to an English page. Run it
after adding or translating pages.

## Sync into openchamber-website

`openchamber-website` renders/deploys docs via Starlight in `apps/docs`.

After docs content updates here:

1. copy `packages/docs/content/docs/*` -> `openchamber-website/apps/docs/src/content/docs/*`
   (this is recursive, so locale folders like `uk/` and `zh-cn/` carry over with
   no extra steps)
2. map `packages/docs/sidebar.config.json` into `openchamber-website/apps/docs/astro.config.mjs` sidebar
   (the `translations` maps carry over as-is)
3. run docs checks/build in website repo

Automation support exists in `.github/workflows/docs-source.yml` (release/manual packaging of docs source artifact).

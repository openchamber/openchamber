# Custom themes

Open **Settings → Appearance → Import VS Code theme** to search Open VSX.
Choose a package, compare the variant previews, and select the variants to import.
Batch import keeps your current theme active. Open VSX is a separate catalog;
themes published only in Microsoft Marketplace may not appear.

**Choose JSON file** imports a self-contained `.json` or `.jsonc` file. Desktop
starts its native picker in the local `~/.vscode/extensions` folder when it exists,
even when connected to a remote server. Browsers and mobile use their own picker.
UI colors use the same
surface mapping as the VS Code runtime adapter; general TextMate and semantic
token colors populate the syntax palette, and diff colors remain separate.
Regular imports adapt generic border intensity to OpenChamber's standard light
and dark palettes while retaining the source hue. High-contrast themes keep
their authored borders.
The theme is saved on the connected server and selected in its light/dark mode.
Package imports resolve JSON `include` and token files inside the downloaded VSIX.
For individual files with those references, export the active theme with
**Developer: Generate Color Theme From Current Settings** in VS Code first.

Delete a custom theme using the trash icon beside it in the theme dropdown.
This includes valid themes you added directly to the server's `themes` folder.
Deleting a selected theme restores the standard OpenChamber theme for that mode.
Built-in themes cannot be deleted. Delete and reimport a theme to update it.

Save a JSON file in `~/.config/openchamber/themes/`, then open **Settings → Theme → Reload themes** and select it. A custom OpenChamber data directory uses its own `themes` folder.

## Start with the base colors

This is a complete theme. OpenChamber supplies omitted states, foregrounds, syntax aliases and diff backgrounds.

```json
{
  "metadata": { "id": "my-theme", "name": "My theme", "variant": "dark" },
  "colors": {
    "primary": { "base": "#da7c47" },
    "surface": {
      "background": "#120f0e",
      "foreground": "#c9c5ba",
      "muted": "#171615",
      "mutedForeground": "#8f8b81",
      "elevated": "#181715"
    },
    "interactive": { "border": "#242323" },
    "status": {
      "error": "#da5b4a",
      "warning": "#c67f13",
      "success": "#76ad4f",
      "info": "#479fe6"
    },
    "syntax": {
      "base": {
        "comment": "#728772",
        "keyword": "#34983a",
        "string": "#d58373",
        "number": "#279e93",
        "function": "#78a952",
        "variable": "#c69457",
        "type": "#479cb1",
        "operator": "#da6b6d"
      }
    }
  }
}
```

Use hex or `rgb()`/`rgba()` colors for automatic contrast adjustment. Hex alpha is supported, such as `#ffffff20`. Surfaces can be opaque or translucent; there is no required alpha value.

## Color roles

- `surface.background` is the main canvas, `muted` is the secondary area, and `elevated` is for cards, inputs, dropdowns and dialogs. Components may adjust opacity while using the same role.
- `surface.foreground` and `mutedForeground` are primary and secondary text. `surface.elevatedForeground` controls text in dialogs, menus, cards and fields; it defaults to `foreground`.
- `primary.base` is the main action. `interactive.selection` is the selected state. They are independent.
- Fields keep their elevated background during hover, with `interactive.hover` layered over it. Focus uses `interactive.focusRing`; separators use `interactive.border`. `surface.subtle` is a quiet background, not a hover or focus color.
- Status colors represent feedback. Solid fills get a contrasting foreground; tinted buttons and alerts get separate computed text colors. Those computed colors are not extra authoring fields.
- Syntax controls code in chat, files and diffs. It uses your palette rather than a fixed third-party highlighting theme.

## Optional overrides

Add an override only when the default relationship does not fit your palette.

| Group | Optional fields |
|---|---|
| `primary` | `foreground`, `hover`, `active`, `muted` |
| `surface` | `elevatedForeground`, `overlay`, `subtle` |
| `interactive` | `selection`, `selectionForeground`, `hover`, `active`, `borderHover`, `borderFocus`, `focus`, `focusRing`, `cursor` |
| `status` | Each status accepts `Foreground`, `Background` and `Border` suffixes |
| `pr` | `open`, `draft`, `blocked`, `merged`, `closed` |
| `chat` | `userMessageBackground`, `divider`, legacy `background` used as the inline-code background fallback |
| `markdown` | `link`, `linkHover`, `inlineCode`, `inlineCodeBackground`, `blockquote`, `blockquoteBorder`, `listMarker`, `bold`, `italic`, `strikethrough`, `hr` |
| `tools` | `border`, `icon`, `title`, `description`; `edit` accepts `addedBackground`, `removedBackground`, `modifiedBackground`, `lineNumber` |

`syntax.base.background` and `foreground` inherit the main canvas and text. Choose a code background close to `surface.background` for a subtle separation. Code surfaces render that color directly, without an automatic blend with the canvas. `syntax.highlights` accepts `diffAdded`, `diffRemoved`, `diffModified`, their `Background` variants, `lineNumber` and `lineNumberActive`. Diff backgrounds inherit their corresponding diff color at a low opacity.

`syntax.tokens` contains exceptions to the shared mapping. `method` and `functionCall` inherit `base.function`; `class`, `struct` and `enum` inherit `className`, which defaults to `base.type`; `key` and `tagAttribute` inherit `variableProperty`. For distinct class and property colors, only those two overrides are needed.

Built-in JSON files in `packages/ui/src/lib/theme/themes/` show the supported overrides. The full syntax mapping is in `packages/ui/src/lib/theme/syntax.ts`.

Optional `config.fonts` accepts `sans`, `mono` and `heading`. Optional `config.transitions` accepts `fast`, `normal` and `slow` CSS transition values.

## Existing themes

Expanded theme files still load. Explicit supported overrides win over defaults. Retired fields, including Markdown heading colors, unused chat text colors and unused component sections, are ignored. Markdown headings in the file editor use the syntax foreground.

Malformed themes are skipped without dropping valid siblings. A file must be no larger than 512 KiB. Duplicate IDs in the custom directory are skipped; a custom theme may override a built-in theme with the same ID.

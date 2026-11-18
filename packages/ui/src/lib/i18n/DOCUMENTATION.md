# Locale runtime and text direction

## Ownership

This module owns locale selection, message formatting, locale loading and shared direction helpers. Message catalogs own translated strings; components own the layout that consumes the current direction.

## Invariants

- The active locale sets document direction and the Base UI direction provider because menus and sliders read provider state independently of the document. Physical OS window controls retain their edge through logical mapping.
- Element direction reads the nearest explicit `dir` attribute so older WebKit can use the same contract without unsupported selector syntax. Retired Hebrew locale `iw` normalizes to the supported locale, and host language applies before a user choice.
- Inserted string values use Unicode first-strong isolation only where RTL text and letters require it, preventing reordering without adding invisible characters to ordinary LTR or numeric values. Numbers retain numeric formatting behavior instead of string isolation.
- Prose direction counts words instead of letters so long quoted Latin terms do not override RTL prose; ties favor RTL, and inline code and URLs do not count. This avoids first-letter direction errors for paragraphs beginning with a product name.
- Numeric display uses Western digits alongside code, token counts and identifiers.

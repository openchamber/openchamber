# Locale runtime and text direction

## Ownership

This module owns locale selection, message formatting, locale loading and shared direction helpers. Message catalogs own translated strings; components own the layout that consumes the current direction.

## Invariants

- The active locale sets document direction and the Base UI direction provider because menus and sliders read provider state independently of the document. Physical OS window controls retain their edge through logical mapping.
- A pending locale keeps the current text, direction and saved choice. Only the latest successful load updates the active locale and dictionary together. Appearance saves the shared profile choice after that load succeeds. Startup that finds its locale already active writes no browser preference, so a later host language still applies. The native menu and tray receive the locale only once no dictionary load is pending.
- Element direction reads the nearest explicit `dir` attribute so older WebKit can use the same contract without unsupported selector syntax. Retired Hebrew locale `iw` normalizes to the supported locale, and host language applies before a user choice.
- Inserted string values use Unicode first-strong isolation only where RTL text and letters require it, preventing reordering without adding invisible characters to ordinary LTR or numeric values. Numbers retain numeric formatting behavior instead of string isolation.
- Prose direction counts words instead of letters so long quoted Latin terms do not override RTL prose; ties favor RTL, and inline code and URLs do not count. This avoids first-letter direction errors for paragraphs beginning with a product name.
- Numeric display uses Western digits alongside code, token counts and identifiers.

## Decisions

### Why the browser's language is only a startup fallback

The browser's saved language gives a working fallback when the shared profile's dictionary cannot load. The profile language does not wait for it: a profile locale that loads takes effect even while the startup dictionary is still pending, and a startup load that finishes after it is discarded. A profile locale that fails to load leaves the startup locale to finish. A successful picker choice takes precedence over overlapping restores. A failed choice leaves those restores eligible to finish, and a restore waiting on a picker request rechecks as soon as that request is replaced or settles, so an abandoned fetch cannot hold a loaded profile dictionary. A request from a retired runtime cannot change the active language or the browser's saved choice. The registry forwards even a profile locale that matches the active one so it can supersede an older profile load.

# Usage provider client

## Ownership

This module owns usage-provider parsing, bounded quota reads, model-family defaults and compact display formatting. The server owns credentials and upstream usage requests.

## Invariants

- An unknown authenticated-provider inventory triggers reads of every provider because unknown does not prove absence. Deadlines cover response bodies and transports that ignore abort, preventing one preliminary inventory from blocking every quota result.
- Extension-provider lists are accepted whole or fail whole so malformed data cannot silently hide a provider. Supported names and icons match manifest parsing, and built-ins precede extension entries in server order.
- Gemini defaults recognize launch IDs and dotted or hyphenated minor versions, while earlier generations and embedding aliases stay out. Anthropic reports only models with plan limits, and Zen reports models actually served, so every reported model remains enabled by default.
- Narrow reset and usage labels retain the full value in tooltips. Missing grant type stays omitted on the wire so the server applies its `GLOBAL` default.
- Spending amounts cross the wire as structured values and are formatted as money and labels in the active locale. An amount the server could not read stays visibly unknown; it never becomes zero.
- Both compact selectors take OpenRouter's cap keys and fallback row from `openRouterSpendSelection` in `windowKeys.ts`, so a cap whose spent amount is unknown still ranks ahead of the monthly total. It returns null for every other provider: the quota SDK lets an extension name a window `monthly_total`, and that window keeps the generic selection. No surface finds that row by its translated label or provider name.
- Reset labels keep their absolute form as the fallback: a relative countdown exists only for a reset still in the future, and a passed or missing timestamp always reads as the clock time. Callers that show the countdown re-render it on the shared minute ticker.

## Decisions

### Why a relative reset label keeps the clock time behind it

A countdown answers "how long is left", which is what a person watching a limit asks; the clock time answers "when exactly", which is harder to plan around but is what the app showed before. The setting picks which one leads, and the absolute label stays the fallback: a reset in the past, or one without a timestamp, has no countdown to show, so the row keeps the clock time instead of counting negative. The work status tooltip keeps the full absolute label even in relative mode, so the exact moment is never lost. The countdown rebuilds on the shared minute ticker rather than a second-level one: the labels are read in passing, and a per-second re-render of every usage row buys nothing the minute cannot say.

### Why Claude reset labels round to the nearest minute

Claude can report a reset a second before the minute boundary. Truncating seconds makes the label jump back by a minute. Round only the display time so the provider timestamp stays intact. The short label keeps the clock through the 7-day cutoff minute so rounding does not hide it early. A reset that already passed is not rounded, so one a few seconds before midnight never reads as the upcoming one.

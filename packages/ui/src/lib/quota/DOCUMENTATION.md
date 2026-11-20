# Usage provider client

## Ownership

This module owns usage-provider parsing, bounded quota reads, model-family defaults and compact display formatting. The server owns credentials and upstream usage requests.

## Invariants

- An unknown authenticated-provider inventory triggers reads of every provider because unknown does not prove absence. Deadlines cover response bodies and transports that ignore abort, preventing one preliminary inventory from blocking every quota result.
- Extension-provider lists are accepted whole or fail whole so malformed data cannot silently hide a provider. Supported names and icons match manifest parsing, and built-ins precede extension entries in server order.
- Gemini defaults recognize launch IDs and dotted or hyphenated minor versions, while earlier generations and embedding aliases stay out. Anthropic reports only models with plan limits, and Zen reports models actually served, so every reported model remains enabled by default.
- Narrow reset and usage labels retain the full value in tooltips. Missing grant type stays omitted on the wire so the server applies its `GLOBAL` default.

## Decisions

### Why Claude reset labels round to the nearest minute

Claude can report a reset a second before the minute boundary. Truncating seconds makes the label jump back by a minute. Round only the display time so the provider timestamp stays intact. The short label keeps the clock through the 7-day cutoff minute so rounding does not hide it early. A reset that already passed is not rounded, so one a few seconds before midnight never reads as the upcoming one.

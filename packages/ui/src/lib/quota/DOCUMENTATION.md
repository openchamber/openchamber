# Usage provider client

## Ownership

This module owns usage-provider parsing, bounded quota reads, model-family defaults and compact display formatting. The server owns credentials and upstream usage requests.

## Invariants

- An unknown authenticated-provider inventory triggers reads of every provider because unknown does not prove absence. Deadlines cover response bodies and transports that ignore abort, preventing one preliminary inventory from blocking every quota result.
- Extension-provider lists are accepted whole or fail whole so malformed data cannot silently hide a provider. Supported names and icons match manifest parsing, and built-ins precede extension entries in server order.
- Gemini defaults recognize launch IDs and dotted or hyphenated minor versions, while earlier generations and embedding aliases stay out. Anthropic reports only models with plan limits, and Zen reports models actually served, so every reported model remains enabled by default.
- Narrow reset and usage labels retain the full value in tooltips. Missing grant type stays omitted on the wire so the server applies its `GLOBAL` default.

# Notification channel client

## Ownership

This module owns extension notification-channel response parsing and connection requests. The server owns tokens and delivery.

## Invariants

- Credentials are sent only to connect and never returned in listings. Invalid rows drop independently, an unreadable envelope returns null, and failed loads stay distinct from an authoritative empty channel list.

# Notification channel client

## Ownership

This module owns extension notification-channel response parsing and connection requests, and the notification wire contract (`wire.ts`): the payload a delivered notification carries, the `OpenchamberNotification` the event stream delivers, and its schema. The server owns tokens and delivery.

## Invariants

- A notification names its session and, when it announces one reply (turn complete, error), that reply in `messageId`; a click opens the reply instead of the end of the transcript. A missing or malformed id leaves the plain session target.
- Credentials are sent only to connect and never returned in listings. Invalid rows drop independently, an unreadable envelope returns null, and failed loads stay distinct from an authoritative empty channel list.

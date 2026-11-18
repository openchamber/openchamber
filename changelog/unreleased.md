---
title: Accounts wait out their limits
---

## App

### New
- **Session account:** a session can stay on one provider account. Preferred starts each turn there and moves when that account's limit is hit. Fixed stays there, and a limit waits for the reset instead of moving the session.

### Improvements
- Settings/Providers: each Claude account shows its 5-hour, weekly and per-model usage, and until when an exhausted one comes back.

### Fixes
- Chat: hitting Claude's Fable limit moves the session to an account that still has Fable, instead of stopping while other accounts are free.
- Chat: a GLM 5-hour limit waits until the time named in the error and continues, instead of stopping the turn.

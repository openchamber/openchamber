# Overview classification

## Ownership

This module owns pure classification of session and worktree facts for the overview. Stores and callers supply live activity and remote issue and change-request state.

## Invariants

- Live work and requests for user input always remain visible. Other unread outcomes are followed only while in work or within the recent-session window when In work is off, preventing every old unread conversation from waiting on the user forever.
- A merged change request closes work only when no related request remains open or unknown. Linked issues settle only when none remains open or unknown; any completed issue means done, while all cancelled or unplanned issues mean dropped.
- Btw side questions belong to their parent session. A done signal with a veto remains excluded from bulk Done, and a failed scheduled run remains visible even outside ordinary follow membership.
- Worktree removal requires known Git evidence and no live use. Unknown losses or change-request state cannot justify removal; a merged request's final commit bounds later work, and active sessions or the directory on screen keep the checkout in use.

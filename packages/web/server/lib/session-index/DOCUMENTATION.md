# Session Index Runtime

Electron injects `session-index.sqlite` into the in-process OpenChamber Web
Server. `service.js` exclusively owns the WAL database and stores at most the
newest 20 root-session summaries per runtime and directory. It never stores
messages, attachments, permissions, provider data, or model metadata.

`sync-runtime.js` owns cold-start synchronization. The renderer submits all
known project directories once to `POST /api/openchamber/session-index/sync`.
The runtime processes them sequentially, applies `start=lastSyncedAt` for recent
indexes, performs a full reconciliation after 24 hours, and commits each result
to SQLite. It publishes an in-memory revision after every state/SQLite change.

The renderer observes revisions with
`GET /api/openchamber/session-index/changes?since=<revision>`. This is a bounded
25-second long poll, not an SSE/WebSocket. Responses contain the current full
summary snapshot and aggregate progress, so reconnecting never needs an event
replay log.

The OpenCode proxy calls `noteInteractiveRequest()` for selected-session reads
and mutations. That aborts the current background list, yields for one second,
then resumes the same directory. Consequently a startup index refresh cannot
sit ahead of conversation content or user actions.

Non-Electron runtimes receive deterministic `501 unsupported` responses and
retain their existing SDK-backed in-memory loading path.

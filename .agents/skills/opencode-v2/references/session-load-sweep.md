# Measuring session loads on the live managed server

Times session reads on real data, the way the UI makes them. Done when every
session in the sweep has its timings next to its message counts.

1. **Reach the server.** The port is in `ps` (`opencode serve --hostname
   127.0.0.1 --port N`); Basic auth user `opencode`, password
   `$OPENCODE_PASSWORD` from the agent shell.
2. **Read what the UI reads:** `GET /api/session/:id`,
   `GET /api/session/:id/message?limit=100` (the client's page size;
   OpenCode's default is 50, the maximum 200) and
   `GET /api/session?parentID=<id>`. These carry no location middleware, so a
   sweep over every session starts no MCP servers. Re-check
   `protocol/src/api.ts` and `groups/session.ts` / `groups/message.ts` on a
   newer tag first: a route that gains the middleware turns the sweep into one
   MCP fleet per directory.
3. **Counts** come from the `session_v2` and `session_message` tables in
   OpenCode's database (`~/.local/share/opencode/opencode.db`), opened with
   `sqlite3 -readonly`. 2.x has no todo route, so per-session task counts are
   not available.
4. **Cold versus warm.** The count queries read whole tables and warm the OS
   file cache, so timings after them are warm reads. A cold read needs a
   reboot or `sudo purge` first.

Sweep sequentially. A full sweep raises the server's RSS for a few minutes
(it more than doubled on a 10 GB database), then it falls back.

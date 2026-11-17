# Usage reports

## Ownership

This module owns Stats page presentation, calendar-range calculations and the
in-memory report cache. `lib/opencode/session-stats` owns report requests and
OpenCode project-ID resolution.

## Invariants

- Range boundaries and chart buckets use the viewer's local calendar and the
  time zone sent with the request. A 7-day range includes today and the preceding
  6 days. The report's `to` boundary is exclusive; `all` leaves the start unset
  so OpenCode uses the oldest message.
- The activity series fills inactive calendar days with zero steps because
  OpenCode supplies only active days. Missing days remain visible as gaps.
- Cached reports belong to their runtime, range and project directory. A result
  commits only to the key it starts under. Runtime reset clears entries and
  aborts outstanding reads so a previous runtime cannot repopulate the cache.
- A failed report refresh retains the last successful report and exposes the
  error. Project-ID lookup failure remains an error for that project; it never
  becomes an unfiltered report or an empty success. Tool-read failure likewise
  remains distinct from a successful zero-call result.
- `fetchedAt` records request start, so a read crossing midnight belongs to the
  earlier day. An expired Today report and its tools are dropped before the next
  read, so yesterday's totals cannot appear under Today even if that read fails.
  Replaced tool reads cannot overwrite the new day's tools.
- The report-loading layout effect removes expired Today data before paint.
  Its entry dependency also reloads the selection after a runtime reset.
- Once tool calls are requested, subsequent loaded reports and revisited cached
  reports load their tools for the rest of the app session. Tool requests use the
  loaded report's exact window so their counts match its totals.
- Token composition retains zero-valued segments to keep legend order stable;
  only the rendered bar omits them. Output includes reasoning as model production.
- Activity time runs left to right in every language because tooltip placement
  and keyboard navigation both measure from the left.

## Decisions

### Why cached snapshots and not automatic rolling refreshes

Reopening the page or returning to a filter reuses its app-session snapshot;
the report window and fetch time describe that snapshot. Refresh forces a new
read, and Today alone expires automatically because its label promises the
current local day.

### Why clock checks and not a timer aimed at midnight

Today checks the local date periodically and when the document becomes visible
so sleep and daylight-saving changes do not leave an expired report on screen.
Checks within the same day reuse the report without a network read.

### Why tool counts load on request

Counting tools makes OpenCode read every tool call in the report window.
Deferring that work keeps the initial report read smaller.

### Why weekly buckets and not unlimited daily bars

Ranges beyond 92 days group consecutive days into weeks so bars stay readable.
Today omits the activity chart, active days and streak because they collapse
to a single bar and values of 0 or 1.

### Why a short tool list and compact phone model rows

Tool details keep the first 8 active rows from OpenCode's call-ranked result so
the page stays small. Phone model rows reserve text space for the model name;
the provider logo identifies the provider there.

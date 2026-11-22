# Design screenshots

## Ownership

`shots.mjs` captures a fixed set of desktop web screens, in the default dark and
light themes, for design review: `node scripts/design/shots.mjs --label <name>`
writes `tmp/ui-shots/<label>/<dark|light>/<nn-name>.png` and a `manifest.json`.
It owns the scratch state under `tmp/ui-shots` (`state/`, `seed/`, `project/`)
and the order and setup of each shot.

It reuses the perf stand: `scripts/perf/isolated-server.mjs` for the server and
the fixture provider, `scripts/perf/cdp.mjs` for Chrome, and
`scripts/perf/fixture-conversations.mjs` for the seeded conversations and the
scratch project's files. The isolation rules in `scripts/perf/DOCUMENTATION.md`
(*Running An Isolated Copy*) apply.

## Invariants

- Two runs of the same build on the same day produce the same pixels, apart
  from rasterization noise in blurred backdrops (a few pixels off by one level).
- Nothing touches the user's `~/.config/openchamber`, OpenCode data or git
  config; ports are picked free on every run.
- Every process the run starts (fixture, server and its OpenCode, Chrome) is
  stopped on exit, failure and Ctrl-C included.
- A shot is taken only once the page is still: fonts loaded, no finite
  animation running, no loading indicator or "Loading..." text in view, no
  layout change for a few frames and no data request in flight. A shot that
  times out waiting is still written and marked `settled: false` in the
  manifest.
- Shots drive the UI as a user does: pointer, keyboard shortcuts and URL
  routes, through attributes the app already has.

## Decisions

### Why the seed is cached and the times are stamped on every run

Seeding replays fifteen sessions through OpenCode, which takes about a minute,
so the resulting state is copied to `seed/` and restored on later runs; its key
covers the conversations, the project files, the fixture and the server setup.
Seeding runs at fixture speed, so every session would read "now" and every turn
"0s". After each restore the run rewrites the timestamps in OpenCode's database
relative to a fixed moment, which keeps relative ages and turn durations the
same on every run without reseeding.

### Why the page clock is fixed and Math.random is seeded

The draft screen's greeting depends on the time of day and a random pick. The
page starts its clock at the latest 08:42 UTC before the real time and uses a
seeded generator for `Math.random`. The fixed moment is never in the future,
so the server never sees timestamps ahead of its own clock; the cost is that
dates follow the calendar day of the run.

### Why model fetching is off and the providers are real ones

The model picker should show names a reviewer recognises. The scratch
project's `opencode.json` points the real Anthropic, OpenAI and Google provider
IDs at the fixture provider, and `OPENCODE_DISABLE_MODELS_FETCH=1` makes
OpenCode list the catalog bundled with its binary, so the picker changes only
when the OpenCode version does. The fixture's own rate-named provider is
disabled for this project.

### Why only data requests count toward a still page

Chrome reports the web app manifest and web worker scripts as requests that
never finish in the page, and event streams stay open for the page's lifetime.
The wait counts Fetch, XHR and font requests, skips the manifest, and drops a
request once its response turns out to be an event stream.

### Why the set has a panel with tiles

`13-context` opens the context panel's session context, whose stat cards and
Session Totals are tiles on a docked panel. A tile stands off its parent by a
text-colour tone step, so a panel fill that spends the same step makes them
vanish; that went unnoticed while no shot held a panel with tiles in it. Keep
one such shot in the set.

### Why 02-chat types into the composer

Every other shot leaves the composer empty, which only ever shows Send
disabled. `02-chat` types a few words (not sent) so the set holds the enabled
Send, and clears them after its screenshot: the composer keeps a draft per
session, and the later shots in the same browser context must see it empty.
`01-draft` keeps the disabled state.

### Why the seed turns Thinking rows on

A new OpenChamber profile starts with thinking rows off, so no shot showed one
and the transcript's quietest row went unreviewed. The scratch settings turn
them on, and the main session's fix turn scripts two steps that think before
they call tools (`reasoning` on a step in `fixture-conversations.mjs`, sent
as `reasoning_content` by the fixture provider), so `03-chat-tools` shows
Thinking rows between tool rows.

### Why 02-chat stubs usage, and 14 squeezes the composer

The fixture has no provider accounts, so the Session card never showed its
Usage section. `02-chat` answers the quota routes in the page
(`usageStubScript`, added for that shot only and removed after it): Claude and
Codex with their limits, Claude's weekly one in the warning band, and an
OpenRouter count that is not a limit. The page's own fetch bridge wraps
`window.fetch` as it loads, so the stub wraps every fetch the page installs.

`14-composer-narrow` closes the sidebar and opens the Git panel beside the
chat at a 1000px window, which leaves the composer about 288px wide: the
footer's model name and agent label have given way to the provider logo with
its thinking level ("/ default"), the agent's icon, the mic and Send.

### Why 15-first-run has a server of its own

`15-first-run` shows the app as a brand-new install meets it: no projects, no
sessions, no chats. It cannot share the seeded server, so it starts its own on
an empty state (`tmp/ui-shots/first-run-state`, emptied on every run), with no
project directory and no settings written, the server started from that empty
home (`startIsolatedServer` with `project: null`). Nothing is added to make it
look populated. It runs only when asked for and on its own
(`--only 15`); the default set leaves it out. The fixture provider is still
the configured model, so the composer names it; that is the harness, not the
product. The web app has no onboarding screen of its own (the first-launch
chooser belongs to the desktop shell), so there is no separate shot of a
dismissed onboarding.


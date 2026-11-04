# Markdown file references

## Ownership

The shared renderer classifies and confirms local references before opening them through the active runtime's file viewer or editor. Filesystem access and authorization remain with the runtime adapters.

## Invariants

- Ordinary link hrefs are percent-decoded once. Inline code, fenced code, and path-looking link labels remain literal paths.
- Reference suffixes are parsed before ordinary href paths are decoded. Encoded filename characters do not become line references or anchors.
- Confirmation and clicks use the same input kind. Confirmation results distinguish hrefs from literal paths and retain directory/runtime scope.
- Existing file-URL handling, file classification, and final-path containment checks remain in place.
- Ordinary local hrefs bypass prose-only filename filters. External schemes and protocol-relative URLs are rejected before decoding.
- Encoded edge spaces remain part of the filename during resolution, existence checks, and file-tab navigation.

## Decisions

### Why explicit href input and not decoding every reference

The same resolver receives URLs and native path text. Explicit input kinds preserve a native filename such as `50%25off.md` while resolving the href `50%25off.md` to `50%off.md`.

### Why suffix parsing precedes ordinary href decoding

A literal `#L12` suffix denotes a line reference, while `%23L12` can belong to a filename. Decoding first loses that distinction and can select the wrong file.

### Why explicit local hrefs bypass prose filters

A link target can contain repeated spaces, angle brackets, or encoded `://` in its local path. Prose filters would reject these filenames and let the browser open a new tab. Scheme checks run on the encoded target so external URLs remain external.

### Why decoded href paths preserve whitespace

Text references are trimmed as prose, but an href's encoded edge spaces identify a different file. Href resolution opts out of trimming, and stat checks and absolute file-tab targets retain those spaces.

# Commands run from a reply

## Ownership

A `bash`, `sh`, `shell` or `zsh` fence in a finished assistant reply has a run button (`MarkdownCode`, and `ReplyCommand.tsx` loaded with the first such block, so the session sync stays out of the Markdown renderer). `@/lib/opencode/reply-command` owns the messages a run adds to the transcript and how to read them back; `@/sync/reply-commands` starts a run and watches it. OpenCode runs the command through `session.shell`, the route of `!command`, in the session's own directory and shell.

## Invariants

- A run takes three synthetic messages around OpenCode's shell message, all hidden from the timeline: the note (`openchamberReplyCommand`), OpenCode's completion, and the continuation with `resume: true`. The note carries the reply, the command and both client-minted ids.
- The note is the only link from a block to its run. A block finds its run in the transcript, so its output and status survive a reload and show in every client.
- The agent is continued once per run. The continuation id is fixed at the click, so a second client is refused as a repeat.
- A continuation goes out only after OpenCode's completion message, so the output is in context first. A command the user stopped gets none.
- A run started here is watched from the event stream, because its block can scroll away or its session can close. After a reload the block continues any run still owed one.
- The block shows the run instead of the shell row. A run whose reply is outside the loaded history keeps its row (`dropReplyCommandRows`).

## Decisions

### Why a note in the transcript and not matching by command text

`session.shell` takes no metadata, and a typed `!ls` after a reply that suggested `ls` would look the same as a click, so it would lose its row and wake the agent. A note costs one line of context and is what OpenCode stores.

### Why the client continues the agent and not the server

The VS Code extension has no OpenChamber server, and a server runtime would need its own persistence and delivery loop (`dispatch-results`) for what the event stream and the block already cover. Nothing continues the agent while no client is open; the block does it when the session is next opened.

### Why the output is drawn like a shell tool row

The tool row is the one place that already turns terminal bytes into text (`renderTerminalOutput`: colour codes, `\r` progress lines) and highlights a settled output as `bash`, so a block and a row read the same. While the command runs the block stays plain, because each poll would highlight again.

### Why the output of a stopped command comes from the live view

OpenCode drops the output when the shell is removed and records "output is no longer available". The block keeps what it had read, and after a reload shows the status alone.

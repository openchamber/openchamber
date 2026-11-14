# Desktop app memory

How to read the memory of the installed desktop app, why the figure a user sees follows the heap's peak, and what is known to hold or move it.

Sections: *Read the processes*, *The figure follows the peak*, *What the JS heaps hold*, *V8 flags*, *GPU process*, *Measuring a change*, *Reference figures*.

## Read the processes

Start the installed app with `open -a OpenChamber --args --remote-debugging-port=9339 --inspect=127.0.0.1:9229`: the window answers CDP on the first port, the main process (Node, with the server in it) on the second.

- `footprint -p <pid>` is the figure Activity Monitor shows. `ps` RSS understates it several times.
- In `footprint`, `App-Specific Tag 16` is V8 plus Blink's GC heap (Oilpan), `Tag 14` is PartitionAlloc (malloc, strings, vectors), and in the GPU helper `IOSurface` is tiles and compositor buffers.
- `vmmap <pid>` splits Tag 16 by region. `rw-` regions in the 4 GB cage are the JS heap, a second `rw-` group of 128 KB regions is Oilpan, `rwx` is machine code, and `---` regions are pages V8 gave back.
- A memory-infra dump (`Tracing.requestMemoryDump`, category `disabled-by-default-memory-infra`, on the browser target) names the rest: `v8/main/heap/*` per space, `blink_gc`, `malloc`, `gpu/shared_images/*` with each surface's size and usage.
- `Runtime.getHeapUsage` (window) and `process.memoryUsage()` (main, through the inspector) give the live heap without a snapshot.

Never send `Memory.forciblyPurgeJavaScriptMemory` to the window: it destroys the page's JS context and the window needs a reload.

## The figure follows the peak

On a machine that swaps, the footprint of both V8 processes tracks the largest heap they ever had, and a heap snapshot explains about half of it.

macOS compresses pages nobody touched for a few seconds once free memory is short. V8 returns heap pages with `MADV_FREE_REUSABLE`, which releases a resident page and leaves a compressed one charged to the process. `vmmap` shows the result as `---` regions with `swapped` bytes: 50 to 70 MB in the window and about 30 MB in the main process right after startup. The pages are released only when V8 reuses that address range and frees it again while resident.

A peak that ends within seconds leaves little behind, because its pages are still resident when V8 frees them: the main process peaks at about 325 MB while the server loads and reads about 160 MB a minute later, and the window's heap reaches 184 MB in its first three seconds and settles at 92 MB. What stays charged is what was freed after sitting untouched, such as the heap grown by a long agent turn.

So a change that lowers the live heap and leaves the peak alone moves the figure little. Lower the peak: allocate less in bursts at startup, on a session switch and while a reply streams, and keep the young generation small (*V8 flags*).

## What the JS heaps hold

Group a heap snapshot by constructor together with its property names, and strings by the property that references them. Dominator trees attribute almost nothing here, because module scopes own everything.

- **zod schemas.** The app builds about 10,000 schemas in each process. The zod release in use keeps methods on the prototype (about 1.2 KB a schema); one release earlier each schema carried a hundred closures of its own, 11 KB, which was 30 to 60 MB per process. `packages/ui/src/lib/zodContract.test.ts` fails if a bump brings that back. The bump carries `bun-patches/zod@*.patch`: zod 4.4 and later reject an absent object key whose schema accepts `undefined` (`z.unknown()`, `z.undefined()`, a union with it), the app's schemas were written against the earlier rule, and the patch keeps it. Carry the patch over on the next bump, or add `.optional()` to every such field and drop it.
- **Per-session fields in the session list.** Every field of every session is parsed and kept in the window, and re-serialized in the main process on each list request. `sanitizeSessionListItem` (`packages/web/server/lib/opencode/proxy.js`) is the gate, including keys retired from `metadata.openchamber` that old sessions still store.
- **Script text.** The main process loads about 1,300 unbundled modules and keeps their sources, 22 MB, of which about 6 MB is the two-byte penalty for files with one character above U+00FF (`main.mjs` alone 1.4 MB). The web build escapes such chunks; the packaged server and the main bundle do not yet.
- **Compiled code.** About a third of the window's heap. Sparkplug's baseline code was 14 of its 18 MB of machine code (*V8 flags*).
- **Unused code is cheap.** Of 12.9 MB of script text the window loads at startup, 7.3 MB is in functions that ran (precise coverage over a reload). Functions that never ran are not compiled, so splitting the startup chunks further could return at most the 5.6 MB of text and its copy in Blink's resource cache.

Outside the JS heaps, the main process holds about 50 MB of `malloc` objects and the window about 58 MB of `malloc` and 60 MB of PartitionAlloc (32 MB of it string and buffer data, 24 MB the resource cache's script bytes). A memory-infra dump does not attribute them further.

## V8 flags

`packages/electron/entry.mjs` appends `js-flags` for renderers; a `--js-flags` on the command line replaces it, which is how other values are measured on the installed app.

- `--max-semi-space-size=4` is set. The default young generation grows to 64 MB under churn. With the cap the window read about 300 MB after an agent turn against about 370 MB, its peak 80 MB lower, and streaming main-thread time and session-switch time were unchanged on the stand.
- `--no-sparkplug` is not set. It took the window's machine code from 18 MB to 4 MB and its footprint down by about 29 MB, for about 2% more main-thread time while streaming and 4 ms on a session switch.
- `--optimize-for-size` lowers the peaks further and costs about 38% more renderer CPU.
- The main process takes V8 flags only from its real command line. `v8.setFlagsFromString` after startup does not change the young generation's limit, and packaged Electron ignores `NODE_OPTIONS` for it.
- `v8.setFlagsFromString('--semi-space-growth-factor=1')` at the top of the entry module does hold the main process's young generation at 2 MB, and is not set. The young generation there grows to 58 MB while the server loads and V8 shrinks it by itself about 30 s later, while the pages are still resident, so the idle figure is the same either way (about 160 MB). With the flag the process ran 435 scavenges during startup against 20 and promoted 25 MB more into the old generation.

To put the same flags in the stand's Chrome, pass `--chrome` a wrapper script that execs Chrome with `--js-flags=...` in front of its arguments.

## GPU process

At a 1904x968 window on a 2x display the GPU helper holds about 210 MB of surfaces when idle: three window-sized compositor buffers (84 MB), the root layer's tiles (30 MB), and one set of tiles per composited layer on top.

- Every composited layer adds tiles for the screen area it covers, so a layer that only repeats what its scroller already paints is pure cost. Messages once carried `translateZ(0)`, a layer each, about 10 MB for a screen of chat.
- `mask-image` on a scroller (a scroll shadow) costs a render pass texture the size of the scroller plus its tiles, about 15 MB for the session sidebar. A scroller on an opaque surface draws its fades as gradient bands instead (`surface` on `ScrollShadow`, `scrollShadowSurface` on `ScrollableOverlay`), as the transcript, the sidebar, the Git panel and the docked work status panel do. Scrollers on glass or on a translucent tile (popups, tool output, reasoning) keep the mask, because no single colour is behind them.
- Virtual rows positioned with `transform` become a layer each when they overlap something composited: 143 layers with the file tree open against about 50 without.
- Surfaces left from a transition (a reload, a session switch, a menu with a backdrop filter) are freed about 20 s after the last frame, so read the idle figure after that. During a session switch the helper peaks at 450 to 600 MB.

List layers with `LayerTree.enable` and `LayerTree.compositingReasons`; the layer tree is reported only on a change, so nudge the page (append and remove a 1 px element). Find what a surface is for by injecting a stylesheet that removes one property (`border-radius`, `mask`, `backdrop-filter`, a transform) and reading `gpu/shared_images` again.

## Measuring a change

- Compare builds on the installed app with the same script each time: quit, launch, wait 60 s, run the workload, wait 120 s, then read `footprint` of the three processes, `phys_footprint_peak` and CPU time. Startup alone varies by 30 to 50 MB between launches because of the compressed pages, so run each side at least twice.
- A workload of real clicks on sidebar rows (`Input.dispatchMouseEvent`) exercises session switching. For an agent turn, create a session on a cheap model with the `plan` agent through the managed OpenCode (`POST /api/session`, then `/api/session/:id/prompt`), open it in the window, and wait for the `idle` message.
- When matching processes with `ps`, anchor on the executable path at the start of the command: a shell whose command line quotes the app's path matches a loose pattern and reads as a 2 MB process.
- Startup allocations of the main process: launch with `--inspect-brk=127.0.0.1:9229`, start `HeapProfiler.startSampling` with both `includeObjectsCollectedBy*GC` flags, then `Runtime.runIfWaitingForDebugger`.

## Reference figures

What the installed app read in November 2026, before and after the memory work of that month, to compare a later build against. `footprint` in MB on an Apple Silicon Mac that swaps, a 1904x968 window on a 2x display, a profile with over 2,000 sessions.

| Process | Before, 3 min after launch | After, 3 min after launch | After, following an agent turn |
|---|---|---|---|
| Window | 407 | 264 to 277 | 307 |
| Main | 268 | 156 to 178 | 171 |
| GPU helper | 285 | 104 to 160 | 243 to 267 |

Window and main together went from 675 to about 440 at idle. The GPU helper's figure moves by 100 MB and more with what was on screen in the last 20 s, so compare its idle surfaces instead: about 210 MB before, about 157 MB after. In Activity Monitor on the same machine, in daily use:

| Process | Before any memory work | After the allocation work, before the changes above | After, with an agent working |
|---|---|---|---|
| Window | 480 to 690 | 533 | 344 |
| Main | 225 | 329 | 167 |
| GPU helper | 270 to 410 | 269 | 243 |

The middle column follows the earlier pass that cut what the window allocates during an agent turn (2.55 GB to 0.43 GB on the stand with 3,763 sessions, peak JS heap 323 to 357 MB down to 145 to 150 MB). It lowered CPU and peaks, and the held figure barely moved until the changes below.

What each change returned:

| Change | Process | Returned |
|---|---|---|
| zod 4.3.6 to 4.6.7 (methods on the prototype) | window and main | 141 MB at startup |
| `--max-semi-space-size=4` | window | about 70 MB after an agent turn (370 to 300) |
| Retired `knowledge_context_delivered` key dropped from the session list | window | 7.5 MB of live heap |
| No `translateZ(0)` layer per message | GPU | about 10 MB |
| Scroll fades as bands in the sidebar, Git panel and docked work status panel | GPU | about 15 MB |

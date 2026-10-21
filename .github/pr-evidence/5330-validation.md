# File-reference detector evidence

## Probe rules and click rules

Shared chat rendering in `packages/ui` probes fewer candidate strings for #2096. Automatic annotation rejects paths containing `@` and extensions whose first character is a digit, `_`, or `-`. Inline code and fenced-code tokens lose automatic file treatment when rejected. Markdown anchors also skip these probes and annotations, but their existing hrefs remain clickable.

The click guard retains the pre-PR extension regex, `/\.[A-Za-z0-9_-]{1,16}$/`, and accepts `@`. It issues no filesystem probes. Its href extraction, resolvability check and file-opening resolution use the click rules. This preserves the #3858 guard against `target="_blank"` navigation to bogus app routes, including on mobile. Probe and click checks share path parsing, known basenames and resolution code through an explicit purpose parameter.

Relative and absolute paths, names with spaces, dotfiles, `.frag2` and `.d-ts` remain probe candidates. The dotfile exception still accepts numeric suffixes. The cache, miss caching, request coalescing, concurrency cap, annotation limit and VS Code-specific limits are unchanged. No persisted data, request formats, filesystem permissions or writes change. Reverting the matching rules needs no data migration.

## Detector measurement

The original and changed probe predicates were extracted and compared over 18 inputs. All inputs already used forward slashes with no whitespace to trim. These numbers count predicate acceptance, before the existence probe, and say nothing about latency.

| Inputs | Original accepted | Changed accepted |
|---|---:|---:|
| `user@gmail.com`, `gpt-5.4`, `93.00`, `3.49s`, `v1.2.3`, `3.1.4` | 6 | 0 |
| `150.ms`, `accounts.google.com`, `client.messages.create`, `datetime.utcnow`, `log.transports.file.level` | 5 | 5 |
| `index.html`, `src/components/Foo.tsx`, `./README.md`, `/abs/path/file.ts`, `Dockerfile`, `.env`, `package.json` | 7 | 7 |

Accepted non-paths fell from 11 to 5 across the 18 inputs. The remaining 5 have letter-leading extensions and still reach the existence probe. Cache misses are reused, but new dotted identifiers and later cache eviction can cause more probes. Probe latency and the full #2096 request storm remain unmeasured. This patch does not bound requests across a conversation.

## Executable checks

Run from the repository root with Node 24.14.0 on PATH and Bun 1.4.3 available:

```sh
export PATH=/home/hermes/.local/lib/nodejs/node-v24.14.0-linux-x64/bin:$PATH
bun test packages/ui/src/components/chat/MarkdownRendererImpl.performance.test.tsx
bun test packages/ui/src/components/chat/MarkdownRendererImpl.test.ts
bun test packages/ui/src/components/chat/fileReferenceStat.test.ts
bun test packages/ui/src/components/chat/fileRefClickGuard.test.ts
bun run --cwd packages/ui type-check
git diff --check
```

The focused suites passed 20, 20, 3 and 11 tests respectively. UI type-check and `git diff --check` passed. The mounted-renderer tests use the existing happy-dom setup, mocked directory and filesystem responses, and the real private renderer helpers. They assert requests and annotation attributes for inline and fenced code.

The digit-leading-extension test reports `backup.7z`, `clip.3gp` and `data.001` as existing. Only an existing `.ts` control file receives a probe and annotation. Restoring the old extension regex made this test fail with 3 extra stat requests in the previous revision; the letter-first rule was restored afterward.

The click-guard test runs with both desktop and mobile annotation settings. `user@gmail.com` remains unprobed. Unannotated anchors for `backup.7z`, `icon@2x.png` and `file:///repo/data.001` retain `target="_blank"`; a primary click is canceled and dispatches the expected path to the mocked file viewer. Clicking adds no stat requests. The existing `.ts` control proves desktop annotation ran; mobile issues no probes. Both cases failed on `defaultPrevented=false` before the fix. After the fix, temporarily putting `isResolvable` back on probe rules reproduced both failures. The click rules were restored before the passing full focused run.

Earlier checks on this PR also found that the original detector failed the email-probe regression test. Temporary detector and screenshot-page scripts passed `node --check`; they are not committed. The earlier `check:changed` run passed type-check, lint and anti-slop checks, then failed dead-code checking on `provideLoginShellEnvSnapshot` in `packages/web/server/lib/opencode/login-shell-env.js`. That symbol was also unused on the clean base checkout. Those historical checks do not validate the latest revision. The web build and the live run below are from this revision; the full suite has not been rerun for this follow-up.

## Fixture render and screenshots

The renderer ran in happy-dom on Linux. Its mounted DOM was served to Chromium with the compiled repository stylesheet. The fixture reports `gpt-5.4` and `src/components/Foo.tsx` as existing, so file-link state is visible. The before copy restores the original detector's 2 lines; the after renderer uses the tightened probe rules. The original test file and renderer were unchanged when the screenshots were made.

| Width | Before | After |
|---|---|---|
| 1000 by 340 | [Before wide](5330-before-wide.png) | [After wide](5330-after-wide.png) |
| 390 by 340 | [Before narrow](5330-before-narrow.png) | [After narrow](5330-after-narrow.png) |

`gpt-5.4` loses its automatic file-link underline and file-opening behavior; the source path retains its link. A missing file already stayed plain after its probe, and now skips that probe. The captures use the same light CSS and show no color or layout change. They remain valid for these inline-code inputs after the click-guard follow-up, which changes explicit anchor clicks only. The follow-up has mounted-DOM click tests but no additional screenshots.

Those captures are still a fixture: a happy-dom mount of the real renderer, served to Chromium with the compiled repository stylesheet. The built app itself is exercised in the next section. Electron, VS Code, hosted-mobile and Capacitor navigation have not been exercised in their real runtimes.

## Built app live run

The web app was built and run, and the file-reference behaviour was observed in it.

Build and run, from the repository root:

```sh
export PATH=/home/hermes/.local/lib/nodejs/node-v24.14.0-linux-x64/bin:$PATH
bun run build:web                     # vite build of packages/ui into packages/web/dist
node packages/web/server/index.js --port 4531 --host 127.0.0.1
```

The server was started with an isolated data directory (`OPENCHAMBER_DATA_DIR`), an isolated `OPENCODE_HOST` and `OPENCODE_SKIP_START=true`, so the operator's own OpenChamber, OpenCode and ports were untouched. The OpenCode backend was a stand-in on `127.0.0.1:4530` that answered the session routes and served one session whose assistant message carries the tokens below; the workspace directory it named was a real directory on disk with real files, so the app's own filesystem routes, the file viewer and the click guard were the product's, not a fixture's.

The message text was:

```
These two must never be probed: `user@gmail.com` and `gpt-5.4`.

This real workspace path must still be probed and open: `src/components/Foo.tsx`.

An explicit markdown link must open through the viewer: [download](backup.7z)
```

Runtime: OpenChamber 2.5.0 served from `packages/web/dist`, Chromium 154.0.8037.0 (headless) on Linux x86_64, driven through Playwright. Requests were recorded from the browser itself.

What the app did:

| Observation | Result |
|---|---|
| `GET /api/fs/stat` probes | One: `?path=/tmp/opencode/5330-workspace/src/components/Foo.tsx&optional=true`. |
| Probe for `user@gmail.com` | None. |
| Probe for `gpt-5.4` | None. |
| Elements marked `data-openchamber-file-link` | One: `src/components/Foo.tsx`. |
| Click on the real path | `GET /api/fs/read?path=/tmp/opencode/5330-workspace/src/components/Foo.tsx`; the viewer showed the file's content. |
| Click on `[download](backup.7z)` | The anchor kept `target="_blank"`; the click was intercepted, the file viewer opened `backup.7z` (tab `backup.7z`, `7Z · 31 B`), and no new window opened. |
| Stat probes added by either click | None. The `backup.7z` stat calls the viewer makes itself carry no `optional=true` and are the file tree's own reads, not probes. |

The same harness was then run against the base commit `6491f51d`, built and served the same way, to show that the harness does see the probes the change removes:

| Base build `6491f51d` | This branch |
|---|---|
| 4 probes: `user@gmail.com`, `gpt-5.4`, `src/components/Foo.tsx`, `backup.7z` | 1 probe: `src/components/Foo.tsx` |
| 2 annotated file links: `src/components/Foo.tsx` and the `backup.7z` anchor | 1 annotated file link: `src/components/Foo.tsx` |
| Real path opens in the viewer; `[download](backup.7z)` opens in the viewer with no new window | Same |

The recorded browser requests for both runs are in [5330-live-run-requests.json](5330-live-run-requests.json).

The app's own markdown pipeline linkifies an address, so the `user@gmail.com` inside the inline code renders as a `mailto:` anchor rather than a code element; its text trims to `user@gmail.com`, which the old rules accepted as a path (`.com`) and the new probe rules reject on `@`. The detector saw it and issued no probe. The base build probed it, which is the same path the old rules took.

Two unrelated messages the app logged during this run: the managed chats folder is not a Git repository, and the environment bootstrap could not read the stand-in's `/session/active` snapshot. Neither touches chat rendering, the probes or the file viewer. The OpenCode backend was a stand-in, so the message body itself was served by that stand-in; the renderer, the probe requests, the file viewer and the click guard were the app's. Electron, VS Code, hosted-mobile and Capacitor navigation were not exercised.

## Accepted narrowing

Real inline-code or code-block filenames containing `@`, such as `src/user@host.ts`, lose automatic file references. Digit-leading extensions also lose them, including `ls.1`, `archive.7z`, `backup.7z`, `clip.3gp` and `data.001`. The latter 3 are pinned by the test. Extensions beginning with `_` or `-` stop qualifying. Explicit markdown file links keep the old click guard and still open through the file viewer.

URLs containing `://` remain excluded from path detection. Local `file:` URLs retain their separate decoding path. App links keep their own handling, and email hyperlinks retain ordinary link behavior.

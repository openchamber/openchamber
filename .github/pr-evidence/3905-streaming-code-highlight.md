# Streaming code block CPU, measurements for #3905

Packaged desktop build (`bun run electron:build`, macOS 27, Apple Silicon, Electron 43.7) built from the tree of this pull request, launched in an isolated home with the fixture provider from `scripts/perf/fixture-provider.mjs` as its only model. The optimisations were switched off and on through their localStorage switches on the same build, alternating, with `bun run profile:session -- --attach 9333 --process-cpu-only` opening each session in the app window over CDP. "off" is the behaviour of `main`; "on" is this pull request.

Percent of one core. "Renderer" is the Chromium renderer process; "All" sums every Electron process (renderer, GPU, main process hosting the server, network service) plus the managed OpenCode process. Two runs of the same variant usually differ by about one point of renderer CPU and by up to five in the worst case (the code block at 300 chars/s), so a difference smaller than that is noise. A run is valid when the session reported idle, the stream rendered in the window, and the assistant response was present.

| Scenario | Runs | Renderer off → on | Renderer p90 off → on | All Electron processes off → on |
|---|---|---|---|---|
| prose, 100 chars/s | 2+2 | 13.8 → 13.5 | 29.1 → 26.9 | 33.3 → 33.8 |
| prose, 300 chars/s | 2+2 | 22.4 → 22.4 | 42.0 → 37.1 | 48.1 → 47.8 |
| prose, 600 chars/s | 2+2 | 25.9 → 26.3 | 36.1 → 35.2 | 48.2 → 50.9 |
| prose, 1200 chars/s | 4+4 | 29.3 → 30.6 | 45.2 → 45.5 | 53.9 → 54.6 |
| 240-line code block, 300 chars/s | 2+2 | 36.2 → 26.7 | 49.2 → 39.1 | 57.2 → 48.4 |
| 240-line code block, 1200 chars/s | 2+2 | 45.2 → 34.5 | 65.8 → 57.3 | 70.0 → 59.1 |
| agent turn: 20 tool calls, then prose at 300 chars/s | 2+2 | 28.4 → 27.9 | 42.8 → 45.9 | 58.5 → 56.5 |
| agent silent for 30 s, nothing streams | 2+2 | 5.3 → 5.5 | 18.6 → 19.9 | 14.9 → 15.2 |

### Every run

| Run | Renderer | Renderer p90 | GPU | Electron main | OpenCode | All | Stream s | Rendered chars | Valid |
|---|---|---|---|---|---|---|---|---|---|
| h-stream-100cps-off-1 | 14.13 | 29.19 | 5.85 | 4.96 | 8.01 | 33.18 | 58.32 | 5938 | yes |
| h-stream-100cps-off-2 | 13.46 | 28.91 | 6.11 | 4.44 | 9.24 | 33.5 | 58.34 | 5938 | yes |
| h-stream-100cps-on-1 | 13.23 | 25.96 | 6.08 | 5.06 | 9.26 | 34 | 58.41 | 5938 | yes |
| h-stream-100cps-on-2 | 13.85 | 27.9 | 6.2 | 4.44 | 8.88 | 33.64 | 58.31 | 5938 | yes |
| h-stream-300cps-off-1 | 22.98 | 37.63 | 10.13 | 5.2 | 10.49 | 49.03 | 19.83 | 5938 | yes |
| h-stream-300cps-off-2 | 21.91 | 46.44 | 10.09 | 4.11 | 10.76 | 47.1 | 19.88 | 5938 | yes |
| h-stream-300cps-on-1 | 21.31 | 36.06 | 10.1 | 4.09 | 11.71 | 47.46 | 19.88 | 5938 | yes |
| h-stream-300cps-on-2 | 23.39 | 38.13 | 10.22 | 4.24 | 9.98 | 48.04 | 19.82 | 5938 | yes |
| h-stream-600cps-off-1 | 25.7 | 35.84 | 10.13 | 3.96 | 7.72 | 47.84 | 11.14 | 5939 | yes |
| h-stream-600cps-off-2 | 26.14 | 36.27 | 10.34 | 3.85 | 7.9 | 48.56 | 11.13 | 5939 | yes |
| h-stream-600cps-on-1 | 26.67 | 33.96 | 10.01 | 3.8 | 11.15 | 51.94 | 11.12 | 5939 | yes |
| h-stream-600cps-on-2 | 25.96 | 36.53 | 10.26 | 3.85 | 9.5 | 49.87 | 11.15 | 5939 | yes |
| h-stream-1200cps-off-1 | 29.66 | 42.81 | 9.69 | 4 | 11.65 | 55.4 | 6.17 | 5941 | yes |
| h-stream-1200cps-off-2 | 26.08 | 40.41 | 9.94 | 3.86 | 10.95 | 51.18 | 6.2 | 5941 | yes |
| h2-stream-1200cps-off-1 | 31.98 | 58.6 | 9.71 | 3.98 | 9.57 | 55.6 | 6.16 | 5941 | yes |
| h2-stream-1200cps-off-2 | 29.57 | 39.02 | 9.5 | 3.82 | 10.33 | 53.61 | 6.19 | 5941 | yes |
| h-stream-1200cps-on-1 | 31.23 | 45.85 | 9.56 | 3.96 | 10.83 | 55.94 | 6.18 | 5941 | yes |
| h-stream-1200cps-on-2 | 31.46 | 47.05 | 9.71 | 3.78 | 11.3 | 56.57 | 6.18 | 5941 | yes |
| h2-stream-1200cps-on-1 | 28.1 | 45.53 | 9.4 | 3.79 | 8.15 | 49.82 | 6.25 | 5941 | yes |
| h2-stream-1200cps-on-2 | 31.5 | 43.7 | 9.79 | 3.88 | 10.64 | 56.2 | 6.19 | 5941 | yes |
| h-code-300cps-off-1 | 33.76 | 44.67 | 8.66 | 3.66 | 8.03 | 54.31 | 37 | 11308 | yes |
| h-code-300cps-off-2 | 38.68 | 53.76 | 8.3 | 3.33 | 9.51 | 60.03 | 36.91 | 11308 | yes |
| h-code-300cps-on-1 | 26.48 | 38.97 | 9.1 | 4.45 | 7.96 | 48.24 | 36.93 | 11308 | yes |
| h-code-300cps-on-2 | 26.95 | 39.14 | 9.03 | 3.58 | 8.8 | 48.59 | 37.04 | 11308 | yes |
| h-code-1200cps-off-1 | 45.88 | 73.89 | 10.45 | 3.33 | 10.48 | 70.35 | 9.82 | 11311 | yes |
| h-code-1200cps-off-2 | 44.57 | 57.7 | 10.36 | 3.42 | 11.01 | 69.58 | 9.8 | 11311 | yes |
| h-code-1200cps-on-1 | 35.41 | 55.65 | 10.88 | 3.35 | 9.34 | 59.18 | 9.84 | 11311 | yes |
| h-code-1200cps-on-2 | 33.63 | 59.03 | 11 | 3.44 | 10.66 | 58.95 | 9.84 | 11311 | yes |
| h-agent-20tools-300cps-off-1 | 29.05 | 40.4 | 12.58 | 3.81 | 15.58 | 61.27 | 27.28 | 7797 | yes |
| h-agent-20tools-300cps-off-2 | 27.82 | 45.14 | 11.98 | 3.82 | 11.86 | 55.73 | 27.22 | 7815 | yes |
| h-agent-20tools-300cps-on-1 | 27.77 | 44.7 | 11.63 | 3.82 | 13.63 | 57.12 | 27.28 | 7815 | yes |
| h-agent-20tools-300cps-on-2 | 28.09 | 47.19 | 11.73 | 3.72 | 12 | 55.79 | 27.15 | 7815 | yes |
| h-think-30s-off-1 | 4.95 | 12.09 | 2.7 | 4.74 | 1.79 | 14.45 | 31.2 | 478 | yes |
| h-think-30s-off-2 | 5.74 | 25.02 | 2.81 | 4.82 | 1.73 | 15.37 | 31.17 | 478 | yes |
| h-think-30s-on-1 | 5.74 | 21.73 | 2.73 | 4.75 | 2.21 | 15.66 | 31.17 | 478 | yes |
| h-think-30s-on-2 | 5.21 | 18.16 | 2.73 | 4.72 | 1.76 | 14.64 | 31.27 | 478 | yes |

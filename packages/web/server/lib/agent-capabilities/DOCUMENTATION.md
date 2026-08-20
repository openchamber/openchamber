# Agent Capabilities — Vision

Server-side capability modules behind the managed `openchamber` agent tool.
Each capability owns its runtime, routes, and tests.

## Vision (`vision.js`)

Lets models without image input "see" an image: the agent tool action
`vision.run` reads an image file from disk and asks the user-configured vision
model to describe it — content, layout, style, colors, and verbatim text. The
description returns to the calling model as tool output; no child session is
created and nothing streams into the sidebar.

### Configuration

- Persisted in the `vision` settings field: `{ model: "provider/model",
  prompt? }`, sanitized by `sanitizeVisionConfig` in
  `lib/opencode/settings-helpers.js` (model must match `provider/model` shape,
  prompt capped at 4000 chars). An invalid save is rejected before anything
  persists, so it can never erase a working config.
- An empty/missing prompt falls back to `DEFAULT_VISION_PROMPT` at call time.
- CRUD routes: `GET/PUT /api/openchamber/vision` in `vision-routes.js`,
  registered from `feature-routes-runtime.js`. `persistSettings` serializes
  writes; a PUT replaces the whole `vision` field atomically.

### Invariants

- **The configured model must be image-capable.** Before every run the live
  `/config/providers` snapshot is consulted: a non-empty snapshot must contain
  the model with `capabilities.input.image === true`, otherwise the run fails
  with a usage error pointing at Settings → Vision. An empty/unreachable
  snapshot fails open (mirrors the fusion runner's rule) — it must not turn a
  valid selection into a rejection.
- **The image is validated and contained, not trusted.** The path is resolved
  (absolute, `~`, `file://`, or relative to the caller's directory) and must
  resolve inside the session directory — the agent tool runs with a workspace
  and must not exfiltrate arbitrary files from elsewhere on the machine to an
  external provider, so traversal like `/work/../etc/passwd` is rejected. It
  must be a file, is capped at 20 MB, and its magic bytes must identify a
  raster image whose format at least one major vision API documents as
  supported (PNG, JPEG, GIF, WebP — the union of the OpenAI, Anthropic, and
  Google supported formats). BMP, AVIF, ICO, and SVG are refused; SVG can
  carry scripts, and the others are undocumented for vision input everywhere.
  Content that fails sniffing is rejected even with a plausible extension; a
  format one provider happens to reject surfaces as that provider's own error.
  The size cap is enforced on the bytes actually read, not the pre-read stat,
  so a file swapped between stat and read cannot slip past it (TOCTOU).
- **Every supported wire format carries image parts.** OpenAI-compatible
  `/chat/completions` gets `image_url` content parts, the Responses API and
  the ChatGPT-plan codex backend get `input_image`, Anthropic `/v1/messages`
  gets base64 `image` source blocks, and Google `generateContent` gets
  `inline_data` parts — per each vendor's official vision documentation.
  GitHub Copilot models follow whichever endpoint they advertise; every
  other provider in the catalog resolves to the OpenAI-compatible format.
- **Failure is loud.** Missing config, unknown/non-vision model, missing file,
  oversize file, and unsupported formats are all 400 usage errors with
  actionable messages. Provider errors (e.g. missing login, 401) pass through
  with their status; cancellation surfaces as 499.
- **Output is bounded.** Descriptions truncate at 60k characters with a
  `truncated` marker; the model call is capped at 2000 output tokens and a
  120s deadline, honoring the caller's abort signal.

### Model invocation

`vision.run` calls the provider directly through `small-model/call.js`
(`callSmallModel` with `images: [{ mimeType, base64 }]`), reusing OpenCode's
credential resolution (config `provider.<id>.options.apiKey` wins, then
`auth.json`) — no child session, no prompt history.

### Tool contract

- Action `vision.run` on the shared `openchamber` tool
  (`openchamber-control/actions.js`), inputs `imagePath` (required) and
  `question` (optional, appended to the configured prompt).
- Result envelope data: `{ description, truncated, model, providerID,
  modelID, imagePath, imageFilename, imageMime, imageSize, question? }`.

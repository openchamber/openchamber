# Markdown Image Grants

## Purpose

This module lets the chat draw local images an assistant referenced in its
Markdown, from the workspace or anywhere else on the machine, including when
the UI is on a different machine.

## Contract

- Assistant image syntax initially renders as a filename label. Once a text
  part settles and its media nears the viewport, React-owned `MarkdownMedia`
  components load the picture through the scoped `MarkdownMediaProvider`
  (`packages/ui/src/components/chat/markdown/`). The chat draws at most 12
  images per text part. No rendered-subtree rewriting is involved.
- `POST /api/openchamber/sessions/:sessionId/markdown-image-grants` prepares the
  local images of a message part in one request, with no count limit; the
  256 KB body limit bounds how many paths fit, enough for a page of several
  hundred images. The server fetches the assistant
  message once and verifies every exact image source before reading files.
- Authorization recognizes the same common inline and reference-style image
  destinations collected by the UI, including balanced parentheses, while
  excluding fenced and inline code.
- The local images an `openchamber_render` page in the same message names are
  referenced too (`renderPageImageSources` in
  `../openchamber-control/render-page.js`): the page's HTML is the call's
  input, which OpenCode stores with the message. The chat reads them as data
  URLs and puts them in the page
  (`packages/ui/src/components/chat/message/parts/renderPageImages.ts`).
- The files a finished `openchamber_image` call saved are referenced too
  (`generatedImageSources`): the paths its stored result envelope names
  (`generatedImagePaths` in `../openchamber-control/generate-image.js`). The
  chat draws them in place of the call's row
  (`packages/ui/src/components/chat/message/parts/GeneratedImages.tsx`).
- A request that names the page's tool call (`callId`) gets that page's images
  in page order while their files add up to at most 25 MB
  (`fitRenderPageImages`); from the first image past it on, every image of the
  page answers `too-heavy`, whichever sources the request lists. The page's own
  HTML decides, so asking for a subset cannot get past the budget. A `callId`
  the message does not hold is a `404`. A request without `callId` is checked
  per source as before; the chat always names the page, and an older chat
  capped its own requests at 12 images. The agent hears the same split in the
  `render.page` result, because both use `fitRenderPageImages`.
- Relative and workspace-contained absolute paths resolve against the active
  directory and must stay inside it after `realpath` resolution, so a symlink
  in the workspace cannot point out of it. A path outside the workspace may be
  anywhere on the machine: the agent reads any file with its own tools, and
  image generators save to their own folders such as
  `~/.opencode/generated-images`. The exact reference in the assistant message,
  the file signature and the size limit are what gate it.
- PNG, JPEG, GIF, and WebP files are signature-checked and limited to 10 MiB.
  MP4, M4V, MOV, and WebM clips are checked by their `ftyp` box or EBML magic
  and limited to 1 GiB: `/api/fs/raw` streams them by byte range, and the chat
  draws them as a player. VS Code keeps a local clip as its file name, since
  its filesystem bridge reads files whole.
- Prepare requests inspect only file metadata and signatures. Workspace images
  reuse the existing authenticated `/api/fs/raw` asset route directly. Images
  outside the workspace receive the existing path-bound `raw`
  `outsideFileGrant`; this module does not add another asset lifetime, copy, or
  storage layer. Missing files return per-source results, so only those images
  keep their label.

The routes are OpenChamber-owned and must be registered before the generic
OpenCode proxy. Web, Electron, hosted mobile, and Capacitor use the shared
server implementation. VS Code does not call this route for workspace images;
those use its local filesystem bridge. If called, the grant route returns an
explicit unsupported response because images outside the workspace are not
supported there.

Requests to OpenCode carry the directory in a percent-encoded
`x-opencode-directory` header, matching the SDK wire format; OpenCode rejects
raw non-ASCII header values.

## Decisions

### Why a weight budget per page and not a count

A page named 19 posters and showed 12: a count says nothing about memory, and
it cut light pages while letting 12 phone photos through. What a page costs is
its images: each is read into the page as a data URL and decoded by the
browser. Measured on 2026-10-20 with 4032x3024 JPEGs of 5.8 MB, a page of four
such photos (23 MB) added about 100 MB to the Edge renderer on a Windows laptop
(i5-13420H) and about 150 MB to the Safari page process on an iPhone 17e
simulator; twelve photos (69 MB, what the count allowed) added about 290 MB and
430 MB and blocked the main thread for 298 ms. File size is the weight the
server can see before anything is read. It is a loose stand-in for decoded
memory, which follows pixels: a well-compressed photo decodes to far more than
a PNG of the same size.

### Why the page's images are taken in order up to the first that does not fit

A run from the top is what the agent can act on: it learns from which image on
the page stops showing, and splits the page there. Skipping a large image and
showing a smaller one after it would leave holes the agent has to map one by
one.

# Markdown Image Grants

## Purpose

This module lets the Markdown image gallery display images that an assistant
explicitly referenced from OpenCode's temporary directory when the UI is on a
different machine.

## Contract

- Chat Markdown rendering is independent: assistant image syntax renders as an
  icon and filename, while the gallery only reads finalized Markdown to collect
  image candidates.
- `POST /api/openchamber/sessions/:sessionId/markdown-image-grants` prepares up to 12
  local images in one message-level request. The server fetches the assistant
  message once and verifies every exact image source before reading files.
- Authorization recognizes the same common inline and reference-style image
  destinations collected by the UI, including balanced parentheses, while
  excluding fenced and inline code.
- Relative and workspace-contained absolute paths resolve against the active
  directory. Other absolute paths are accepted only inside
  `os.tmpdir()/opencode` after `realpath` resolution.
- PNG, JPEG, GIF, and WebP files are signature-checked and limited to 10 MiB.
- Prepare requests inspect only file metadata and signatures. Workspace images
  reuse the existing authenticated `/api/fs/raw` asset route directly. Images
  under `os.tmpdir()/opencode` receive the existing path-bound `raw`
  `outsideFileGrant`; this module does not add another asset lifetime, copy, or
  storage layer. Missing files return per-source results so the gallery can
  remove only those items.

The routes are OpenChamber-owned and must be registered before the generic
OpenCode proxy. Web, Electron, hosted mobile, and Capacitor use the shared
server implementation. VS Code does not call this route for workspace images;
those use its local filesystem bridge. If called, the grant route returns an
explicit unsupported response because OpenCode temporary images are not
supported there.

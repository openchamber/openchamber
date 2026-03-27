# Docs Authoring Guide

This package is docs content source-of-truth for OpenChamber.

## Add a new docs page

1. Create a new file in `packages/docs/content/docs/`.
   - Example: `packages/docs/content/docs/remote-access.mdx`
2. Add frontmatter at top:

   ```mdx
   ---
   title: Remote Access
   description: Access OpenChamber from outside your local network.
   ---
   ```

3. Use route-safe naming:
   - `foo.mdx` -> `/foo/`
   - `folder/index.mdx` -> `/folder/`
   - `folder/bar.mdx` -> `/folder/bar/`
4. Run validation:

   ```bash
   bun run docs:validate
   ```

## Add a new sidebar section

Edit `packages/docs/sidebar.config.json`.

Example:

```json
{
  "label": "Advanced",
  "items": [{ "label": "Remote Access", "link": "/remote-access/" }]
}
```

Rules:

- use trailing slash in links (`/page/`)
- every sidebar link must map to an existing MDX file
- keep section labels short and task-oriented

## Sync into openchamber-website

`openchamber-website` renders/deploys docs via Starlight in `apps/docs`.

After docs content updates here:

1. copy `packages/docs/content/docs/*` -> `openchamber-website/apps/docs/src/content/docs/*`
2. map `packages/docs/sidebar.config.json` into `openchamber-website/apps/docs/astro.config.mjs` sidebar
3. run docs checks/build in website repo

Automation support exists in `.github/workflows/docs-source.yml` (release/manual packaging of docs source artifact).

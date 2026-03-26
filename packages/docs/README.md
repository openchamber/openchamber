# OpenChamber Docs Source

This package is the source-of-truth for OpenChamber public docs content.

## Layout

- `content/docs/**/*.mdx` - docs pages, including localized content when present
- `sidebar.config.json` - docs navigation structure for Starlight sidebar
- `CONTRIBUTING.md` - authoring guide for adding pages and sections
- `DEPLOYMENT.md` - release/manual packaging and sync trigger model

## Local validation

Run from repo root:

```bash
bun run docs:validate
```

This validates:

- frontmatter (`title`, `description`) exists for every MDX page
- sidebar links resolve to existing MDX routes

## Deployment model

This repo owns docs content.

Website rendering/deployment happens in `openchamber-website` (`apps/docs`).

Use `.github/workflows/docs-source.yml` to package docs source on release or manual trigger.

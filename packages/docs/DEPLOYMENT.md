# Docs Source Deployment

This repo publishes docs **source artifacts**.

Rendering and hosting still happen in `openchamber-website` (`apps/docs`).

## Workflow

Use `.github/workflows/docs-source.yml`.

Triggers:

- push to `main` when docs source changes
- release published
- manual `workflow_dispatch`

Outputs:

- validates docs (`bun run docs:validate`)
- creates `openchamber-docs-source-<sha>.tar.gz`
- uploads archive as workflow artifact
- on release/manual with tag, uploads archive to release assets

## Optional cross-repo sync trigger

The workflow can trigger a `repository_dispatch` event in `openchamber-website`.

Set secret in this repo:

- `OPENCHAMBER_WEBSITE_REPO_TOKEN` (token with access to `openchamber/openchamber-website`)

Event sent:

- `event_type: docs_source_updated`

Payload includes:

- `source_repo`
- `source_ref`
- `archive_name`

`openchamber-website` can listen for this event and pull docs source from release artifacts.

---
name: coolify
description: Operate the Coolify instance at 382972.xyz through its HTTP API — list and inspect applications, deploy, restart, read logs, set environment variables, create applications from a repository, and manage domains. Use for anything about Coolify from inside a Pithagoras task container, where the API is reachable but SSH to the host is not.
license: MIT
compatibility: opencode
---

# Coolify (API only)

Everything here goes over HTTPS to the Coolify API. It works from inside a task
container, which has no SSH and cannot see the host.

## Credentials

Read-only, at a fixed path. Source it, never print it:

```sh
. /credentials/credentials.env
# $COOLIFY_URL      https://382972.xyz
# $COOLIFY_API_TOKEN
# $COOLIFY_ADMIN_EMAIL / $COOLIFY_ADMIN_PASSWORD   dashboard login, not the API
```

Every call carries the token:

```sh
curl -sS -H "Authorization: Bearer $COOLIFY_API_TOKEN" "$COOLIFY_URL/api/v1/applications"
```

Pipe through `python3 -c 'import json,sys; ...'` rather than dumping raw JSON —
these responses are large.

## Facts about this instance

| | |
| --- | --- |
| Dashboard | `https://382972.xyz` |
| Server UUID | `fd3qmaabtfdy7slyiiwusxqv` |
| Destination UUID | `lijl7n18kjilruhqccapssdx` |
| Coolify project for Pithagoras | `ce2wkyjoovbfsmm9gktljaw9` |
| Pithagoras app UUID | `usn7v2ezjed2ux5ywbwzhiv1` |

## The calls worth knowing

```sh
# List applications, and read one
curl -sS -H "Authorization: Bearer $COOLIFY_API_TOKEN" "$COOLIFY_URL/api/v1/applications"
curl -sS -H "Authorization: Bearer $COOLIFY_API_TOKEN" "$COOLIFY_URL/api/v1/applications/$APP"

# Deploy. This is the form that works — the /applications/{uuid}/deploy path
# 404s on API-created apps.
curl -sS -X POST -H "Authorization: Bearer $COOLIFY_API_TOKEN" "$COOLIFY_URL/api/v1/deploy?uuid=$APP"

# Restart, or start a stopped app
curl -sS -X POST -H "Authorization: Bearer $COOLIFY_API_TOKEN" "$COOLIFY_URL/api/v1/applications/$APP/restart"

# Container logs (the running app's, not the build's)
curl -sS -H "Authorization: Bearer $COOLIFY_API_TOKEN" "$COOLIFY_URL/api/v1/applications/$APP/logs?source=both&tail=100"

# Environment variables: bulk upsert. is_preview:false is the real row;
# creating a variable also makes an is_preview:true twin that quietly goes stale.
curl -sS -X PATCH -H "Authorization: Bearer $COOLIFY_API_TOKEN" -H 'Content-Type: application/json' \
  "$COOLIFY_URL/api/v1/applications/$APP/envs/bulk" \
  -d '{"data":[{"key":"FOO","value":"bar","is_preview":false}]}'
```

Deployment status is readable from the *app* (`running: healthy` and friends).
The build queue itself — status and logs per deployment — lives only in the
Coolify database, which needs `docker exec coolify-db psql`, so **not from here**.
If you need build logs, say so rather than guessing; the operator can get them.

## Gotchas that cost time

- **PATCH is an allow-list.** `fqdn`, `private_key_uuid`, `private_key_id`,
  `docker_compose_raw` and `settings` are rejected. `git_repository`,
  `git_branch` and `ports_exposes` are accepted.
- **Domains are effectively UI-only** over the API, and a stale
  `custom_labels` snapshot pins the old domain even after `fqdn` changes.
- **Every env var has a preview twin** — update with `is_preview:false`, or the
  twin goes stale; removing a key needs both rows deleted individually.
- **A compose app that publishes host ports will clash with Coolify's own.**
  Use `expose:`, not `ports:`.
- **Changing the admin password revokes every API token**, including this one.

## What needs the host (not available here)

`docker ps`, `docker logs`, `docker exec coolify-db`, anything under
`/data/coolify`, and the deploy-key cleanup SQL. A task container has none of
that. The Coolify API covers deploys, config and app-level logs; for the rest,
say what you need and let the operator run it — do not simulate it.

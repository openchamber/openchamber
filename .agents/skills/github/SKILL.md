---
name: github
description: Work with GitHub repositories from inside a Pithagoras task container using the REST API and HTTPS git — list and create repositories, manage deploy keys, open and read pull requests, trigger and inspect workflow runs, and clone or push with the token. Use for anything about GitHub when SSH to the host is unavailable.
license: MIT
compatibility: opencode
---

# GitHub

Works from inside a task container. There is **no SSH key** here, so cloning and
pushing go over HTTPS with the token.

## Credentials

```sh
. /credentials/credentials.env
# $GH_TOKEN   account madhatter349 (free plan)
```

```sh
GH='-H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json"'
curl -sS -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/user
```

## Repositories

```sh
# Who am I, and what is here
curl -sS -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user
curl -sS -H "Authorization: Bearer $GH_TOKEN" "https://api.github.com/user/repos?per_page=100" \
  | python3 -c 'import json,sys; [print(r["full_name"], r["private"]) for r in json.load(sys.stdin)]'

# Create a private repo (this account has no paid plan: keep repos private by default)
curl -sS -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/user/repos -d '{"name":"my-repo","private":true}'

# Add a read-only deploy key to a repo (Coolify apps use these)
curl -sS -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/OWNER/REPO/keys \
  -d "$(python3 -c 'import json;print(json.dumps({"title":"app","key":open("deploykey.pub").read().strip(),"read_only":True}))')"
```

## Pull requests and workflow runs

```sh
curl -sS -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/repos/OWNER/REPO/pulls?state=open

# Trigger a workflow that takes inputs (e.g. deploy_only), then watch it
curl -sS -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/OWNER/REPO/actions/workflows/upstream-sync.yml/dispatches \
  -d '{"ref":"main","inputs":{"deploy_only":"true"}}'

curl -sS -H "Authorization: Bearer $GH_TOKEN" \
  "https://api.github.com/repos/OWNER/REPO/actions/runs?per_page=5" \
  | python3 -c 'import json,sys; [print(r["name"], r["status"], r["conclusion"]) for r in json.load(sys.stdin)["workflow_runs"]]'
```

## Cloning and pushing

No SSH. Put the token in the URL, and set an identity — a fresh container has
none, and `git commit` fails without one:

```sh
git config --global user.name  "madhatter349"
git config --global user.email "madhatter349@users.noreply.github.com"

git clone "https://x-access-token:$GH_TOKEN@github.com/madhatter349/REPO.git"
# …or point an existing remote at it
git remote set-url origin "https://x-access-token:$GH_TOKEN@github.com/madhatter349/REPO.git"
```

Work in the project directory you were given — `/workspace`. It is the only
place a task may write, and it is the same directory the chat is working in.

## Notes

- `gh` is **not installed** in this image. Use the REST API with `curl`.
- The token is account-wide: it can push to any repo this account can reach.
  Prefer a deploy key when something only needs to read one repository.
- Rate limits are per hour per token. On a 403 mentioning rate limit, stop and
  say so rather than retrying in a loop.

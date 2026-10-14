---
name: cloudflare
description: Manage Cloudflare DNS, zones and cache through the API from inside a Pithagoras task container — list zones, read and change DNS records, and purge cache. Use for anything about DNS records or Cloudflare configuration for the zones this account holds.
license: MIT
compatibility: opencode
---

# Cloudflare

Straight HTTP against `https://api.cloudflare.com/client/v4`. No SSH needed.

## Credentials, and which token to use

```sh
. /credentials/credentials.env
```

| Variable | Scope | Use it for |
| --- | --- | --- |
| `CLOUDFLARE_FULL_API_TOKEN` | account-wide, DNS read+write on **every** zone | the default. Verified across `058637.xyz`, `120319.xyz`, `248232.xyz`, `382972.xyz`, `joshuakle.in`, `onlykleins.com`, `ouroboric.ai` |
| `CLOUDFLARE_DNS_382972_API_TOKEN` | zone-scoped to `382972.xyz` | narrower option when only that zone is involved |
| `CLOUDFLARE_DNS_API_TOKEN` | zone-scoped to `058637.xyz` | narrower option when only that zone is involved |
| `CLOUDFLARE_API_TOKEN` | general token | legacy; prefer one of the above |
| `CLOUDFLARE_ACCOUNT_ID` | — | account-level endpoints (R2, Workers, Access) |

Prefer the **narrowest** token that covers the zone — it is the difference
between one zone and the whole account if something goes wrong.

## Reading

```sh
T=$CLOUDFLARE_FULL_API_TOKEN

# Zones
curl -sS -H "Authorization: Bearer $T" https://api.cloudflare.com/client/v4/zones \
  | python3 -c 'import json,sys; [print(z["id"], z["name"]) for z in json.load(sys.stdin)["result"]]'

# One zone's ID by name
ZONE=$(curl -sS -H "Authorization: Bearer $T" \
  "https://api.cloudflare.com/client/v4/zones?name=382972.xyz" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"][0]["id"])')

# DNS records
curl -sS -H "Authorization: Bearer $T" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records?per_page=100" \
  | python3 -c 'import json,sys; [print(r["type"], r["name"], "->", r["content"], "proxied" if r["proxied"] else "dns-only") for r in json.load(sys.stdin)["result"]]'
```

## Writing

Always check `success` in the reply — Cloudflare answers HTTP 200 with
`"success": false` for a refused change, so a status code alone proves nothing.

```sh
# Create or update a record (POST to …/dns_records, PUT to …/dns_records/<id>)
curl -sS -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
  -d '{"type":"A","name":"example","content":"203.0.113.10","ttl":1,"proxied":true}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("ok" if d["success"] else d["errors"])'

# Purge a single URL, or everything
curl -sS -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/purge_cache" -d '{"files":["https://382972.xyz/"]}'
```

## Notes

- **Wildcard DNS already exists on `382972.xyz`** — `*.382972.xyz` resolves to
  the VPS, so a new subdomain usually needs no DNS change at all. Check before
  adding a record.
- **Deployments normally get their hostname from Coolify, not from here.**
  Coolify adds and validates the record when a domain is set on an app. Reach for
  this skill when a record is genuinely missing or wrong, not as a first step.
- **`proxied: true` puts the record behind Cloudflare.** That changes TLS and
  caching behaviour, and can break a service expecting its own certificate. When
  unsure, match what neighbouring records on the same zone already do.
- Changing DNS can take a service offline for real users. Say what you are about
  to change, and change one record at a time.

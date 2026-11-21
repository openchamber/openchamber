# Teapot Usage

An extension that adds a usage provider to OpenChamber, next to the built-in
ones on the Usage page, in the header, in Work Status and on the phone. It
declares `contributes.service.provides: ["quota"]` and lists in
`contributes.quota.providers` the one OpenCode provider whose credential it
reads, `teapot`. OpenChamber names the provider `ext-quota-provider`, draws
its card with the extension's name and icon, asks the service for usage the
way it asks a built-in, and hands it on every read the credential OpenCode
holds for `teapot`, and nothing else of the credential store. The approval
dialog lists that provider; a version that lists another asks again.

Teapot is not a real product. `usage-server.ts` is a small usage API behind
one bearer: a plan, a five-hour and a weekly window, and a credit balance. It
exists so the example can be tried end to end on one machine.

## Try it

1. Start the fake usage API: `bun packages/sdk/examples/quota-provider/usage-server.ts`.
   It prints its address (`http://127.0.0.1:4569`) and the key it accepts
   (`demo`). `TEAPOT_PORT` and `TEAPOT_TOKEN` change them; the service reads
   the default address, so keep the port.
2. Store the key for the `teapot` provider in OpenCode: in **Settings →
   Providers**, add a custom provider with the id `teapot` and the key
   `demo` (or `opencode auth login`, choose Other, type `teapot`).
3. In **Settings → Extensions**, add this folder and allow the local service.
   The dialog names `teapot` as the provider whose credential the extension
   receives.
4. Open **Settings → Usage**: the **Teapot Usage** card sits after the
   built-ins and shows the plan, the two windows and the balance. Tick **Show
   in Work Status** and it joins the header's rate limits, Work Status and the
   phone's popover like any built-in.

Restart the usage API with `TEAPOT_TOKEN=other` and refresh: the card reports
that the key was refused and keeps its last reading. Stop the API and the card
reports that it did not answer. Pausing the extension takes the card away;
enabling it brings it back with its settings.

## What the service does

OpenChamber posts one call, `usage.read`, to the service at `POST /quota`,
with `input.credentials.teapot` set to the credential OpenCode holds (an API
key, or a browser login's tokens). The service sends the key as a bearer to
`GET /api/usage` on the fake API and answers the usage in the shape a built-in
computes: `usedPercent`, `windowSeconds` and `resetAt` per window, a
`valueLabel` for the balance, and `planLabel`. OpenChamber derives the
remaining share, the reset countdown and the formatted strings itself, so the
card matches the built-ins field for field. A 401 from the API is answered as
`ok: false` with the fix in `error`; an API that does not answer the same way.

## Rebuild

```bash
bun packages/sdk/scripts/bundle-guest.ts --node packages/sdk/examples/quota-provider/service/main.ts packages/sdk/examples/quota-provider/service/main.js
```

`scripts/quota-provider-example.test.ts` runs the built service against the
fake API and checks the usage read, a refused key, a missing credential and an
API that is down.

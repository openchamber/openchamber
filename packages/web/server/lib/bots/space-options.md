# Bot space options

## Ownership

`space-options.js` owns the persisted bot isolation schema and its pure projection
into the isolated-stage adapter's request. It reads no host environment, login,
provider catalog, running space or credential. Spaces owns resolving and delivering
the selected references, container enforcement and rollback.

## Configuration contract

`botDefinitionSchema` accepts an optional `space` object. Older definitions keep
that field absent. A present object has this shape:

```ts
{
  placeId?: string,
  network: { mode: 'allowlist' | 'open', domains: string[] },
  grants: Array<
    { kind: 'login' | 'custom', provider: string }
    | { kind: 'model', provider: string, upstream: string,
        secret: { kind: 'env', name: string } }
  >
}
```

Missing network means `{ mode: 'allowlist', domains: [] }`; missing grants means
`[]`. There is no registry-domain prefill or setup-command setting. The schema
reuses Spaces provider IDs, exact domain validation, the 200-domain limit and
environment-source syntax. Creation allows at most 16 grants, with one source
per provider. Options remain stored when `isolated` becomes false.

Every object under `space` is strict. Typed secrets, token/header/key fields,
setup commands and domain-window grants are rejected as complete invalid edits.
Model upstreams accept HTTP and HTTPS, including explicitly authorized private
APIs, but reject URL credentials, query parameters and fragments. A host source
is a variable name only. Saving never reads, checks, enumerates or logs its value.

## Required host composition

The main server owner must inject the resolver into `createBotIsolatedStages`:

```js
import { readBotSpaceOptions } from './lib/bots/space-options.js';

resolveSpaceOptions: ({ bot, selection }) =>
  readBotSpaceOptions(bot.space, selection)
```

`selection.providerID` is the resolved stage provider, including a runtime default
selection. Successful resolution returns exactly:

```js
{
  // placeId is absent when the bot did not select one.
  placeId,
  network: { mode, domains },
  setupCommands: [],
  grants: [selectedProviderReference],
}
```

Only the selected stage provider is granted. Other configured provider references
remain available for their own stages. An absent matching grant throws
`BotServiceError` with code `BOT_ISOLATED_MODEL_GRANT_REQUIRED`, state `needs-you`
and HTTP status 409. Production must not call the previous resolver that derives
access from host logins, custom providers or other running spaces. There is no
host-session fallback.

New executions use the bot configuration supplied to the resolver. The isolated
stage owner retains existing item-to-space bindings and Spaces' rule that already
delivered grants cannot be revoked. The schema does not modify existing containers.

Model endpoint entry also requires the host's enterprise provider-entry guard at
the point that creates or delivers the grant. This pure module supplies no policy
authority. The composition owner must enforce that refusal; UI visibility does
not establish enterprise enforcement.

## Editor contract

Web, Electron, hosted mobile and Capacitor share `BotSpaceFields`. VS Code has no
Bots entry. The editor reads the existing Spaces switch before inventories;
an off switch shows an unavailable reason and performs no place, login or custom
provider probe. Inventories use the selected project's directory. Partial failure
keeps unrelated catalogs and saved references visible, with an error and Refresh.

The shared `ModelKeySource` accepts `allowTyped={false}` for bot definitions. Its
default remains true for ordinary Spaces dialogs. Both the bot client and server
schemas reject raw secrets regardless of what a client renders. These are dynamic
bot-definition fields, so they are not indexed as global Settings search targets.

## Decisions

### Why explicit references and not ambient space grants

A bot's approved access must survive a restart without borrowing authority from
another space or from an unrelated host login. Persisting the selected source
records that decision without copying its secret.

### Why the resolver grants one provider at a time

Each stage already has one resolved provider. Returning its single reference fits
the existing isolated adapter and avoids delivering unrelated configured access.

## Validation

`space-options.test.js` covers real config persistence, rejected secret-bearing
writes preserving the saved config, strict nested input, selected-provider
projection, missing access and conservative network defaults. The UI has focused
schema, form-to-HTTP and 15-locale composition tests. These tests do not establish
real Docker isolation, live provider access, enterprise enforcement or index wiring.

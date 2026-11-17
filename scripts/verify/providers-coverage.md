# Provider settings coverage

Run the zone on the isolated fixture stand:

```sh
OPENCODE_BINARY="/Applications/OpenChamber Canary.app/Contents/Resources/opencode-cli/opencode" bun run verify -- providers
```

## Reachable behavior

The existing map had 287 scenarios and none listed the provider settings files.
The config and workspace zones exercise the chat model picker and defaults,
but do not open provider settings.

| Feature | Ordinary path | Ordinary failure |
| --- | --- | --- |
| Provider grid | Search configured providers, open a card, return to chat without changing its model | No matches, clear or replace the query |
| Connect picker | Search available integrations or open a custom provider draft, go Back | No matches; integration-list read fails |
| Available models | Filter by name or ID, hide one model, hide or show every model, retain visibility after reload | No matching model |
| Custom configuration | Open and discard a draft; edit an existing project provider in its original file | Missing or malformed connection details; existing provider ID; rejected write |
| Manual models | Add, expand, collapse and remove model rows; choose limits, capabilities and reasoning levels | Missing model fields, duplicate IDs, non-positive or fractional limits |
| Request headers | Add and remove rows; keep the final row | Missing half of a header; case-insensitive duplicate names |
| Client certificate | Expand the optional section and enter full paths and a passphrase | Incomplete certificate/key pair; relative paths; submission reopens the section |
| Protocol and fallback icon | Choose a supported protocol and icon, restore Default | Save failure must leave the draft editable |
| Logo draft | Pick and preview an image, remove it before save | Unsupported type or oversized image |
| Model discovery | Start discovery with a base URL; manually entered rows survive its failure | Failed request, retry remains available |
| Credentials | Open or close the fixture's API-key card | Empty key; failed local key write retains the typed key; real sign-in needs provider credentials |
| Provider availability | Disable a configured provider and enable it from the disabled list | Failed availability write |

The zone prioritizes model availability, configuration edits, validation and
failure recovery. It uses existing steps only. The project-local provider in
`custom.edit` is scenario data written with `file.write`; reset removes it.
It uses a bundled adapter and a loopback address and never sends a model request.
Replacing native input text uses the existing triple-click gesture. On this
Mac, CDP Cmd+A left the input selection collapsed; triple-click selected the
whole value. No browser helper, step or fixture was changed.

## Limits

- Successful custom-provider creation writes the stand's user config, which the
  existing reset does not restore. There is no UI action to delete that config.
  The zone tests successful project-local editing and failed creation instead;
  it does not change the reset or fixture contract.
- Successful discovery needs the stand's dynamically chosen fixture URL in the
  form. The steps do not expose it or substitute remembered values into typed
  text. The zone covers a failed discovery without adding a fixture-specific step.
- OAuth completion, cancellation while waiting, expired or rejected credentials,
  account addition, switching, renaming and removal, integration-specific forms
  and account-limit switching need suitable integrations and credentials.
  The fixture provider has no such sign-in flow. No external service is contacted.
- The stand exposes the built-in integration catalog, including popular cards
  and the providers behind Show all. A cold integration-list read failure is not
  covered; desktop startup prefetches that list before Settings opens.
- Disable/enable changes the server's provider policy outside profile reset.
  There is no existing reset step for that policy. It is left out to preserve
  scenario independence.
- Logo upload persistence, oversized-image rejection, header half-pairs,
  capability/variant persistence and successful TLS requests are not covered by
  these scenarios. The zone covers preview/removal, wrong file type, duplicate
  headers, existing configuration preservation and certificate validation.
- Enterprise policy, machine-managed credentials, VS Code's unavailable uploads,
  and native/mobile differences require another runtime or stand configuration.

## Product finding: the old provider name stays on screen

On unchanged product code, editing the project-local `Editable fixture` provider
to `Renamed fixture` wrote the new name to `opencode.json`, preserved its adapter
and header, and raised the success toast. The open provider page still showed
`Editable fixture` after waiting 20 seconds.

An additional assertion immediately after the edit reproduced this in 3 of 3
rounds. All preceding file and model checks passed. The failed assertion was:

```json
{"do": "see", "on": "providers.heading", "text": "Renamed fixture", "exact": true}
```

Each result failed at step 19 with:

```text
expected providers.heading "Renamed fixture"; found 0 visible of 1 matching
```

The scenario durations were 23.8, 23.4 and 23.3 seconds. Each result recorded
`pageErrors: []` and `sourceUpdates: []`; the failure screenshot's heading was
`Editable fixture`. This is a live-update defect, not a failed configuration
write. It was not fixed in this test-only change.

The kept `custom.edit` scenario tests the saved file and reopens the provider
after a reload, where the new name appears. It does not claim the open page
updates its name live.

## Mutation checks

Each scenario failed on the product mutation in its row. The mutations ran in
2 batches, 3 search scenarios and 17 action/validation scenarios. Both batches
had zero passing scenarios and zero source updates during scenarios.
All product files were restored afterwards; `git diff -- packages` was empty.
The final full-zone run passed 60 of 60 executions, 20 scenarios in 3 consecutive
rounds, in 264 seconds. No scenario recorded a source update. The stand left no
`bun run dev:server` process running.

The initial full run passed 17 scenarios in all 3 rounds.
After correcting test-only assumptions, 5 changed scenarios passed all 3 rounds
in `providers-corrected`, including the 3 that had failed in the initial run.
The failures were an over-specific fuzzy-search count, JSON whitespace in a file
assertion and an old Settings search target. They were not product defects.

The search mutation run failed all 3 selected scenarios at their behavioral
checks, with no source updates during the run:

- `browse.grid-search`, step 8: the unmatched query no longer showed its empty state.
- `browse.connect-search`, step 15: search no longer offered Custom provider.
- `models.filter`, step 9: the unmatched model query no longer showed its empty state.

| Scenario under `providers.` | Product mutation | Red step |
| --- | --- | --- |
| `browse.grid-search` | Ignore the provider grid search query | 8, empty state missing |
| `browse.connect-search` | Stop matching the custom provider in connect search | 15, custom provider missing |
| `models.filter` | Ignore the available-model filter query | 9, empty state missing |
| `models.hide-one` | Make the individual visibility button do nothing | 10, Show model missing |
| `models.hide-show-all` | Hide an empty list instead of every model | 14, 25 models still visible |
| `custom.edit` | Write a different display name in the provider upsert | 14, file keeps the wrong name |
| `custom.required` | Stop reporting the missing display name | 11, invalid field missing |
| `custom.connection-validation` | Accept malformed nonempty provider IDs | 12, format error missing |
| `custom.existing-id` | Stop rejecting an existing provider ID | 10, duplicate-provider error missing |
| `custom.model-rows` | Leave the removed model in the draft | 17, removed row still present |
| `custom.duplicate-model` | Stop detecting duplicate model IDs | 15, invalid model ID missing |
| `custom.limits` | Stop validating the context window | 13, invalid context window missing |
| `custom.headers` | Stop detecting case-insensitive duplicate header names | 18, duplicate-header error missing |
| `custom.protocol-icon` | Keep the previous protocol after a selection | 11, protocol unchanged |
| `custom.certificate` | Stop reporting the invalid certificate path | 13, invalid certificate field missing |
| `failures.discovery` | Clear the discovery error instead of showing it | 14, discovery alert missing |
| `failures.save` | Log the failed provider write without showing its toast | 21, write error missing |
| `key.rejected` | Log an empty-key error without showing its toast | 12, empty-key error missing |
| `logo.preview` | Ignore the accepted image selection | 10, preview missing |
| `logo.invalid-file` | Log the rejected image type without showing its toast | 10, file-type error missing |

No product change belongs to this coverage addition.

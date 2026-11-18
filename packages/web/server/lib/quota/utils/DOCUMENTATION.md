# Quota utilities

## Ownership

Shared quota helpers normalize provider JSON, select credentials and format quota
windows and result envelopes. Provider modules own HTTP reads and credential
discovery. `contracts.ts` owns the converted helpers' data types.

## Invariants

- Object normalization accepts arrays and retains object identity.
- External object and scalar inputs enter through unknown-value parsers.
  Object normalization promises only `object`, so providers validate their own
  fields without assuming that every object is recursive JSON.
- Numeric conversion accepts finite numbers and numeric strings, including blank
  strings as zero. Timestamp parsing treats numeric zero as absent, while numeric
  timestamp normalization retains zero and nonfinite numeric values.
- Missing usage percentages and reset timestamps remain explicit undefined
  properties. Missing window durations become null. Empty labels are omitted;
  zero credits remain present.
- Unit lookup is sparse: unsupported units and absent counts have no duration.
  Numeric-string unit keys retain JavaScript's original property lookup.
  Provider JSON supplies the unit and count.
- `asNonEmptyString` remains the shared JavaScript guard re-export, with its
  existing acceptance rules.

## Decisions

### Why auth remains JavaScript

`auth.js` imports `getOpenCodeDataDir` and `OPENCODE_CONFIG_DIR` from
`../../opencode/config-files.js`. That owner's declaration exposes both paths without
duplicating their configuration logic.

`resolveConfigApiKey` currently evaluates `os.homedir()` without an `os` import
when its caller omits `homeDir`. Adding the import would change an existing
failure into success. The behavior-preserving conversion leaves this file
unchanged until that defect can be fixed separately.

`auth.test.js` asserts that omitting `homeDir` throws `os is not defined`.
An ambient declaration for `os` would claim a runtime binding that this module
does not provide. The unresolved name is local to this file; changing a
neighbouring module's types cannot resolve it.

### Why external scalar guards remain

Provider and credential JSON reaches the transformer helpers before scalar
validation. The number, string and object predicates retain the original
acceptance rules, including arrays, rather than trusting an unconverted caller.
Money and percentage formatting retain nonfinite checks after their redundant
numeric `typeof` checks are removed.

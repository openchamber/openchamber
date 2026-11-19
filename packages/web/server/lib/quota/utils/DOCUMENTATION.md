# Quota utilities

## Ownership

Shared quota helpers normalize provider JSON, select credentials and format quota
windows and result envelopes. Provider modules own HTTP reads and credential
discovery. `contracts.ts` owns the helpers' data types.

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

### Why auth lookups keep their loose results

`readJsonFile` returns parsed JSON and `normalizeAuthEntry` promises only
`object`: neither checks fields, so each provider validates the fields it
reads. `getAuthEntry` returns the first truthy entry with the caller's own
entry type.

### Why external scalar guards remain

Provider and credential JSON reaches the transformer helpers before scalar
validation. The number, string and object predicates retain the original
acceptance rules, including arrays, rather than trusting an unconverted caller.
Money and percentage formatting retain nonfinite checks after their redundant
numeric `typeof` checks are removed.

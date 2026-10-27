# Markdown source inspection

## Ownership

`openuiFences.ts` identifies authored OpenUI code blocks for source checks and
context-example tests. It uses the existing `remarkDisclosures` plugin, shared
with Markdown rendering.

## Invariants

- Canonical positions use UTF-16 offsets after BOM and line-ending normalization.
- Only an authored closing fence proves that a block is complete.
- Literal and unknown fence metadata remain available to callers, which decide
  whether a block is eligible for execution.

## Decisions

### Why source checks use the rendering parser

Remark handles nested lists, quotes and disclosures consistently with the screen
renderer. The closure extension observes its existing tokens without replacing
fenced-code parsing. Server asset tests use this UI helper during development;
the shipped server runtime has no Markdown parser dependency.

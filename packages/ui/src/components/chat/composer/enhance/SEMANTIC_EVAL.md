# Semantic eval cases — Enhance Prompt

Manual semantic evaluation of the `composer.enhance.instructions` contract
(the magic prompt behind the composer's Enhance Prompt action).

**How to run:** set the Small Model in Settings, then either paste a case
below as a composer draft and click **Enhance Prompt**, or call
`enhancePrompt` (packages/ui/src/components/chat/composer/enhance/
promptEnhancer.ts) directly with the case as the draft. Compare the result
against the expectations below.

These are **not** deterministic CI tests: LLM output is stochastic and exact
wording is never asserted. Judge each result only against the semantic
expectations, by the meaning of the whole input — never by whether the output
echoes a known verb or matches canned wording. The deterministic contract
tests for the template itself live in
`enhance/__tests__/enhanceInstructions.test.ts`.

## Single cases

| Input | Semantic expectations | Must-not |
| --- | --- | --- |
| `analyze issue 3366` | Target identity preserved (`issue #3366` is acceptable; identity, not exact formatting, is the invariant). Understanding/assessment action level: inspect the issue, weigh evidence, produce a materially useful assessment. Uncertainty about the issue's content stays open. | No invented issue content, status, or cause. No modification authorization. Reference not resolved from own knowledge. |
| `fix issue 3366` | Modification intent: the issue reference stays where identifiable, the problem is understood first, the fix is made, and the requested outcome is verified. | No invented root cause, files, or fix mechanism. No invented issue contents. Not reduced to analysis-only. |
| `review issue 3366` | Target identity preserved. Assessment/verdict intent: the review produces an explicit assessment outcome and weighs what matters for the target. More actionable than the bare verb. | No implementation. No invented issue facts or findings. |
| `check why this hangs` | Target `this` preserved unresolved. Understand-oriented: investigate the hang and deliver diagnosis/findings — supported causes distinguished from assumptions. | No implementation. No guessed cause for the hang. `this` not resolved. No generic "next steps" boilerplate; recommendations only where naturally supported. |
| `do the same as above but without a store` | The reference stays a reference; the `without a store` constraint is preserved explicitly. The repeated-action intent is made actionable. | The prior conversation is not reconstructed. The reference is not resolved from own knowledge. No invented store design. |
| `make this work like claude` | Modification intent preserved: the downstream assistant may establish what the referenced behavior means from its available context, then make the target (`this`, preserved unresolved) match it. `like claude` stays an unresolved reference — the downstream assistant has the context to interpret it. | No invented Claude behavior or internals. No guessed target. No invented implementation mechanism. Not downgraded to analysis-only. |
| `explain this code` | Target `this` preserved unresolved. Understand-oriented: explain the code's behavior and structure and the relevant relationships between its parts; rationale ("why") only where the draft supports it. | No implementation or refactor. No invented code behavior. |
| `move save button up` | Target (save button) and change intent preserved. Position change is made concrete and verifiable without redesigning the UI. | No invented layout system or component names. No extra scope (no refactor, no new feature). |
| `Rename foo to bar in src/a.ts` | Target and path identity preserved. Essentially unchanged — already precise and actionable. Expansion limited to phrasing polish at most. | No padding. No invented side effects, tests, or extra instructions. |

## Semantic-equivalence groups

Inputs within a group are materially equivalent: compatible action level and
outcome, without shared trigger wording. Exact output structure need not
match between them.

| Inputs | Shared expectations | Must-not |
| --- | --- | --- |
| `analyze issue 3366` / `take a look at issue 3366 and tell me what's going on` / `can you figure out what is happening with issue 3366?` | Same target identity (`issue 3366` / `issue #3366`). Understanding/assessment action level. Materially useful assessment of the issue. No modification authorization. No invented issue facts. | The three results must not differ in authorization level or deliverable because of the different phrasing. No keyword-level routing visible in the outputs. |

## Modification-equivalence group

Same shape as above, but for modification intent. This group exists to catch
hidden magic-word routing: if the model only modifies when it sees a
modification verb it knows, "sort out" and the sentence-only form will
collapse into assessment while `fix` does not.

| Inputs | Expected | Must-not |
| --- | --- | --- |
| `fix issue 3366` / `sort out issue 3366` / `issue 3366 is broken, make it work` | Modification intent in all three. Target identity preserved where identifiable. No invented implementation. | Not reduced to analysis-only; no invented root cause or mechanism; no divergent action level between the three. |

## Whole-intent cases

Each input contains one keyword whose alone-read gives the wrong
interpretation; the rewrite must follow the meaning of the whole sentence.

| Input | Semantic expectations | Must-not |
| --- | --- | --- |
| `analyze issue 3366 and fix it` | Both actions preserved: understanding of the issue, then the fix. Meaningful order preserved (analysis informs the fix). | Stopping at analysis. Jumping to a fix with invented cause/mechanism. Collapsing the request into one action. |
| `review this and implement only if the review confirms the bug` | Conditional authorization preserved: review first; implementation only if the condition is satisfied. `this` stays unresolved. | Converting the condition into unconditional authorization. Skipping the review. Inventing the review's outcome. |
| `check this checkbox is aligned with the label` | The whole sentence is a UI verification request: check whether the checkbox and its label are aligned. | Generating a debugging/root-cause workflow (hypotheses, hang investigation) just because the word "check" appears. Inventing a layout bug or fix. |
| `explain what is wrong and then fix it` | Both actions preserved: diagnosis/explanation first, then modification. | Classifying the whole request as read-only from its first verb. Stopping at diagnosis. Inventing the diagnosis. |

## Regression bar

`analyze issue 3366` must not come back equivalent to
"Analyze issue 3366." — a capitalization/punctuation-only rewrite is a
failure.

Three regression categories, each a failure mode to check explicitly:

1. **Keyword-routing regression** — different phrasings of materially
   equivalent intent produce compatible action levels even when they share no
   trigger words; and the same surface word must not force the same workflow
   when the whole sentence means something different (see the whole-intent
   cases and the two equivalence groups).
2. **Invention regression** — no apparent usefulness gained by inventing
   factual context, requirements, causes, architecture, implementation
   details, files, tests, or external knowledge.
3. **Over-expansion regression** — an already precise instruction (e.g.
   `Rename foo to bar in src/a.ts`) must not become a generic
   workflow/specification without semantic need.

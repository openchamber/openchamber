---
name: writing-for-agents
description: Writing documents for agents. Use when creating or editing skills, AGENTS.md, agent definitions, or docs agents reach through instructions or context pointers, and when auditing them.
author: Matt Pocock
---

Reference for writing any document an agent consumes: a skill, an `AGENTS.md`, a doc reached by a pointer.

A document is done when a run proves it (*Proving a document works*). For an audit of existing documents, work through [`references/audit-checklist.md`](references/audit-checklist.md).

## Context pointers

A **context pointer** is a reference held in the agent's context that names some out-of-context material and encodes the condition for reaching it. A skill's description is one; a line in `AGENTS.md` naming a doc is the same object. The pointer's _wording_, not its target, decides when the agent reaches the material, and how reliably. A must-have target behind a weakly worded pointer is a variance bug: sharpen the wording first, and inline the material only if sharpening fails.

A pointer does two jobs: state what the material is, and list the **branches** that should trigger reaching it (a branch is a distinct case the document handles, so different runs take different paths through it). Every word of an always-loaded pointer costs on every turn, so it earns even harder pruning than the body:

- **Front-load the leading word**: the pointer is where it does its triggering work.
- **One trigger per branch.** Synonyms that rename a single branch are one branch written twice; collapse them and keep only genuinely distinct branches.
- **Cut identity the body already carries.**
- **Name the work, not an incident.** A trigger fires on what the agent is about to do ("OpenCode SDK calls", "bootstrap"); a fixed bug's symptom fires only when that bug is back. A rule learned from an incident lives in its canonical skill's body, with a one-line pointer in the skills loaded while that kind of code is written.

A skill's description is the pointer the agent picks it by, among every other skill's. Say what the skill covers and when it applies, key use case first, without "I" or "you" ("Use when…" is fine); hosts cut long descriptions (Claude Code at 1,536 characters), and the cut falls on the end. Agents pass over a matching skill more often than they load a wrong one, so name the concrete work and files that should trigger it rather than a category.

## The two loads

Every document and pointer you add spends one of two budgets:

- **Context load** is the cost of always-loaded material on the agent's window: an `AGENTS.md` line, a skill description, anything sitting in context every turn, spending tokens and attention whether or not it fires. A skill's body joins it once loaded and stays for the rest of the session.
- **Cognitive load** is the cost on the human: which documents exist and when to reach for each. The human is the index. Not a cost to minimise: it is the price of human agency; spend it where human judgement matters, remove it where it does not.

Material reached only through a pointer escapes context load at the price of the pointer's own line; material with no pointer at all rides entirely on cognitive load.

A skill the agent should never pick on its own (one a person starts by name) can drop its description from the agent's reach with `disable-model-invocation: true`: no context load, all cognitive load. Pick that only when nothing but a person ever starts it, since no other skill can reach it either.

## Information hierarchy

A document is built from two content types: **steps** (the ordered actions the agent performs) and **reference** (definitions, rules, facts consulted on demand). The two mix freely: all steps (a recipe), all reference (a review's rules, this skill), or both. The core decision is where each piece sits on the **information hierarchy**, a ladder ranked by how immediately the agent needs the material:

1. **In-file step** is the primary tier: what the agent does, in order.
2. **In-file reference** is consulted on demand. Often a legitimately flat peer-set (every rule of a review on one rung), which is a fine arrangement, not a smell.
3. **Disclosed reference** is pushed out into a separate file, reached by a context pointer, loaded only when the pointer fires. Spans a sibling file in the same folder through fully external reference that lives anywhere and any document can point at.

Push too little down and the top bloats; push too much and you hide material the agent actually needs.

**Progressive disclosure** is the move down the ladder (out of the main file and behind a pointer) so the top stays legible. Branching is the cleanest disclosure test: inline what every branch needs, and push behind a pointer what only some branches reach. When a document has steps, in-file reference that should be disclosed buries them and turns attending to them into a coin-flip: a variance lever, not just a legibility one.

**Co-location** is the within-file companion: where the ladder decides _how far down_ a piece sits, co-location decides _what sits beside it_ once there. Keep a concept's definition, rules, and caveats under one heading rather than scattered, so reading one part brings its neighbours with it. The test: the document should read like documentation written for the agent. Grouped material reads that way; scattered material does not. (Distinct from duplication: that repeats one meaning in two places; scattering fragments one meaning across many.)

**Sprawl** is the failure mode here: a document simply too long, even when every line is live and unique. Attention thins across the excess, and every extra line is one more to keep relevant. The cure is progressive disclosure and *When to split*.

### File mechanics

- Keep a skill's `SKILL.md` under 500 lines; past that, disclose.
- Link every disclosed file from `SKILL.md` itself, one level deep. An agent that reaches a file through another disclosed file often previews it instead of reading it whole.
- Open a disclosed file longer than about 100 lines with a list of its sections, so a partial read still shows its scope.
- Name files by what they hold (`updater-testing.md`, not `notes.md`).
- A deterministic operation the agent would otherwise write each time belongs in a script. Say whether the agent runs it ("run `scripts/x.mjs`") or reads it as reference; running is the usual case, and only its output costs context.

## Degrees of freedom

Match how tightly a passage binds the agent to how fragile the work is. A fragile or exact sequence (a migration, a release, a command whose flags matter) gets the exact command and no room. Work where several approaches are valid and context decides (a review, a design) gets the goal, the criteria and the known traps, and the agent picks the route. A passage that dictates steps for open work produces rote, wrong-for-the-case output; a passage that only gestures at fragile work produces improvisation where improvisation breaks things.

Where the output has a shape, show it: a template for a strict format, two or three input and output pairs for a style. One concrete example binds better than a paragraph describing it. Offer one default with its exception rather than a menu of equal options.

## Steps and completion criteria

Every step ends on a **completion criterion**, the condition that tells the agent the work is done. Two properties make it a lever:

- **Clarity**: can the agent tell done from not-done? A vague bound ("understanding reached") invites **premature completion**: ending the step before it is genuinely done, attention slipping to _being done_. The visible steps still ahead (the **post-completion steps**) supply the pull; the criterion's clarity is the resistance. Defend in order: **sharpen the bound first** (local and cheap); only if it is irreducibly fuzzy _and_ you observe the rush, hide the later steps by splitting the sequence. Hiding only works across a real context boundary (a hand-off or a subagent dispatch; an inline call leaves the later steps in context and clears nothing).
- **Demand**: how much it requires. "Every modified model accounted for" forces thorough work where "produce a change list" does not. Demand drives **legwork** (the digging the agent does within the work, latent in the wording rather than written as its own step), and it is not step-bound: "every rule applied" binds a body of flat reference just as "every step done" binds a sequence, which is how an all-reference document still carries an exhaustiveness bar.

The strongest criteria are both checkable and exhaustive. A step whose criterion is a validator's verdict (a check passes, a script reports nothing) can loop: run it, fix what it names, run it again.

## When to split

Splitting one document into two spends one of the two loads, so split only when the cut earns it:

- **By sequence**: split a run of steps where the post-completion steps tempt the agent to rush the one in front of it. Keeping them out of view drives more legwork on the current task. Beware the reverse: merging sequences exposes each step's later steps to what follows, inviting premature completion.
- **By invocation**: split off a skill when a distinct leading word should trigger it on its own (a word you actually use in your prompts), or another skill must reach it. You pay context load for the new always-loaded description, so that independent reach has to be worth it.

## Leading words

A **leading word** is a compact concept already living in the model's pretraining that the agent thinks with while running the document (_lesson_, _fog of war_, _tracer bullets_). Repeated as a token, never as a sentence, it accumulates a distributed definition and anchors a whole region of behaviour in the fewest tokens, by recruiting priors the model already holds. Coining your own works if you define it clearly, but a made-up word recruits no priors: you pay in definition tokens what a pretrained word gives free; reach for an existing word first.

It anchors twice. In the body, _execution_: the agent reaches for the same behaviour every time the word appears, and inside flat reference it focuses attention on a class of thing to look for. In a pointer, _invocation_: when the same word lives in your prompts, your docs, and your codebase, the agent links that shared language to the material and reaches it more reliably. Keep one word per concept for the whole document: three names for one thing read as three things.

Hunt for opportunities to refactor with leading words. A triad spelled out at three sites, a pointer spending a sentence to gesture at one idea. Each is a passage begging to collapse into a single token:

- "fast, deterministic, low-overhead" → _tight_ (a _tight_ loop).
- "a loop you believe in" → _red_, turning a fuzzy gate into a binary observable state (the loop goes _red_ on the bug, or it doesn't).

Assume every document is carrying restatements that leading words retire.

**Negation** is the failure mode beside this lever: steering by prohibition drags the forbidden behaviour into context and makes it _more_ available, not less. _Don't think of an elephant_, and the elephant is all there is; the negation is a weak modifier the strongly-activated concept overruns, so the ban half-reads as an instruction to do the thing. Prompt the **positive**: state the target behaviour ("write one-line comments") so the banned one is never spoken. A prohibition earns its place only as a hard guardrail you cannot phrase positively; even then, pair it with the positive target so attention lands on what to do.

## Reasons and emphasis

A rule followed without its reason is applied where it does not fit and dropped where it does. Give the reason when it changes what the agent does: when, without it, the agent would "fix" the rule back, or apply it past its case. One clause is usually enough ("because a stash takes every session's work"). The story of how the reason was found (the incident, the dates, the numbers of that run) is history, and stays out of the rule.

Capitals, MUST and NEVER are emphasis, and emphasis is spent: when everything is loud the agent ranks by volume, not by stakes. Prefer the reason. Reach for a stronger word only for a guardrail you have watched an agent cross with the plain one in place.

## Pruning

- Keep each meaning in a **single source of truth**: one authoritative place, so changing the behaviour is a one-place edit. **Duplication** (the same meaning in more than one place) costs maintenance and tokens, and inflates a meaning's prominence on the ladder past its real rank.
- For cross-document guidance, name one canonical owner. Other documents point to it and state only their local consequence; they do not restate the shared rule.
- A module's `DOCUMENTATION.md` owns that module's facts and invariants; a skill names it and keeps only the rule that spans modules.
- The **environment** is a source of truth too (`package.json` scripts, config files, the directory layout, `--help` output), and a document that restates it is a **cache**: a copy of a lookup, earning its load only when the lookup is expensive. Cache what the agent cannot find by looking: the unwritten convention, the reason behind a choice, the gotcha no config confesses. Leave the one-file, one-command lookups to the environment, where they cannot go stale.
- Check every line for **relevance**: does it still bear on what the document does? A line loses relevance by never bearing on the task (mere exposition, or a branch that should be disclosed) or by going stale as the behaviour or world it describes changes. Shorter documents are easier to keep relevant. Without a pruning discipline the default fate is **sediment**: stale layers that settle because adding feels safe and removing feels risky, until you must core down through them to find what is still live. A dated fact ("since 2026-09", "the old API until August") is sediment in waiting: state the current behaviour, and keep a past one only where agents still meet it, under its own heading.
- Hunt **no-ops** sentence by sentence: an instruction the model already obeys by default pays load to say nothing. The test (does it change behaviour versus the default?) is model-relative, not reader-relative: two people disagreeing about a no-op disagree about the default, and settle it by running the document, not by debate. When a sentence fails, delete the whole sentence rather than trim words from it. The test also grades leading words: a word too weak to beat the default (_be thorough_ when the agent is already thorough-ish) is a no-op, and the fix is a stronger word (_relentless_), not a different technique.

## Proving a document works

A document is a hypothesis about what an agent does with it, and a run is the only test. Writing one well is not proof that it works.

1. **Start from an observed failure.** Run a fresh agent on a real task without the document, or with the current one, and note where it goes wrong. Write only what closes that gap; a rule for a failure nobody has seen is a guess that costs load forever.
2. **Run the task again with the document**, in a fresh agent that has none of the writing conversation: a subagent or a new session, given the task the way a person would phrase it. The author's own context fills every gap the document leaves, so the author's run proves nothing.
3. **Read the transcript, not only the result.** What did the agent read, skip, or read twice? Which rule did it follow, which did it quote and then break, where did it spend time for nothing? A file never opened is badly pointed at or not needed; a section read every time may belong higher up.
4. **Run it on the smallest model that will execute it.** A document that works on a large model can leave a small one guessing; one tuned for a small model over-explains to a large one.
5. **For a pointer, test the trigger.** A few realistic requests that should fire it, and a few near misses that share its words but need something else. A request that does not fire it is a description problem, not a body problem.

## Skill ownership in this repository

| Concern | Canonical skill |
|---|---|
| Product decisions | root `AGENTS.md` |
| PR verdicts, pickup mode, review output | `pr-review` |
| Public text (closes, declines, thanks) | `communication-style` |
| Change scope, abstraction discipline, and validation risk | `openchamber-change-discipline` |
| State authority, reconciliation, optimistic state, and lifecycle correctness | `sync-state-invariants` |
| Isolated-space trust boundaries and the evidence that each one holds | `isolated-space-boundary` |
| Enterprise mode: what counts as egress or exposure, how it is gated, and administrator knobs | `enterprise-boundary` |
| Measurement, hot-path cost, caching performance, and optimization evidence | `performance-engineering` |
| Shared UI API and runtime boundaries | `ui-api-decoupling` |
| WebSocket/SSE and private relay mechanics | `relay-transport` |
| Electron native ownership and privilege boundary | `desktop-shell` |
| UI tokens, primitives, icons, and animation styling | `theme-system` |
| Visual language and interaction patterns: depth, surfaces, stability, sizing, composition, density | `openchamber-ui-guidance` |
| Layout direction: logical sides, physical exceptions, and direction-aware geometry | `rtl-layout` |
| Settings composition and search behavior | `settings-ui-patterns` |
| How human-facing text and replies read | `communication-style` |
| UI strings and localization | `locale-ui-patterns` |
| Agent-facing document structure and context pointers | `writing-for-agents` |

Before adding guidance to a skill, find its owner in the table; for a rule another skill owns, add a pointer to that skill plus the local consequence.

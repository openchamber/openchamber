# Auditing an agent document

The checks below come from `SKILL.md`; each names the section that explains it. An audit reads the whole document, plus every file it points at, and is done when every check below has been applied to every passage, and each finding is written down in the form at the end.

## Pointer (*Context pointers*)

- The description says what the document covers and when it applies, key use case first, without "I" or "you" ("Use when…" passes).
- Each trigger names work the agent is about to do, never the symptom of one fixed bug.
- No two triggers rename the same branch.
- Nothing in the description repeats what only the body needs.

## Load (*The two loads*)

- Always-loaded text (an `AGENTS.md` line, a description) holds only what most sessions need. A rule only some work needs moves behind a pointer.
- A rule loaded with every change earns that place on most changes.

## Structure (*Information hierarchy*, *File mechanics*)

- Steps come first and read in order; reference that only some branches reach is disclosed.
- One concept's definition, rules and caveats sit under one heading.
- `SKILL.md` stays under 500 lines; disclosed files link from it directly and say when to read them; a disclosed file over about 100 lines opens with its sections.
- A repeated deterministic operation is a script, marked run or read.
- Every step ends on a criterion that tells done from not done.

## Freedom (*Degrees of freedom*)

- Fragile sequences give the exact command; open work gives goal, criteria and traps.
- A strict output shape is shown as a template or an example.
- Where options are listed, one is the default.

## Wording (*Leading words*, *Reasons and emphasis*)

- One word per concept throughout.
- Each prohibition is a guardrail that cannot be said positively, and comes with the positive target. One that already stands next to its positive target ("use X, not Y" with X spelled out) passes.
- A reason is given where the agent would otherwise revert or overextend the rule, in a clause; incident stories, run numbers and dates are absent from rules.
- Capitals, MUST and NEVER appear only on a guardrail an agent was seen crossing.

## Pruning (*Pruning*)

- No sentence a capable model already follows by default.
- No restatement of something one command or one file shows (scripts, a dependency list, config, directory layout). Knowledge the code does not show stays, even when it is about the code: a library's behaviour learned the hard way, why a setting has its value, which file is the reference to copy.
- No dated or superseded behaviour presented as current.
- No paragraph that only introduces the next one or summarises the previous one.

## Ownership (*Pruning*, *Skill ownership in this repository*)

- A rule owned by another document appears here only as a pointer plus its local consequence.
- The same meaning is not stated twice within the document or across documents.

## Proof (*Proving a document works*)

- A document with steps says how their outcome is checked, observably.
- A rule you doubt is needed at all, after the checks above, is listed for a run instead of cut. Name the few rules you actually doubt; a rule backed by the failure it describes needs no run.

## Findings

One entry per finding, ordered by context saved:

- **Where**: file and line or heading.
- **Check**: the item above it fails.
- **Change**: the exact cut or rewrite, with the replacement text when there is one.
- **Saves**: about how many words, and from always-loaded or loaded-on-use text.
- **Risk**: what behaviour could change, and whether a run should confirm it before the change lands. "None" only for pure duplication or exposition.

Report a document that passes every check as clean in one line.

import { DEFAULT_LANGUAGE, languageName } from './languages.js';
import { MAX_CHAPTERS, MAX_CHAPTER_TITLE_CHARS, MAX_HUNKS_PER_STOP, MAX_OBSERVATIONS, MAX_STOPS, OBSERVATION_KINDS } from './schema.js';

// The walkthrough explains and orders; finding bugs is the Review action's job.
// An earlier prompt asked each stop for "what a reviewer should check", and
// models answered every stop with the invariant it had just described, rephrased
// as "check that…": it read like a review and checked nothing. Observations
// replace that with a few factual kinds the reader is agreeing to, and the user
// need comes from the code alone, because a description can be stale or wrong.
const SYSTEM = `You are writing a walkthrough of a code change for the engineer who is about to read it. They did not write it: it came from a colleague, a contributor, or a coding agent, and they need to understand what it does and what they take on by accepting it.

A walkthrough does three things.

1. Reading order. A diff is ordered by file path, which is almost never the order in which a change makes sense. Group related hunks, across files, into stops, and order the stops so each one is understandable given the ones before it: data shape and entry points before the code that consumes them. A test belongs in the stop of the code whose behavior it proves, unless the tests are the change.

2. Explanation. Each stop says, in two to four plain sentences, what the code now does differently, in terms of behavior, and why these hunks belong together. Do not restate the diff ("Renamed X to Y", "Added a parameter", "Updated the imports"); the reader can already see it. Prose explains and never tells the reader what to do: no "check that", "verify", "make sure", "consider", "review carefully".

3. Observations, rarely. An observation is a fact about the change that the reader is agreeing to and that the explanation alone would let them miss. It has exactly one of these kinds:
- "decision": a product or architecture call made here that could reasonably have gone another way, such as a platform left unsupported, a behavior changed for everyone, a new setting, or a new place data is kept.
- "cost": something the project carries from now on, such as code in another language or runtime, a new dependency or a pinned version, a native or build step, or a second implementation of something that already exists.
- "limitation": something users still cannot do, or will see fail, after this change, as the code or its docs state or as follows directly from the code.
- "asymmetry": two implementations or paths of the same thing that behave differently for the user, such as two platforms, two runtimes, or an old and a new path. Different libraries or APIs behind the same behavior are not an asymmetry.
- "unproven": the change's main promise has no test or check exercising it.
An observation is one or two sentences naming the concrete consequence for a user or for the people maintaining the code, and it rests on what the stop's own hunks show. It is never a guess at a bug, never style, naming, or placement, never advice, and never an instruction to the reader. Most stops have none. When in doubt, leave it out.

The focus line says what changes for the people using the software: what they can now do, or no longer run into, compared with before. Work it out from the code itself: user-facing strings, docs and README changes, tests and their names, error handling, and what the new code connects to. When the change has no user-facing effect, such as a refactor or internal tooling, say what it changes for the people working on the code. The focus line does not list risks.

Rules:
- Anchor every stop to hunk aliases from the digest, exactly as given (h1, h2, …). Never invent an alias.
- Anchor each hunk at most once, in the stop where it matters most.
- You do not have to cover every hunk. Mechanical changes are better left out than padded into a stop; whatever you omit is still shown to the reader separately, file by file.
- routine: for every file with hunks you left out of the stops, one entry {path, note}, path exactly as in the digest. The note is one short line on what changed there, so the reader can trust it without opening it: "Translations for the two new strings", "Snapshot updated for the renamed field", "Same rename as in the Android plugin". A file every hunk of which belongs to a stop gets no entry.
- importance: "critical" only for the stop or two that the rest of the change depends on or where its main behavior lives, "context" for supporting changes that are safe to skim (docs, wiring, translations, fixtures), "normal" otherwise.
- Stop titles name the thing the stop is about, not the act of reviewing it. "Hardware keyboard bridge" and "Overflow menu removed" tell a reader scanning the contents what they will find; "Exercise the boundaries" and "Describe the contract" do not.
- Write prose and observations as plain sentences. No markdown, no bullet lists, no code fences.

Respond with a single JSON object and nothing else. (Some providers refuse a structured-output request unless the word "json" appears in the request, which is why this is stated explicitly.)`;

// A reader who cannot follow English prose gets nothing out of a walkthrough,
// so the output language is the reader's, not the codebase's.
//
// Only prose is translated. Hunk aliases are keys the server resolves back to
// hunk ids, and `icon`/`importance` are enums the normalizer validates against
// fixed English values — translating either produces a walkthrough that drops
// its anchors or loses its styling, silently and completely. Identifiers taken
// from the diff stay verbatim for the same reason a translated function name
// would be unsearchable.
const languageInstruction = (language) => `

Write all prose in ${languageName(language)}: the walkthrough title, the focus line, chapter titles and blurbs, stop titles and prose, observation notes, and routine notes. The reader of this review reads ${languageName(language)}.

Keep these in English exactly as given, regardless of the prose language: hunk aliases (h1, h2, …), the "icon" values, the "importance" values, and the observation "kind" values. Keep identifiers, file paths, and API names as they appear in the code — never translate them.`;

const sizing = ({ fileCount, hunkCount }) => {
  const targetStops = Math.max(1, Math.min(MAX_STOPS, Math.round(hunkCount / 2.5) || 1));
  const targetChapters = hunkCount <= 4
    ? 1
    : Math.max(1, Math.min(MAX_CHAPTERS, Math.ceil(targetStops / 3)));
  const maxCritical = targetStops <= 3 ? 1 : targetStops <= 9 ? 2 : 3;
  const maxObservations = Math.max(1, Math.min(MAX_OBSERVATIONS, Math.ceil(targetStops / 3)));

  return `This change has ${fileCount} file(s) and ${hunkCount} reviewable hunk(s).

Aim for about ${targetStops} stop(s) across about ${targetChapters} chapter(s); never exceed ${MAX_STOPS} stops, ${MAX_CHAPTERS} chapters, or ${MAX_HUNKS_PER_STOP} hunks in one stop. Fewer, denser stops beat many thin ones.

Mark at most ${maxCritical} stop(s) "critical". Write at most ${maxObservations} observation(s) in the whole walkthrough, and none is a fine answer.

Chapter titles render in a narrow column: at most ${MAX_CHAPTER_TITLE_CHARS} characters, one or two words.`;
};

const previousWalkthroughSection = (previous) => {
  if (!previous || !Array.isArray(previous.chapters) || previous.chapters.length === 0) return '';

  const outline = previous.chapters
    .map((chapter) => {
      const stops = (chapter.stops || [])
        .map((stop) => `  - ${stop.title}: ${stop.prose}`)
        .join('\n');
      return `- ${chapter.title}${chapter.blurb ? ` — ${chapter.blurb}` : ''}\n${stops}`;
    })
    .join('\n');

  return `
A previous walkthrough of an earlier state of this change is below. The code has moved on since it was written, so its anchors are gone — deliberately, so you re-anchor everything against the current digest.

Keep the stops that are still accurate and phrased well, revise the ones whose code changed, drop the ones whose code no longer exists, and add stops for work that is new. Do not preserve its structure out of loyalty; preserve it only where it still fits.

Previous walkthrough — "${previous.title}":
${outline}
`;
};

// Used only when a provider rejects a schema request: the shape has to travel
// in the prompt instead of the request body.
export const JSON_SHAPE_INSTRUCTION = `
Return ONLY a JSON object, with no prose around it and no markdown fences, in exactly this shape:
{"title": string, "focus": string, "chapters": [{"title": string, "icon": "bug"|"wrench"|"path"|"flask"|"doc"|"gear", "blurb": string, "stops": [{"title": string, "hunks": [string], "importance": "critical"|"normal"|"context", "prose": string, "observations": [{"kind": ${OBSERVATION_KINDS.map((kind) => `"${kind}"`).join('|')}, "note": string}]}]}], "routine": [{"path": string, "note": string}]}`;

// Long enough for a page of preferences, short enough that a pasted document
// cannot crowd out the diff.
const MAX_INSTRUCTIONS_CHARS = 4_000;

const instructionsSection = (instructions) => {
  const trimmed = instructions.trim().slice(0, MAX_INSTRUCTIONS_CHARS);
  if (!trimmed) return '';
  return `

The reader's preferences for walkthroughs follow. Use them for tone, emphasis, ordering, and what to dwell on or leave out. They do not change the JSON format, the anchoring rules, or the rule that observations state facts and never judge the code.
<preferences>
${trimmed}
</preferences>`;
};

export function buildPrompt({ digest, fileCount, hunkCount, source, previousWalkthrough, language = DEFAULT_LANGUAGE, instructions = '' }) {
  const sourceLine = source.kind === 'working-tree'
    ? `Uncommitted local changes (${source.scope === 'all' ? 'staged and unstaged' : source.scope}).`
    : source.kind === 'branch'
      ? `All work on branch "${source.headRef}" that is not in "${source.baseRef}". Changes merged in from ${source.baseRef} are already excluded.`
      : source.kind === 'commit'
        ? `Only the changes introduced by commit ${source.hash}, relative to its first parent (or the empty tree for a root commit).`
        : `Pull request #${source.number}.`;

  const prompt = `The change: ${sourceLine}

${sizing({ fileCount, hunkCount })}
${previousWalkthroughSection(previousWalkthrough)}
Change digest:
${JSON.stringify(digest)}`;

  // The default language adds nothing: the system prompt is already English, so
  // saying so would only spend context restating it.
  const system = `${language === DEFAULT_LANGUAGE ? SYSTEM : `${SYSTEM}${languageInstruction(language)}`}${instructionsSection(instructions)}`;

  return { system, prompt };
}

import { DEFAULT_LANGUAGE, languageName } from './languages.js';
import { MAX_CHAPTERS, MAX_CHAPTER_TITLE_CHARS, MAX_HUNKS_PER_STOP, MAX_STOPS } from './schema.js';

const SYSTEM = `You are writing a guided review of a code change for the engineer who is about to read it.

Your job is to impose a reading order the diff itself does not have. A diff is ordered by file path, which is almost never the order in which the change makes sense. Group related hunks — across files — into stops, and order the stops so that each one is understandable given the ones before it.

What a good stop says:
- what this code now does differently, in terms of behavior, not syntax
- why the surrounding hunks belong together
- what a reviewer should check or be suspicious about, when there is something

What a bad stop says:
- "Renamed X to Y", "Added a parameter", "Updated the imports" — restating the diff in prose is worthless; the reader can already see it
- speculation about intent you cannot support from the code

Rules:
- Anchor every stop to hunk aliases from the digest, exactly as given (h1, h2, …). Never invent an alias.
- Anchor each hunk at most once, in the stop where it matters most.
- You do not have to cover every hunk. Mechanical changes are better left out than padded into a stop; whatever you omit is still shown to the reader separately.
- Order stops so the reader builds understanding: entry points and data shape before the code that consumes them.
- importance: "critical" for changes that carry real risk or drive the rest, "context" for supporting changes, "normal" otherwise.
- Stop titles name the thing the stop is about, not the act of reviewing it. "Hardware keyboard bridge" and "Overflow menu removed" tell a reader scanning the contents what they will find; "Exercise the boundaries" and "Describe the contract" do not.
- Write prose as plain sentences. No markdown, no bullet lists, no code fences.

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

Write all prose in ${languageName(language)}: the walkthrough title, the focus line, chapter titles and blurbs, and stop titles and prose. The reader of this review reads ${languageName(language)}.

Keep these in English exactly as given, regardless of the prose language: hunk aliases (h1, h2, …), the "icon" values, and the "importance" values. Keep identifiers, file paths, and API names as they appear in the code — never translate them.`;

const sizing = ({ fileCount, hunkCount }) => {
  const targetStops = Math.max(1, Math.min(MAX_STOPS, Math.round(hunkCount / 2.5) || 1));
  const targetChapters = hunkCount <= 4
    ? 1
    : Math.max(1, Math.min(MAX_CHAPTERS, Math.ceil(targetStops / 3)));

  return `This change has ${fileCount} file(s) and ${hunkCount} reviewable hunk(s).

Aim for about ${targetStops} stop(s) across about ${targetChapters} chapter(s); never exceed ${MAX_STOPS} stops, ${MAX_CHAPTERS} chapters, or ${MAX_HUNKS_PER_STOP} hunks in one stop. Fewer, denser stops beat many thin ones.

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
{"title": string, "focus": string, "chapters": [{"title": string, "icon": "bug"|"wrench"|"path"|"flask"|"doc"|"gear", "blurb": string, "stops": [{"title": string, "hunks": [string], "importance": "critical"|"normal"|"context", "prose": string}]}]}`;

export function buildPrompt({ digest, fileCount, hunkCount, source, previousWalkthrough, language = DEFAULT_LANGUAGE }) {
  const sourceLine = source.kind === 'working-tree'
    ? `Uncommitted local changes (${source.scope === 'all' ? 'staged and unstaged' : source.scope}).`
    : source.kind === 'branch'
      ? `All work on branch "${source.headRef}" that is not in "${source.baseRef}". Changes merged in from ${source.baseRef} are already excluded.`
      : `Pull request #${source.number}.`;

  const prompt = `Reviewing: ${sourceLine}

${sizing({ fileCount, hunkCount })}
${previousWalkthroughSection(previousWalkthrough)}
Change digest:
${JSON.stringify(digest)}`;

  // The default language adds nothing: the system prompt is already English, so
  // saying so would only spend context restating it.
  const system = language === DEFAULT_LANGUAGE ? SYSTEM : `${SYSTEM}${languageInstruction(language)}`;

  return { system, prompt };
}
